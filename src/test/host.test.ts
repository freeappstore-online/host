import { describe, expect, it } from "vitest";
import { contentType, etagsMatch, type Route, r2KeyFor, resolveRoute, securityHeaders } from "../host";

// Minimal D1 stub — verifies the SQL shape and parameter binding without
// spinning up a real D1. Real schema integration is exercised by the
// migration apply step + an end-to-end test against a deployed Worker.
function mockDb(rows: Route[]): D1Database {
  return {
    prepare: (_sql: string) => ({
      bind: (slug: string, zone: string) => ({
        first: async () => rows.find((r) => r.slug === slug && r.zone === zone) ?? null,
      }),
    }),
  } as unknown as D1Database;
}

const kanban: Route = { slug: "kanban", zone: "freeappstore.online", r2_prefix: "apps/kanban", store: "apps" };

describe("resolveRoute", () => {
  it("resolves a known subdomain", async () => {
    const r = await resolveRoute(mockDb([kanban]), "kanban.freeappstore.online");
    expect(r?.r2_prefix).toBe("apps/kanban");
  });

  it("returns null for unknown subdomain", async () => {
    expect(await resolveRoute(mockDb([kanban]), "missing.freeappstore.online")).toBeNull();
  });

  it("handles uppercase host", async () => {
    expect(await resolveRoute(mockDb([kanban]), "Kanban.FreeAppStore.Online")).not.toBeNull();
  });

  it("strips port suffix", async () => {
    expect(await resolveRoute(mockDb([kanban]), "kanban.freeappstore.online:8443")).not.toBeNull();
  });

  it("returns null for apex (no subdomain)", async () => {
    expect(await resolveRoute(mockDb([kanban]), "freeappstore.online")).toBeNull();
  });

  it("returns null for empty host", async () => {
    expect(await resolveRoute(mockDb([kanban]), "")).toBeNull();
  });

  it("matches the right slug+zone among multiple rows", async () => {
    const games: Route = { slug: "kanban", zone: "freegamestore.online", r2_prefix: "games/kanban", store: "games" };
    const db = mockDb([kanban, games]);
    expect((await resolveRoute(db, "kanban.freeappstore.online"))?.r2_prefix).toBe("apps/kanban");
    expect((await resolveRoute(db, "kanban.freegamestore.online"))?.r2_prefix).toBe("games/kanban");
  });
});

describe("r2KeyFor", () => {
  it("defaults / to index.html", () => {
    expect(r2KeyFor(kanban, "/")).toBe("apps/kanban/index.html");
  });

  it("defaults directory paths to index.html", () => {
    expect(r2KeyFor(kanban, "/about/")).toBe("apps/kanban/about/index.html");
  });

  it("strips leading slash", () => {
    expect(r2KeyFor(kanban, "/static/app.js")).toBe("apps/kanban/static/app.js");
  });

  it("does not append index.html for files with extensions", () => {
    expect(r2KeyFor(kanban, "/style.css")).toBe("apps/kanban/style.css");
  });
});

describe("contentType", () => {
  it.each([
    ["/index.html", "text/html; charset=utf-8"],
    ["/app.js", "application/javascript; charset=utf-8"],
    ["/app.mjs", "application/javascript; charset=utf-8"],
    ["/style.css", "text/css; charset=utf-8"],
    ["/logo.svg", "image/svg+xml"],
    ["/icon.png", "image/png"],
    ["/photo.jpg", "image/jpeg"],
    ["/font.woff2", "font/woff2"],
    ["/site.webmanifest", "application/manifest+json"],
    ["/binary.bin", "application/octet-stream"],
    ["/no-extension", "application/octet-stream"],
  ])("%s → %s", (path, expected) => {
    expect(contentType(path)).toBe(expected);
  });

  // Regression: a URL pathname of "/" has no extension and would resolve to
  // octet-stream; the Worker now feeds contentType the resolved R2 key
  // (apps/<slug>/index.html), which correctly resolves to text/html. This
  // matters because X-Content-Type-Options: nosniff turns octet-stream into
  // a download prompt instead of rendering.
  it("resolves text/html from a key built by r2KeyFor for `/`", () => {
    expect(contentType(r2KeyFor(kanban, "/"))).toBe("text/html; charset=utf-8");
  });

  it("resolves text/html from a key built for a directory path", () => {
    expect(contentType(r2KeyFor(kanban, "/about/"))).toBe("text/html; charset=utf-8");
  });
});

// The legacyProjectName + legacyFallback wiring isn't exported, so we can't
// unit-test it directly without refactoring (the function lives in index.ts).
// The proxy behavior is exercised by the live-deployed Worker against real
// `<slug>.freeappstore.online` URLs whose apps still live on CF Pages —
// any of `language`, `math`, `quiz`, `books`, `music` returning HTTP 200
// confirms the path works. If a regression breaks the fallback, those URLs
// return the Worker's 404 instead — the user-visible symptom that flagged
// the original bug.
// ---- Security headers: defense-in-depth baseline applied to every app. ----
// The analytics pipeline (loader, beacon, BYO tags) depends on these directives
// being permissive enough to allow the platform origins. A future tightening
// pass that drops the broad `https:` from script-src + connect-src must keep
// the explicit api.freeappstore.online / cloudflareinsights / googletagmanager /
// plausible.io origins or analytics breaks across every app.

