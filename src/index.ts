/**
 * freeappstore-host — serves every published app from R2.
 *
 * One Worker on *.freeappstore.online replaces the per-app CF Pages
 * project model that capped the marketplace at 100 apps per CF account.
 * Subdomain → slug → R2 prefix lookup happens in D1; assets stream from
 * the fas-apps bucket. Security headers are emitted from this Worker
 * (single source of truth), so individual apps don't need their own
 * `_headers` file.
 */

import { contentType, type Env, type Route, r2KeyFor, resolveRoute } from "./host";

/**
 * Platform-infra subdomains: NOT apps. The wildcard route catches them just
 * like apps, but their fallback targets don't follow the `free<slug>app`
 * naming convention. Each one is dispatched explicitly:
 *
 *  - `service` → Worker-to-Worker via service binding (zero public hop)
 *  - `proxy`   → fetch() to a specific *.pages.dev URL (for CF Pages-hosted infra)
 *  - `unmapped`→ return a clean 502 with "this needs ops attention" instead of
 *                a misleading DNS error for guessed-wrong project names
 *
 * If you add a new platform subdomain, add a row here AND add the matching
 * [[services]] entry in wrangler.toml when type=service.
 *
 * `admin.freeappstore.online/*` is NOT in this map — that Worker has a more
 * specific route pattern (exact host + path glob), which beats `*.<zone>/*`
 * in CF's matching, so traffic skips this Worker entirely.
 */
type PlatformDispatch =
  | { type: "service"; binding: keyof Env }
  | { type: "proxy"; target: string }
  | { type: "redirect"; to: string; status?: 301 | 302 }
  | { type: "gone"; message: string };

const PLATFORM_SUBDOMAINS: Record<string, PlatformDispatch> = {
  api: { type: "service", binding: "API" },
  compliance: { type: "proxy", target: "https://compliance.pages.dev" },
  publisher: { type: "proxy", target: "https://publisher.pages.dev" },
  submissions: { type: "proxy", target: "https://submissions.pages.dev" },
  agent: { type: "proxy", target: "https://agent.pages.dev" },
  create: { type: "proxy", target: "https://freeappstore-create.pages.dev" },
  // www → 301 to the apex. Standard convention; matches what the host repo
  // would do via a redirect rule if CF Pages owned the apex still.
  www: { type: "redirect", to: "https://freeappstore.online", status: 301 },
  // `auth.freeappstore.online` is NOT a real web subdomain — the OAuth
  // callback lives at api.freeappstore.online/v1/auth/*, and `auth@...` is
  // only used as an email FROM address (RESEND_API_KEY, see
  // platform/packages/backend/src/lib/email.ts). Returning 404 (not 502)
  // because nothing is misconfigured — there is just no web target.
  auth: { type: "gone", message: "auth.freeappstore.online is not a web service. Auth flows live at api.freeappstore.online/v1/auth/*; the `auth@` mailbox is for email only." },
};

/**
 * Apps whose CF Pages project name doesn't follow the `free<slug>app`
 * convention. Audit of `wrangler pages project list` on 2026-05-21 turned
 * up just one: `chessclock` is hosted at `freechessclock.pages.dev` (no
 * `app` suffix). Add here if you spot more during the batch migration.
 *
 * Long-term: once every app has a D1 routes row with a `cf_project` field,
 * this table goes away.
 */
const APP_PROJECT_OVERRIDES: Record<string, string> = {
  chessclock: "freechessclock",
};

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const host = req.headers.get("host") ?? url.host;

    // Slug parsing — needed for both reserved dispatch and route lookup.
    const cleaned = host.toLowerCase().split(":")[0];
    const dot = cleaned.indexOf(".");
    const slug = dot > 0 ? cleaned.slice(0, dot) : "";

    // Platform-infra subdomains short-circuit before app routing. They use
    // different naming than apps, so the legacy app-fallback would send them
    // to a non-existent CF Pages project (real bug we hit on 2026-05-21).
    if (slug in PLATFORM_SUBDOMAINS) {
      return await dispatchPlatform(req, env, slug, host);
    }

    // Path B route — if the slug is registered in D1, serve from R2.
    const route = await resolveRoute(env.DB, host);
    if (route) return await serve(env.APPS, route, url, req.method, ctx);

    // Otherwise fall back to the legacy CF Pages project for this slug. This
    // is how the migration stays non-breaking: an app stays on CF Pages
    // until it's been built, uploaded to R2, and given a D1 row. The user-
    // facing URL never changes — just the backend behind it.
    return await legacyFallback(req, host);
  },
};

/**
 * Dispatch a request whose hostname matches a known platform-infra subdomain
 * (api, compliance, publisher, etc.). The mapping decides whether to use a
 * service binding (zero public hop), a fetch-proxy to an explicit URL, or
 * fail loudly because the subdomain is intentionally unmapped.
 */
