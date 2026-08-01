import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { app, scheduled, type Bindings } from "../src/worker";

const migrationPath = fileURLToPath(new URL("../migrations/0001_rooms.sql", import.meta.url));
const appScriptPath = fileURLToPath(new URL("../public/app.js", import.meta.url));
const roomScriptPath = fileURLToPath(new URL("../public/room.js", import.meta.url));
const ogPath = fileURLToPath(new URL("../public/og.svg", import.meta.url));
const stylesPath = fileURLToPath(new URL("../public/styles.css", import.meta.url));
const wranglerPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const origin = "http://localhost";
const sessions = [
  "a2d0e2f2-66fd-4fd4-8e87-b0ef67ad194a",
  "b3d0e2f2-66fd-4fd4-8e87-b0ef67ad194b",
  "c4d0e2f2-66fd-4fd4-8e87-b0ef67ad194c",
  "d5d0e2f2-66fd-4fd4-8e87-b0ef67ad194d",
  "e6d0e2f2-66fd-4fd4-8e87-b0ef67ad194e",
  "f7d0e2f2-66fd-4fd4-8e87-b0ef67ad194f",
  "a8d0e2f2-66fd-4fd4-8e87-b0ef67ad1940",
  "b9d0e2f2-66fd-4fd4-8e87-b0ef67ad1941",
];

let miniflare: Miniflare;
let bindings: Bindings;

const headers = (session = sessions[0], key = "", qa = false) => ({
  "content-type": "application/json",
  origin,
  "x-heya-key": key,
  "x-heya-qa": qa ? "1" : "0",
  "x-heya-session": session,
});

const validRoom = (overrides: Record<string, unknown> = {}) => ({
  hostBonus: 240,
  minimumBonus: 200,
  note: "3回ほどお願いします",
  openSeats: 3,
  purpose: "event",
  roomCode: "58310",
  rounds: 3,
  rules: ["mistakes-ok", "withdraw-ok"],
  song: "イベント周回",
  website: "",
  ...overrides,
});

const keyFromUrl = (url: string) =>
  new URLSearchParams(new URL(url, origin).hash.slice(1)).get("key") ?? "";

const createRoom = async (
  overrides: Record<string, unknown> = {},
  session = sessions[0],
  qa = false,
) => {
  const response = await app.request(
    "/api/rooms",
    {
      body: JSON.stringify(validRoom(overrides)),
      headers: headers(session, "", qa),
      method: "POST",
    },
    bindings,
  );
  expect(response.status).toBe(201);
  const body = await response.json<{ id: string; manageUrl: string; publicUrl: string }>();
  return { ...body, managerKey: keyFromUrl(body.manageUrl) };
};

const postEmpty = (path: string, session = sessions[1]) =>
  app.request(path, { body: "{}", headers: headers(session), method: "POST" }, bindings);

beforeEach(async () => {
  miniflare = new Miniflare({
    d1Databases: { DB: "heya-to-test" },
    modules: true,
    script: "export default { fetch() { return new Response('test') } }",
  });
  const database = await miniflare.getD1Database("DB");
  const migration = await readFile(migrationPath, "utf8");
  for (const statement of migration
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)) {
    await database.prepare(statement).run();
  }
  bindings = {
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    DB: database as unknown as D1Database,
  };
});

afterEach(async () => miniflare.dispose());

