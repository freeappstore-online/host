export interface Env {
  DB: D1Database;
  APPS: R2Bucket;
  /** Service binding to the backend Worker (freeappstore-api), which serves
   *  api.freeappstore.online. The wildcard route preempts that Worker's
   *  custom_domain binding, so we dispatch reserved subdomains via this
   *  binding rather than letting the request fall through. */
  API?: Fetcher;
  /** Service binding to the KB host Worker (freeappstore-kb-host), which serves
   *  docs.freeappstore.online and kb.freeappstore.online. Same wildcard
   *  preemption issue as the API binding above. */
  KB?: Fetcher;
}

export interface Route {
  slug: string;
  zone: string;
  r2_prefix: string;
  store: string;
}

/**
 * Map a Host header like "kanban.freeappstore.online" to its R2 prefix.
 * Returns null if no row matches; caller serves 404.
 *
 * Lookup is keyed by (slug, zone) so the same slug can exist on multiple
 * store zones without collision. We trust the Host header only for lookup
 * — no privilege is attached to the resolved slug, so spoofing it just
 * picks which 404 you see.
 */
export async function resolveRoute(db: D1Database, host: string): Promise<Route | null> {
  const cleaned = host.toLowerCase().split(":")[0];
  const dot = cleaned.indexOf(".");
  if (dot < 1) return null;
  const slug = cleaned.slice(0, dot);
  const zone = cleaned.slice(dot + 1);
  if (!slug || !zone) return null;

  const row = await db
    .prepare("SELECT slug, zone, r2_prefix, store FROM routes WHERE slug = ?1 AND zone = ?2")
    .bind(slug, zone)
    .first<Route>();
  return row ?? null;
}

/**
 * Compute the R2 key for a given route + URL pathname. Directory paths and
 * `/` default to `index.html`; the leading slash is stripped because R2
 * keys are flat strings, not paths.
 */
export function r2KeyFor(route: Route, pathname: string): string {
  let p = pathname;
  if (p === "" || p === "/" || p.endsWith("/")) p += "index.html";
  return `${route.r2_prefix}/${p.replace(/^\/+/, "")}`;
}

/**
 * Compare a client's `If-None-Match` request header against an R2 object's
 * httpEtag. Returns true iff the browser already has a fresh copy and we
 * should respond 304 Not Modified.
 *
 * `If-None-Match: *` matches any existing resource. Otherwise the header
 * is a comma-separated list of etags (each quoted); we match by exact
 * string. R2 only emits strong etags, so we don't need W/ prefix handling.
 */
export function etagsMatch(headerValue: string | null, objectEtag: string): boolean {
  if (!headerValue) return false;
  const trimmed = headerValue.trim();
  if (trimmed === "*") return true;
  return trimmed.split(",").some((t) => t.trim() === objectEtag);
}

/**
 * Build the security headers we attach to every R2-served response. Split
 * out from the index.ts respond() helper so the policy is unit-testable
 * without spinning up the full Worker, and so the next person to tighten
 * CSP can edit one place. Pass-through args:
 *   - htmlCache:  true for HTML (short-lived caching), false otherwise.
 *
 * Analytics origins are listed explicitly in script-src + connect-src so
 * a future tightening (removing the broad `https:` and replacing with
 * an allowlist) doesn't silently break the platform analytics loader,
 * CF Web Analytics, or BYO GA4 / Plausible tags.
 */
export function securityHeaders(opts: { htmlCache: boolean }): Headers {
  const headers = new Headers();
  if (opts.htmlCache) {
    headers.set("cache-control", "public, max-age=60, must-revalidate");
  } else {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  }
  const csp = [
    "default-src 'self' https: data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: https://api.freeappstore.online https://static.cloudflareinsights.com https://www.googletagmanager.com https://plausible.io",
    "style-src 'self' 'unsafe-inline' https:",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    "connect-src 'self' https: wss: https://api.freeappstore.online https://cloudflareinsights.com https://www.google-analytics.com https://plausible.io",
    "frame-src 'self' https:",
    "frame-ancestors 'self' https://freeappstore.online https://*.freeappstore.online",
    "base-uri 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
  headers.set("content-security-policy", csp);
  headers.set(
    "permissions-policy",
    "geolocation=(self), microphone=(), camera=(self), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), midi=(), interest-cohort=()",
  );
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  return headers;
}

/**
 * Best-effort MIME guess from file extension. Defaults to octet-stream so
 * the browser doesn't sniff and execute something it shouldn't (combined
 * with X-Content-Type-Options: nosniff downstream).
 */
export function contentType(path: string): string {
  const ext = path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  switch (ext) {
    case "html":
      return "text/html; charset=utf-8";
    case "js":
    case "mjs":
      return "application/javascript; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "ico":
      return "image/x-icon";
    case "woff":
      return "font/woff";
    case "woff2":
      return "font/woff2";
    case "wasm":
      return "application/wasm";
    case "txt":
      return "text/plain; charset=utf-8";
    case "xml":
      return "application/xml; charset=utf-8";
    case "webmanifest":
      return "application/manifest+json";
    case "map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