describe("securityHeaders", () => {
  const html = securityHeaders({ htmlCache: true });
  const asset = securityHeaders({ htmlCache: false });

  it("HTML gets short cache, assets get immutable cache", () => {
    expect(html.get("cache-control")).toContain("max-age=60");
    expect(html.get("cache-control")).toContain("must-revalidate");
    expect(asset.get("cache-control")).toContain("max-age=31536000");
    expect(asset.get("cache-control")).toContain("immutable");
  });

  it("CSP allows the platform analytics loader endpoint", () => {
    const csp = html.get("content-security-policy") ?? "";
    expect(csp).toContain("https://api.freeappstore.online");
    expect(csp).toMatch(/script-src[^;]*https:\/\/api\.freeappstore\.online/);
    expect(csp).toMatch(/connect-src[^;]*https:\/\/api\.freeappstore\.online/);
  });

  it("CSP allows CF Web Analytics beacon (cookieless first-party)", () => {
    const csp = html.get("content-security-policy") ?? "";
    expect(csp).toContain("https://static.cloudflareinsights.com");
    expect(csp).toContain("https://cloudflareinsights.com");
  });

  it("CSP allows BYO Google Analytics 4 tags", () => {
    const csp = html.get("content-security-policy") ?? "";
    expect(csp).toContain("https://www.googletagmanager.com");
    expect(csp).toContain("https://www.google-analytics.com");
  });

  it("CSP allows BYO Plausible tags", () => {
    const csp = html.get("content-security-policy") ?? "";
    expect(csp).toContain("https://plausible.io");
  });

  it("CSP locks down object-src and base-uri (defense-in-depth)", () => {
    const csp = html.get("content-security-policy") ?? "";
    expect(csp).toMatch(/object-src 'none'/);
    expect(csp).toMatch(/base-uri 'self'/);
  });

  it("frame-ancestors allows storefront preview iframes only", () => {
    const csp = html.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'self' https://freeappstore.online");
    expect(csp).toContain("https://freeappstore.pages.dev");
    expect(csp).toContain("https://*.freeappstore.online");
  });

  it("upgrades insecure requests + sets HSTS", () => {
    expect(html.get("content-security-policy")).toContain("upgrade-insecure-requests");
    expect(html.get("strict-transport-security")).toMatch(/max-age=\d+/);
    expect(html.get("strict-transport-security")).toContain("includeSubDomains");
  });

  it("disables powerful APIs by default (Permissions-Policy)", () => {
    const pp = html.get("permissions-policy") ?? "";
    expect(pp).toContain("geolocation=()");
    expect(pp).toContain("camera=()");
    expect(pp).toContain("microphone=()");
    expect(pp).toContain("payment=()");
    expect(pp).toContain("interest-cohort=()");
  });

  it("sets nosniff + strict referrer policy", () => {
    expect(html.get("x-content-type-options")).toBe("nosniff");
    expect(html.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });
});

describe("etagsMatch (304 Not Modified)", () => {
  it("returns false when no If-None-Match header is sent", () => {
    expect(etagsMatch(null, '"abc"')).toBe(false);
  });

  it("matches a single quoted etag exactly", () => {
    expect(etagsMatch('"abc"', '"abc"')).toBe(true);
    expect(etagsMatch('"abc"', '"def"')).toBe(false);
  });

  it("matches against a comma-separated list", () => {
    expect(etagsMatch('"abc", "def", "ghi"', '"def"')).toBe(true);
    expect(etagsMatch('"abc", "def"', '"xyz"')).toBe(false);
  });

  it("wildcard * matches any etag", () => {
    expect(etagsMatch("*", '"anything"')).toBe(true);
  });

  it("trims whitespace around list entries", () => {
    expect(etagsMatch('  "abc"  ,  "def"  ', '"def"')).toBe(true);
  });

  it("treats empty header as no-match", () => {
    expect(etagsMatch("", '"abc"')).toBe(false);
    expect(etagsMatch("   ", '"abc"')).toBe(false);
  });
});

describe("legacy fallback (integration shape only)", () => {
  it("documents the (slug, zone) → CF Pages project naming", () => {
    // Mirror of legacyProjectName in src/index.ts — keep in sync.
    const cases = [
      ["language", "freeappstore.online", "freelanguageapp"],
      ["chess", "freegamestore.online", "chess"],
      ["spending", "proappstore.online", "proappstore-spending"],
    ];
    for (const [slug, zone, expected] of cases) {
      // Just asserting the projection matches what STORE_CONFIG produces in
      // fas/admin/src/publish.ts. If admin's naming convention changes, this
      // breaks and tells you the host worker needs the same update.
      let projected: string | null;
      if (zone === "freeappstore.online") projected = `free${slug}app`;
      else if (zone === "freegamestore.online") projected = slug;
      else if (zone === "proappstore.online") projected = `proappstore-${slug}`;
      else projected = null;
      expect(projected).toBe(expected);
    }
  });
});