describe("public pages", () => {
  it.each([
    ["/", 'class="room-visual"', "https://heya-to.yhay81.com/"],
    ["/guide", 'class="guide-cards"', "https://heya-to.yhay81.com/guide"],
    ["/safety", 'class="data-grid"', "https://heya-to.yhay81.com/safety"],
    ["/privacy", 'class="privacy-slots"', "https://heya-to.yhay81.com/privacy"],
  ])("%s returns a product-specific surface", async (path, marker, canonical) => {
    const response = await app.request(path, undefined, bindings);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(marker);
    expect(html).toContain(`href="${canonical}" rel="canonical"`);
    expect(html).toContain("部屋灯");
    expect(html).not.toMatch(/仮説|成功条件|市場スコア/u);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("publishes only four indexable pages and a named health response", async () => {
    const xml = await (await app.request("/sitemap.xml", undefined, bindings)).text();
    expect(xml.match(/<loc>/gu)).toHaveLength(4);
    expect(xml).not.toMatch(/\/r\/|\/m\//u);
    expect(await (await app.request("/health", undefined, bindings)).json()).toEqual({
      ok: true,
      service: "heya-to",
    });
  });

  it("marks room and manager screens noindex", async () => {
    const room = await createRoom();
    for (const [path, mode] of [
      [`/r/${room.id}`, "public"],
      [`/m/${room.id}`, "manage"],
    ]) {
      const html = await (await app.request(path, undefined, bindings)).text();
      expect(html).toContain('content="noindex,nofollow" name="robots"');
      expect(html).toContain(`data-mode="${mode}"`);
    }
  });
});

describe("room creation", () => {
  it("creates a room without leaking its manager key", async () => {
    const room = await createRoom();
    const publicResponse = await app.request(`/api/rooms/${room.id}`, undefined, bindings);
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.text()).not.toContain(room.managerKey);
    expect(
      (await app.request(`/api/rooms/${room.id}/manage`, { headers: headers() }, bindings)).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          `/api/rooms/${room.id}/manage`,
          { headers: headers(sessions[0], room.managerKey) },
          bindings,
        )
      ).status,
    ).toBe(200);
  });

  it("renders user text safely and filters the board", async () => {
    await createRoom({ note: "<集合>", purpose: "event", song: "<周回>" });
    await createRoom({ purpose: "song", roomCode: "12045", song: "指定曲" }, sessions[1]);
    const eventHtml = await (await app.request("/?purpose=event", undefined, bindings)).text();
    expect(eventHtml).toContain("&lt;集合&gt;");
    expect(eventHtml).toContain("&lt;周回&gt;");
    expect(eventHtml).not.toContain('data-purpose="song"');
    expect(eventHtml).not.toContain("12045");
  });

  it.each([
    [{ roomCode: "1234A" }, "invalid_roomCode"],
    [{ openSeats: 5 }, "invalid_openSeats"],
    [{ song: "https://example.com" }, "unsafe_song"],
    [{ note: "Discord: sample" }, "unsafe_note"],
    [{ note: "BOTで自動プレイ" }, "unsafe_note"],
    [{ website: "filled" }, "invalid_request"],
  ])("rejects invalid or unsafe room input %#", async (overrides, error) => {
    const response = await app.request(
      "/api/rooms",
      { body: JSON.stringify(validRoom(overrides)), headers: headers(), method: "POST" },
      bindings,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error });
  });

  it("rejects cross-origin creation", async () => {
    const response = await app.request(
      "/api/rooms",
      {
        body: JSON.stringify(validRoom()),
        headers: { ...headers(), origin: "https://evil.example" },
        method: "POST",
      },
      bindings,
    );
    expect(response.status).toBe(403);
  });

  it("blocks a duplicate active code and the fourth creation in 15 minutes", async () => {
    await createRoom();
    const duplicate = await app.request(
      "/api/rooms",
      {
        body: JSON.stringify(validRoom()),
        headers: headers(sessions[1]),
        method: "POST",
      },
      bindings,
    );
    expect(await duplicate.json()).toMatchObject({ error: "room_already_lit" });

    await createRoom({ roomCode: "10001" });
    await createRoom({ roomCode: "10002" });
    const limited = await app.request(
      "/api/rooms",
      {
        body: JSON.stringify(validRoom({ roomCode: "10003" })),
        headers: headers(),
        method: "POST",
      },
      bindings,
    );
    expect(limited.status).toBe(429);
  });
});

