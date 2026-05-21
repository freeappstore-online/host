export interface Env {
  DB: D1Database;
  APPS: R2Bucket;
  /** Service binding to the backend Worker (freeappstore-api), which serves
   *  api.freeappstore.online. The wildcard route preempts that Worker's
   *  custom_domain binding, so we dispatch reserved subdomains via this
   *  binding rather than letting the request fall through. */
  API?: Fetcher;
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
    .prepare("SELECT slug, zone, r2_prefix, store FROM routes WHERE slug = ?1 AND zone = ?2 AND hosted_on = 'r2'")
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