async function dispatchPlatform(req: Request, env: Env, slug: string, host: string): Promise<Response> {
  const mapping = PLATFORM_SUBDOMAINS[slug];
  const url = new URL(req.url);

  if (mapping.type === "service") {
    const target = env[mapping.binding] as Fetcher | undefined;
    if (!target) {
      return new Response(`Reserved subdomain ${host} has no service binding configured.\n`, {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return await target.fetch(req);
  }
  if (mapping.type === "proxy") {
    const headers = new Headers(req.headers);
    headers.delete("host");
    return await fetch(`${mapping.target}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: req.body,
    });
  }
  if (mapping.type === "redirect") {
    return Response.redirect(`${mapping.to}${url.pathname}${url.search}`, mapping.status ?? 301);
  }
  // type === "gone" — there's intentionally no web target. Clean 404 with
  // explanation, not a 502 (nothing is misconfigured).
  return new Response(`${mapping.message}\n`, {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * Proxy to `<cf-project>.pages.dev` for slugs that haven't been migrated to
 * Path B yet. Mirrors the legacy STORE_CONFIG.cfProjectName naming so the
 * right project is hit per zone. Returns 404 if the host doesn't look like
 * a valid `<slug>.<zone>` pair we know how to route.
 */
async function legacyFallback(req: Request, host: string): Promise<Response> {
  const cleaned = host.toLowerCase().split(":")[0];
  const dot = cleaned.indexOf(".");
  if (dot < 1) return notFound(host);

  const slug = cleaned.slice(0, dot);
  const zone = cleaned.slice(dot + 1);
  const cfProject = legacyProjectName(slug, zone);
  if (!cfProject) return notFound(host);

  const url = new URL(req.url);
  const target = `https://${cfProject}.pages.dev${url.pathname}${url.search}`;
  // Drop the inbound Host header so the proxied fetch uses the target's
  // host (CF Pages routes on its own *.pages.dev hostname). Keep everything
  // else so request semantics are preserved.
  const headers = new Headers(req.headers);
  headers.delete("host");
  return await fetch(target, { method: req.method, headers, body: req.body });
}

/**
 * Maps (slug, zone) to the legacy CF Pages project name. Mirrors
 * STORE_CONFIG.cfProjectName from fas/admin/src/publish.ts — keep in sync
 * if naming there changes. Returns null for zones we don't host (so we
 * don't accidentally proxy arbitrary subdomains).
 */
function legacyProjectName(slug: string, zone: string): string | null {
  if (zone === "freeappstore.online") {
    return APP_PROJECT_OVERRIDES[slug] ?? `free${slug}app`;
  }
  if (zone === "freegamestore.online") return slug;
  if (zone === "proappstore.online") return `proappstore-${slug}`;
  return null;
}

async function serve(bucket: R2Bucket, route: Route, url: URL, method: string, _ctx: ExecutionContext): Promise<Response> {
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }

  const key = r2KeyFor(route, url.pathname);
  let obj = await bucket.get(key);

  // SPA fallback: if the requested path has no file extension and missed,
  // serve the app's index.html so client-side routers can take over. Static
  // assets (with extensions) still 404 — we don't want to mask missing JS
  // bundles or images.
  if (!obj && !/\.[a-z0-9]+$/i.test(url.pathname)) {
    obj = await bucket.get(`${route.r2_prefix}/index.html`);
    if (obj) return respond(obj, "text/html; charset=utf-8", method);
  }

  if (!obj) return notFound(url.pathname, route.slug);

  // Resolve MIME from the KEY (the file we actually served), not the URL
  // pathname. They differ when the URL is `/` or ends with `/` — r2KeyFor
  // defaults to `index.html`, but `url.pathname` is still `/`, which has
  // no extension and would resolve to `application/octet-stream`. With
  // X-Content-Type-Options: nosniff that downloads instead of rendering.
  return respond(obj, contentType(key), method);
}

function respond(obj: R2ObjectBody, ct: string, method: string): Response {
  const headers = new Headers();
  headers.set("content-type", ct);
  headers.set("etag", obj.httpEtag);

  // HTML is short-cached so a republish is visible within ~a minute; everything
  // else is treated as content-addressed (build tools fingerprint asset paths)
  // and cached aggressively. Apps that ship un-fingerprinted assets will see
  // stale caches on republish — that's a build-tool fix, not a hosting bug.
  if (ct.startsWith("text/html")) {
    headers.set("cache-control", "public, max-age=60, must-revalidate");
  } else {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  }

  // Security baseline. Apps inherit these unconditionally; per-app overrides
  // are not supported in v1 by design (centralizing policy was a goal of the
  // migration). If an app genuinely needs different CSP, that becomes a
  // registry field later.
  //
  // No X-Frame-Options because the storefront iframes apps for preview
  // (freeappstore.online/?app=<slug> and freeappstore.pages.dev/?app=<slug>).
  // The CSP frame-ancestors directive below allows exactly those origins +
  // same-origin, and blocks every other site from framing — same protection
  // as `X-Frame-Options: DENY` minus the storefront. Modern browsers prefer
  // frame-ancestors anyway; X-Frame-Options DENY can't list allowed origins.
  headers.set(
    "content-security-policy",
    "frame-ancestors 'self' https://freeappstore.online https://freeappstore.pages.dev https://*.freeappstore.online",
  );
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");

  // HEAD requests get headers only.
  return new Response(method === "HEAD" ? null : obj.body, { headers });
}

function notFound(host: string, slug?: string): Response {
  const body = slug
    ? `Not Found: ${slug}.${host.split(".").slice(1).join(".")} has no asset at this path.\n`
    : `Not Found: no app registered at ${host}.\n`;
  return new Response(body, {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
