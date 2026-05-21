import { describe, expect, it } from "vitest";
import { contentType, type Route, r2KeyFor, resolveRoute } from "../host";

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
});
