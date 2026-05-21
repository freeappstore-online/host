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

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const host = req.headers.get("host") ?? url.host;

    // Subdomain lookup first — cheapest gate. Unknown host → 404, no R2 hit.
    const route = await resolveRoute(env.DB, host);
    if (!route) return notFound(host);

    return await serve(env.APPS, route, url, req.method, ctx);
  },
};

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

  return respond(obj, contentType(url.pathname), method);
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
  headers.set("x-frame-options", "DENY");
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