describe("participant signals", () => {
  it("returns and records a copied room code", async () => {
    const room = await createRoom();
    const response = await postEmpty(`/api/rooms/${room.id}/copy`);
    expect(await response.json()).toEqual({ roomCode: "58310" });
    const event = await bindings.DB.prepare(
      "SELECT name,room_id,is_qa FROM product_events WHERE name = 'room_code_copied'",
    ).first<{ is_qa: number; name: string; room_id: string }>();
    expect(event).toMatchObject({ is_qa: 0, name: "room_code_copied", room_id: room.id });
  });

  it("keeps entered and full signals idempotent", async () => {
    const room = await createRoom();
    for (const action of ["entered", "entered", "full", "full"]) {
      expect((await postEmpty(`/api/rooms/${room.id}/${action}`)).status).toBeLessThan(300);
    }
    const state = await (
      await app.request(`/api/rooms/${room.id}`, undefined, bindings)
    ).json<{ enteredCount: number; fullSignals: number }>();
    expect(state).toMatchObject({ enteredCount: 1, fullSignals: 1 });
  });

  it("hides a room and erases its code after three distinct reports", async () => {
    const room = await createRoom();
    for (let index = 1; index <= 3; index += 1) {
      const response = await app.request(
        `/api/rooms/${room.id}/report`,
        {
          body: JSON.stringify({ reason: "unsafe" }),
          headers: headers(sessions[index]),
          method: "POST",
        },
        bindings,
      );
      expect(response.status).toBe(202);
    }
    expect((await app.request(`/api/rooms/${room.id}`, undefined, bindings)).status).toBe(404);
    const hidden = await bindings.DB.prepare("SELECT room_code,status FROM rooms WHERE id = ?")
      .bind(room.id)
      .first<{ room_code: string; status: string }>();
    expect(hidden).toEqual({ room_code: "00000", status: "hidden" });
  });
});

describe("manager controls and retention", () => {
  it("updates seats, closes a full room, and allows one extension", async () => {
    const room = await createRoom();
    const manage = (body: unknown) =>
      app.request(
        `/api/rooms/${room.id}/manage`,
        {
          body: JSON.stringify(body),
          headers: headers(sessions[0], room.managerKey),
          method: "PATCH",
        },
        bindings,
      );
    expect(await (await manage({ openSeats: 1 })).json()).toMatchObject({ openSeats: 1 });
    expect(await (await manage({ status: "full" })).json()).toEqual({ status: "full" });
    expect(await (await manage({ extend: true })).json()).toMatchObject({ extensions: 1 });
    expect((await manage({ extend: true })).status).toBe(409);
  });

  it("deletes a room with only the correct manager key", async () => {
    const room = await createRoom();
    const denied = await app.request(
      `/api/rooms/${room.id}`,
      { headers: headers(sessions[0], "0".repeat(64)), method: "DELETE" },
      bindings,
    );
    expect(denied.status).toBe(403);
    const deleted = await app.request(
      `/api/rooms/${room.id}`,
      { headers: headers(sessions[0], room.managerKey), method: "DELETE" },
      bindings,
    );
    expect(deleted.status).toBe(200);
    expect(
      await bindings.DB.prepare("SELECT id FROM rooms WHERE id = ?").bind(room.id).first(),
    ).toBeNull();
  });

  it("keeps QA events separate and rejects unknown telemetry", async () => {
    const unknown = await app.request(
      "/api/telemetry",
      {
        body: JSON.stringify({ name: "contact_captured" }),
        headers: headers(),
        method: "POST",
      },
      bindings,
    );
    expect(unknown.status).toBe(400);
    await createRoom({}, sessions[0], true);
    const rows = await bindings.DB.prepare(
      "SELECT is_qa,COUNT(*) AS count FROM product_events GROUP BY is_qa",
    ).all<{ count: number; is_qa: number }>();
    expect(rows.results).toEqual([{ count: 1, is_qa: 1 }]);
  });

  it("removes rooms one hour after expiry and events after 35 days", async () => {
    const room = await createRoom();
    await bindings.DB.prepare("UPDATE rooms SET expires_at = 1 WHERE id = ?").bind(room.id).run();
    await bindings.DB.prepare("UPDATE product_events SET created_at = 1").run();
    await scheduled({} as ScheduledEvent, bindings, {} as ExecutionContext);
    expect(
      await bindings.DB.prepare("SELECT id FROM rooms WHERE id = ?").bind(room.id).first(),
    ).toBeNull();
    expect(await bindings.DB.prepare("SELECT id FROM product_events").first()).toBeNull();
  });

  it("keeps the static release code-safe and visually product-specific", async () => {
    const [appScript, roomScript, styles, wrangler, og] = await Promise.all([
      readFile(appScriptPath, "utf8"),
      readFile(roomScriptPath, "utf8"),
      readFile(stylesPath, "utf8"),
      readFile(wranglerPath, "utf8"),
      stat(ogPath),
    ]);
    expect(appScript + roomScript).not.toMatch(/innerHTML|eval\(|new Function/u);
    expect(styles).not.toMatch(/gradient/iu);
    expect(wrangler).not.toContain("TO_BE_CREATED");
    expect(og.size).toBeGreaterThan(2500);
  });
});
