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

import { contentType, type Env, etagsMatch, type Route, r2KeyFor, resolveRoute, securityHeaders } from "./host";

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
  // `publish.freeappstore.online/*` is served by freeappstore-publisher
  // (more-specific Worker Route — beats the wildcard that lands here).
  // It exposes /api/me, /api/create, /api/publish-existing called by
  // create.freeappstore.online/publish. If publisher is ever decommissioned,
  // those endpoints need to land on FAS platform backend first, and only
  // then can a redirect entry be added here (keyed `publish`, not
  // `publisher` — the former was a typo that meant the entry never fired).
  submissions: { type: "proxy", target: "https://submissions.pages.dev" },
  agent: { type: "proxy", target: "https://agent.pages.dev" },
  // console serves from R2 via a D1 routes row (`apps/console`). Not in
  // PLATFORM_SUBDOMAINS — falls through to resolveRoute().
  //
  // `create` has been half-migrated since 2026-05-24: it was removed from
  // PLATFORM_SUBDOMAINS but no D1 row was added and R2 prefix is empty.
  // The actual CF Pages project is named `freeappstore-create` (not the
  // formula-default `freecreateapp`), so the legacyFallback path 530s.
  // Override map keeps `create.freeappstore.online` live until either the
  // R2 prefix gets populated or a D1 row is inserted (see
  // APP_PROJECT_OVERRIDES below).
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
 * Authoritative list of FAS slugs that still serve from CF Pages (legacy).
 * Anything not in this map AND not in the D1 `routes` table returns a
 * clean 404 — the previous `free<slug>app` formula default was producing
 * misleading 530s for every typo subdomain by proxying to nonexistent
 * `.pages.dev` URLs.
 *
 * Verified live 2026-05-28 via `wrangler pages project list`. To add a
 * straggler back, include the actual CF Pages project name as the value.
 */
const APP_PROJECT_OVERRIDES: Record<string, string> = {
  chessclock: "freechessclock",
  // `create` + `spending` migrated to Path B 2026-05-28 (D1 routes row +
  // R2 upload). Overrides removed; resolveRoute() handles them like any
  // other app. Only chessclock remains on legacy CF Pages — its actual
  // project name (freechessclock, no `app` suffix) doesn't match the
  // formula and migration hasn't been done yet.
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
    if (route) return await serve(env.APPS, route, url, req.method, req.headers.get("if-none-match"), ctx);

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
 * Maps (slug, zone) to a legacy CF Pages project name we KNOW exists.
 * Returns null otherwise → caller serves clean 404 instead of proxying
 * to a phantom `.pages.dev` URL. This worker only routes the FAS zone
 * (`*.freeappstore.online/*` — see wrangler.toml); cross-zone branches
 * were removed 2026-05-28 because they were dead code that proxied to
 * nonexistent projects and produced 530s for any typo.
 */
function legacyProjectName(slug: string, zone: string): string | null {
  if (zone !== "freeappstore.online") return null;
  return APP_PROJECT_OVERRIDES[slug] ?? null;
}

async function serve(
  bucket: R2Bucket,
  route: Route,
  url: URL,
  method: string,
  ifNoneMatch: string | null,
  _ctx: ExecutionContext,
): Promise<Response> {
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }

  const key = r2KeyFor(route, url.pathname);
  let obj = await bucket.get(key);
  let servedKey = key;

  // SPA fallback: if the requested path has no file extension and missed,
  // serve the app's index.html so client-side routers can take over. Static
  // assets (with extensions) still 404 — we don't want to mask missing JS
  // bundles or images.
  if (!obj && !/\.[a-z0-9]+$/i.test(url.pathname)) {
    const fallbackKey = `${route.r2_prefix}/index.html`;
    obj = await bucket.get(fallbackKey);
    if (obj) servedKey = fallbackKey;
  }

  if (!obj) return notFound(url.pathname, route.slug);

  // Resolve MIME from the KEY (the file we actually served), not the URL
  // pathname. They differ when the URL is `/` or ends with `/` — r2KeyFor
  // defaults to `index.html`, but `url.pathname` is still `/`, which has
  // no extension and would resolve to `application/octet-stream`. With
  // X-Content-Type-Options: nosniff that downloads instead of rendering.
  const ct = servedKey === key ? contentType(key) : "text/html; charset=utf-8";

  // 304 Not Modified: skip the body transfer when the browser already has
  // a fresh copy. Saves bandwidth on every refresh of every asset. The
  // R2 object metadata fetch still happens, but the body stream isn't read.
  if (etagsMatch(ifNoneMatch, obj.httpEtag)) {
    const headers = securityHeaders({ htmlCache: ct.startsWith("text/html") });
    headers.set("etag", obj.httpEtag);
    return new Response(null, { status: 304, headers });
  }

  return respond(obj, ct, method);
}

function respond(obj: R2ObjectBody, ct: string, method: string): Response {
  // Headers are constructed in securityHeaders() so the policy lives in one
  // testable place. We just layer content-type + etag on top.
  const isHtml = ct.startsWith("text/html");
  const headers = securityHeaders({ htmlCache: isHtml });
  headers.set("content-type", ct);
  headers.set("etag", obj.httpEtag);
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
