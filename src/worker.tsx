import { Hono } from "hono";
import type { Context } from "hono";
import { requestId } from "hono/request-id";

import {
  extensionExpiry,
  isRoomCode,
  isRoomPurpose,
  minutesRemaining,
  normalizeRoomRules,
  roomPurposes,
  type RoomPurpose,
  type RoomRule,
} from "./domain/rooms";

export type Bindings = { ASSETS: Fetcher; DB: D1Database };
type Variables = { requestId: string };
type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;
type RoomStatus = "active" | "closed" | "full" | "hidden";

type RoomRow = {
  created_at: number;
  creator_session_id: string;
  expires_at: number;
  extensions: number;
  host_bonus: number;
  id: string;
  manager_token_hash: string;
  minimum_bonus: number;
  note: string;
  open_seats: number;
  purpose: RoomPurpose;
  room_code: string;
  rounds: number;
  rules: string;
  song: string;
  status: RoomStatus;
  updated_at: number;
};

class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 413 | 415 | 429,
  ) {
    super(code);
  }
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const canonicalOrigin = "https://heya-to.yhay81.com";
const idPattern = /^[0-9a-f]{32}$/u;
const tokenPattern = /^[0-9a-f]{64}$/u;
const sessionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const contactPattern =
  /(?:https?:\/\/|www\.|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?:\+?81[-\s]?|0)\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}|(?:line|discord|instagram|twitter|x)\s*[:＠@])/iu;
const automationPattern = /(?:bot|macro|マクロ|自動(?:化|送信|プレイ)|代行|売買|rmt|チート)/iu;
const reportReasons = new Set(["invalid", "other", "spam", "unsafe"]);
const telemetryNames = new Set([
  "board_filtered",
  "entry_confirmed",
  "returned",
  "room_code_copied",
  "room_created",
  "room_managed",
  "visited",
]);

const purposeLabels: Record<RoomPurpose, string> = {
  event: "イベント周回",
  other: "その他",
  random: "おまかせ",
  song: "指定曲",
  support: "支援募集",
};
const ruleLabels: Record<RoomRule, string> = {
  conditions: "条件違いは解散",
  "difficulty-free": "難易度自由",
  "efficient-song-ok": "効率曲以外も可",
  "long-run": "長時間歓迎",
  "mistakes-ok": "ミス気にしない",
  "sf-none": "SFなし",
  "withdraw-ok": "途中退室OK",
};

const nowSeconds = () => Math.floor(Date.now() / 1000);
const jstDay = (milliseconds = Date.now()) =>
  new Date(milliseconds + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const randomHex = (length: number) => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
const constantTimeEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};
const enforceSameOrigin = (c: AppContext) => {
  const fetchSite = c.req.header("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") throw new ApiError("cross_site_request", 403);
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin) throw new ApiError("cross_site_request", 403);
};
const parseJson = async (c: AppContext, maximumBytes = 4096) => {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ApiError("unsupported_media_type", 415);
  }
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).byteLength > maximumBytes) {
    throw new ApiError("payload_too_large", 413);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiError("invalid_json", 400);
  }
};
const objectPayload = (payload: unknown) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError("invalid_request", 400);
  }
  return payload as Record<string, unknown>;
};
const cleanText = (
  payload: Record<string, unknown>,
  key: string,
  maximum: number,
  options: { allowEmpty?: boolean; blockUnsafe?: boolean } = {},
) => {
  if (typeof payload[key] !== "string") throw new ApiError("invalid_" + key, 400);
  const value = payload[key].replace(/\r\n?/gu, "\n").trim();
  if ((!options.allowEmpty && !value) || value.length > maximum) {
    throw new ApiError("invalid_" + key, 400);
  }
  if (options.blockUnsafe && (contactPattern.test(value) || automationPattern.test(value))) {
    throw new ApiError("unsafe_" + key, 400);
  }
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if ((point < 32 && point !== 9 && point !== 10) || point === 127) {
      throw new ApiError("invalid_" + key, 400);
    }
  }
  return value;
};
const integerValue = (
  payload: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
) => {
  const value = payload[key];
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ApiError("invalid_" + key, 400);
  }
  return value as number;
};
const validateId = (value: string) => {
  if (!idPattern.test(value)) throw new ApiError("not_found", 404);
  return value;
};
const sessionId = (c: AppContext) => {
  const value = c.req.header("x-heya-session") ?? "";
  if (!sessionPattern.test(value)) throw new ApiError("invalid_session", 400);
  return value.toLowerCase();
};
const capability = (c: AppContext) => {
  const value = c.req.header("x-heya-key") ?? "";
  if (!tokenPattern.test(value)) throw new ApiError("invalid_capability", 403);
  return value;
};
const getRoom = async (database: D1Database, id: string, includeInactive = false) => {
  const row = await database
    .prepare("SELECT * FROM rooms WHERE id = ? AND expires_at > ?")
    .bind(id, nowSeconds())
    .first<RoomRow>();
  if (
    !row ||
    row.status === "hidden" ||
    (!includeInactive && !new Set(["active", "full"]).has(row.status))
  ) {
    throw new ApiError("not_found", 404);
  }
  return row;
};
const managerRoom = async (c: AppContext, id: string) => {
  const room = await getRoom(c.env.DB, id, true);
  const suppliedHash = await sha256(capability(c));
  if (!constantTimeEqual(room.manager_token_hash, suppliedHash)) {
    throw new ApiError("invalid_capability", 403);
  }
  return room;
};
const recordEvent = async (c: AppContext, name: string, roomId = "", actor?: string) => {
  if (!telemetryNames.has(name)) return;
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO product_events (name,session_id,room_id,day,created_at,is_qa) VALUES (?,?,?,?,?,?)",
  )
    .bind(
      name,
      actor ?? sessionId(c),
      roomId,
      jstDay(),
      nowSeconds(),
      c.req.header("x-heya-qa") === "1" ? 1 : 0,
    )
    .run();
};
const publicRoom = async (database: D1Database, room: RoomRow) => {
  const signals = await database
    .prepare("SELECT kind,COUNT(*) AS count FROM room_signals WHERE room_id = ? GROUP BY kind")
    .bind(room.id)
    .all<{ count: number; kind: string }>();
  const counts = Object.fromEntries(signals.results.map((item) => [item.kind, item.count]));
  const rules = room.rules ? (room.rules.split(",") as RoomRule[]) : [];
  return {
    enteredCount: Number(counts.entered ?? 0),
    expiresAt: room.expires_at,
    fullSignals: Number(counts.full ?? 0),
    hostBonus: room.host_bonus,
    id: room.id,
    minimumBonus: room.minimum_bonus,
    minutesRemaining: minutesRemaining(room.expires_at, nowSeconds()),
    note: room.note,
    openSeats: room.open_seats,
    purpose: room.purpose,
    purposeLabel: purposeLabels[room.purpose],
    roomCode: room.room_code,
    rounds: room.rounds,
    ruleLabels: rules.map((rule) => ruleLabels[rule]),
    rules,
    song: room.song,
    status: room.status,
  };
};

const Layout = ({
  canonical,
  children,
  description,
  noindex = false,
  script,
  title,
}: {
  canonical: string;
  children: unknown;
  description: string;
  noindex?: boolean;
  script?: string;
  title: string;
}) => (
  <html lang="ja">
    <head>
      <meta charset="utf-8" />
      <meta content="width=device-width, initial-scale=1" name="viewport" />
      <title>{title}</title>
      <meta content={description} name="description" />
      <link href={canonical} rel="canonical" />
      <meta content={noindex ? "noindex,nofollow" : "index,follow"} name="robots" />
      <meta content="website" property="og:type" />
      <meta content={title} property="og:title" />
      <meta content={description} property="og:description" />
      <meta content={canonical} property="og:url" />
      <meta content={canonicalOrigin + "/og.svg"} property="og:image" />
      <meta content="#151c2b" name="theme-color" />
      <link href="/favicon.svg" rel="icon" type="image/svg+xml" />
      <link href="/manifest.webmanifest" rel="manifest" />
      <link href="/styles.css" rel="stylesheet" />
      {script ? <script defer src={script}></script> : null}
    </head>
    <body>
      <a class="skip-link" href="#main">
        本文へ移動
      </a>
      <header class="site-header">
        <a aria-label="部屋灯 ホーム" class="brand" href="/">
          <span aria-hidden="true" class="brand-mark">
            {Array.from({ length: 5 }, () => (
              <i />
            ))}
          </span>
          <b>部屋灯</b>
        </a>
        <nav aria-label="主なページ">
          <a href="/guide">使い方</a>
          <a href="/safety">安全</a>
          <a href="/privacy">データ</a>
        </nav>
      </header>
      {children}
      <footer>
        <p>部屋灯は有志の非公式サービスです。ゲーム運営各社とは関係ありません。</p>
        <div>
          <a href="/safety">安全</a>
          <a href="/privacy">プライバシー</a>
          <a href="https://github.com/yhay81/heya-to">GitHub</a>
        </div>
      </footer>
    </body>
  </html>
);

const RoomVisual = ({ code = "58310", openSeats = 3 }: { code?: string; openSeats?: number }) => (
  <div aria-label={`ルーム番号${code}、残り${openSeats}席`} class="room-visual" role="img">
    <div class="code-display">
      {code.split("").map((digit) => (
        <i>{digit}</i>
      ))}
    </div>
    <div class="seat-stage">
      <span class="host-seat">
        <i />
        <b>HOST</b>
      </span>
      {Array.from({ length: 4 }, (_, index) => (
        <span class={index < openSeats ? "open-seat" : "filled-seat"}>
          <i />
          <b>{index < openSeats ? "OPEN" : "IN"}</b>
        </span>
      ))}
    </div>
    <div class="time-rail">
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
    </div>
    <div class="time-readout">
      <b>12</b>
      <span>MIN</span>
    </div>
  </div>
);

const RoomCard = ({ room }: { room: RoomRow }) => {
  const rules = room.rules ? (room.rules.split(",") as RoomRule[]) : [];
  return (
    <article class="room-card" data-purpose={room.purpose}>
      <div class="card-status">
        <span>{purposeLabels[room.purpose]}</span>
        <b>{minutesRemaining(room.expires_at, nowSeconds())}分</b>
      </div>
      <div class="mini-code">
        {room.room_code.split("").map((digit) => (
          <i>{digit}</i>
        ))}
      </div>
      <div class="mini-seats">
        <span class="host" />
        {Array.from({ length: 4 }, (_, index) => (
          <span class={index < room.open_seats ? "open" : "filled"} />
        ))}
      </div>
      <div class="room-facts">
        <b>あと{room.open_seats}人</b>
        {room.song ? <span>{room.song}</span> : null}
        {room.rounds ? <span>{room.rounds}回予定</span> : null}
      </div>
      {rules.length ? (
        <div class="rule-chips">
          {rules.slice(0, 3).map((rule) => (
            <span>{ruleLabels[rule]}</span>
          ))}
        </div>
      ) : null}
      {room.note ? <p>{room.note}</p> : null}
      <div class="card-actions">
        <button
          class="copy-code"
          data-copy-code={room.room_code}
          data-room-id={room.id}
          type="button"
        >
          5桁をコピー
        </button>
        <a href={`/r/${room.id}`}>詳しく見る</a>
      </div>
    </article>
  );
};

const Home = ({ rooms, selected }: { rooms: RoomRow[]; selected: string }) => (
  <Layout
    canonical={canonicalOrigin + "/"}
    description="協力ライブの5桁と条件を12分だけ置く、名前も連絡先もいらない短期募集盤。"
    script="/app.js"
    title="部屋灯｜5桁を置く、12分の協力ルーム募集"
  >
    <main id="main">
      <section class="hero">
        <div class="hero-copy">
          <p class="eyebrow">CO-OP ROOM SIGNAL</p>
          <h1>
            5桁を置く。
            <br />
            5人が灯る。
          </h1>
          <p>ゲーム内で部屋を作ったら、残り席と条件を12分だけ点灯。</p>
          <button class="primary" data-open-create type="button">
            部屋を点ける
          </button>
        </div>
        <RoomVisual />
      </section>
      <section aria-label="部屋灯でできること" class="signal-strip">
        <article>
          <span class="strip-code">5</span>
          <b>番号</b>
          <small>5桁だけ</small>
        </article>
        <article>
          <span class="strip-seats">
            <i />
            <i />
            <i />
          </span>
          <b>空席</b>
          <small>あと何人</small>
        </article>
        <article>
          <span class="strip-clock" />
          <b>短命</b>
          <small>12分で消灯</small>
        </article>
      </section>
      <section class="create-panel" id="create-panel">
        <div class="panel-heading">
          <span>01</span>
          <div>
            <p class="eyebrow">LIGHT A ROOM</p>
            <h2>募集灯を組む</h2>
          </div>
        </div>
        <form data-create-form>
          <div class="form-grid">
            <label class="field code-field">
              ルーム番号
              <input
                autocomplete="off"
                inputmode="numeric"
                maxlength={5}
                name="roomCode"
                pattern="[0-9]{5}"
                placeholder="12345"
                required
              />
            </label>
            <label class="field">
              目的
              <select name="purpose">
                {roomPurposes.map((purpose) => (
                  <option value={purpose}>{purposeLabels[purpose]}</option>
                ))}
              </select>
            </label>
            <label class="field">
              残り席
              <select name="openSeats">
                <option value="1">あと1人</option>
                <option value="2">あと2人</option>
                <option selected value="3">
                  あと3人
                </option>
                <option value="4">あと4人</option>
              </select>
            </label>
            <label class="field">
              曲・周回名
              <input maxlength={40} name="song" placeholder="任意" />
            </label>
            <label class="field">
              主の実効値
              <input
                inputmode="numeric"
                max="999"
                min="0"
                name="hostBonus"
                type="number"
                value="0"
              />
            </label>
            <label class="field">
              募集の実効値
              <input
                inputmode="numeric"
                max="999"
                min="0"
                name="minimumBonus"
                type="number"
                value="0"
              />
            </label>
            <label class="field">
              予定回数
              <input inputmode="numeric" max="99" min="0" name="rounds" type="number" value="0" />
            </label>
            <fieldset class="rules-field">
              <legend>固定ルール</legend>
              {Object.entries(ruleLabels).map(([value, label]) => (
                <label>
                  <input name="rules" type="checkbox" value={value} />
                  <span>{label}</span>
                </label>
              ))}
            </fieldset>
            <label class="field field-wide">
              ひとこと
              <textarea
                maxlength={100}
                name="note"
                placeholder="連絡先や外部URLは書けません"
                rows={2}
              />
            </label>
            <label aria-hidden="true" class="honeypot">
              Webサイト
              <input autocomplete="off" name="website" tabindex={-1} />
            </label>
          </div>
          <div class="safety-inline">
            <span class="shield-dot" />
            <p>
              名前・画像・SNS・連絡先・チャットは保存しません。代行、自動プレイ、売買の募集は作れません。
            </p>
          </div>
          <button class="primary" type="submit">
            12分の募集灯を点ける
          </button>
          <p aria-live="polite" class="form-message" data-form-message />
        </form>
      </section>
      <section class="board-section">
        <div class="section-heading">
          <div>
            <p class="eyebrow">LIVE ROOMS</p>
            <h2>点灯中の部屋</h2>
          </div>
          <b>{rooms.length}室</b>
        </div>
        <form class="board-filter" method="get">
          <label>
            目的
            <select name="purpose">
              <option value="">すべて</option>
              {roomPurposes.map((purpose) => (
                <option selected={selected === purpose} value={purpose}>
                  {purposeLabels[purpose]}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">絞る</button>
        </form>
        <div class="room-grid">
          {rooms.length ? (
            rooms.map((room) => <RoomCard room={room} />)
          ) : (
            <div class="empty-board">
              <div class="dark-seats">
                {Array.from({ length: 5 }, () => (
                  <i />
                ))}
              </div>
              <p>点灯中の部屋はありません。</p>
            </div>
          )}
        </div>
      </section>
      <section class="boundary-row">
        <div>
          <span class="boundary-icon digits" />
          <b>置くもの</b>
          <p>5桁、残り席、固定条件</p>
        </div>
        <div>
          <span class="boundary-icon blank" />
          <b>置かないもの</b>
          <p>名前、連絡先、画像、会話</p>
        </div>
        <div>
          <span class="boundary-icon timer" />
          <b>消えるもの</b>
          <p>募集は12分、延長は1回</p>
        </div>
      </section>
    </main>
  </Layout>
);

const RoomShell = ({ id, mode }: { id: string; mode: "manage" | "public" }) => (
  <Layout
    canonical={canonicalOrigin + "/"}
    description="短時間だけ点灯する協力ルーム募集。"
    noindex
    script="/room.js"
    title="協力ルーム｜部屋灯"
  >
    <main class="room-shell" data-mode={mode} data-room-id={id} id="main">
      <section class="loading-bay" data-loading>
        <div class="loader-seats">
          {Array.from({ length: 5 }, () => (
            <i />
          ))}
        </div>
        <p>部屋の灯りを確認中…</p>
      </section>
      <div data-room-app hidden>
        <section class="room-head">
          <div class="purpose-beacon">
            <i />
            <span data-purpose />
          </div>
          <div>
            <p class="eyebrow">CO-OP ROOM SIGNAL</p>
            <h1 data-song>協力ルーム</h1>
            <p data-remaining />
          </div>
        </section>
        <section class="detail-console">
          <div class="detail-code" data-code />{" "}
          <button class="primary" data-copy type="button">
            5桁をコピー
          </button>
          <div class="detail-seats" data-seats>
            {Array.from({ length: 5 }, (_, index) => (
              <i class={index === 0 ? "host" : ""} />
            ))}
          </div>
          <div class="detail-timer">
            <span data-time-rail>
              {Array.from({ length: 12 }, () => (
                <i />
              ))}
            </span>
            <b data-minutes />
          </div>
        </section>
        <section class="room-conditions">
          <div class="condition-numbers">
            <span>
              主<strong data-host-bonus />
            </span>
            <span>
              募集
              <strong data-minimum-bonus />
            </span>
            <span>
              回数
              <strong data-rounds />
            </span>
          </div>
          <div class="rule-chips" data-rules />
          <p data-note />
        </section>
        <section class="public-actions" data-public-actions>
          <button class="secondary" data-entered type="button">
            ゲーム内で入れた
          </button>
          <button class="text-button" data-full type="button">
            満室だった
          </button>
          <button class="text-button" data-share type="button">
            この灯りを共有
          </button>
          <button class="text-button" data-report type="button">
            問題を報告
          </button>
          <p class="form-message" data-action-message />
        </section>
        <section class="manager-console" data-manager-console hidden>
          <div class="panel-heading">
            <span>02</span>
            <div>
              <p class="eyebrow">HOST CONTROL</p>
              <h2>募集灯を動かす</h2>
            </div>
          </div>
          <div class="manager-actions">
            <label>
              残り席
              <select data-open-seats>
                <option value="1">あと1人</option>
                <option value="2">あと2人</option>
                <option value="3">あと3人</option>
                <option value="4">あと4人</option>
              </select>
            </label>
            <button class="secondary" data-save-seats type="button">
              席を更新
            </button>
            <button class="secondary" data-mark-full type="button">
              満室で消す
            </button>
            <button class="secondary" data-extend type="button">
              12分延長
            </button>
            <button class="text-button danger" data-delete type="button">
              削除
            </button>
          </div>
          <p class="capability-note">
            このURLの #key は募集主だけで保管してください。延長は1回だけです。
          </p>
          <p class="form-message" data-manager-message />
        </section>
        <section class="room-disclaimer">
          <b>非公式の短期募集盤です。</b>
          <p>
            番号や空席は変わることがあります。ゲーム内表示を正本として確認し、個人情報や不正行為を持ち込まないでください。
          </p>
        </section>
      </div>
      <section class="room-error" data-error hidden>
        <div class="dark-seats">
          {Array.from({ length: 5 }, () => (
            <i />
          ))}
        </div>
        <h1>この部屋は消灯しました。</h1>
        <p data-error-message />
        <a class="button-link" href="/">
          点灯中の部屋へ
        </a>
      </section>
    </main>
  </Layout>
);

const Guide = () => (
  <Layout
    canonical={canonicalOrigin + "/guide"}
    description="部屋灯で協力ルームを募集し、5桁をコピーする流れ。"
    title="使い方｜部屋灯"
  >
    <main class="info-page" id="main">
      <div class="info-heading">
        <RoomVisual code="12345" openSeats={2} />
        <div>
          <p class="eyebrow">ROOM PROCEDURE</p>
          <h1>作る、置く、集まったら消す。</h1>
        </div>
      </div>
      <ol class="guide-cards">
        <li>
          <span>1</span>
          <div>
            <h2>ゲーム内で部屋を作る</h2>
            <p>プライベートルームの5桁と、あと何人ほしいかを確認します。</p>
          </div>
        </li>
        <li>
          <span>2</span>
          <div>
            <h2>12分の灯りを置く</h2>
            <p>目的と固定条件だけを選びます。名前や連絡先はいりません。</p>
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            <h2>参加者は5桁をコピー</h2>
            <p>ゲーム内で番号を入力します。入室できたら任意で結果を返せます。</p>
          </div>
        </li>
        <li>
          <span>4</span>
          <div>
            <h2>満室なら消灯</h2>
            <p>募集主は残り席を変え、満室で灯りを消します。放置しても12分で消えます。</p>
          </div>
        </li>
      </ol>
      <section class="source-card">
        <h2>ゲーム内の操作が正本</h2>
        <p>
          公式FAQはプライベートルームの開放や連続ライブを案内しています。機能やルールは変更されるため、最新情報を公式で確認してください。
        </p>
        <a href="https://pjsekai.sega.jp/faq/index.html" rel="noopener noreferrer" target="_blank">
          公式FAQを確認 ↗
        </a>
      </section>
    </main>
  </Layout>
);
const Safety = () => (
  <Layout
    canonical={canonicalOrigin + "/safety"}
    description="部屋灯で扱わない個人情報、不正行為、迷惑行為の境界。"
    title="安全｜部屋灯"
  >
    <main class="info-page" id="main">
      <div class="info-heading safety-heading">
        <div class="safety-console">
          <i />
          <i />
          <i />
        </div>
        <div>
          <p class="eyebrow">SAFE PLAY BOUNDARY</p>
          <h1>番号の外へ、話を広げない。</h1>
        </div>
      </div>
      <div class="data-grid">
        <section class="data-card keep">
          <h2>使える</h2>
          <ul>
            <li>ゲーム内の5桁</li>
            <li>残り席と周回目的</li>
            <li>実効値、回数、固定ルール</li>
            <li>連絡先を含まない短い補足</li>
          </ul>
        </section>
        <section class="data-card never">
          <h2>使えない</h2>
          <ul>
            <li>氏名、学校、住所、電話、メール</li>
            <li>SNS、Discord、LINE、外部URL</li>
            <li>画像、プレイヤーID、自由な会話</li>
            <li>代行、売買、自動プレイ、BOT、チート</li>
          </ul>
        </section>
      </div>
      <section class="source-card">
        <h2>公式ガイドラインを優先</h2>
        <p>
          公式は個人情報を安易に伝えないこと、迷惑行為に反応せず通報機能を使うこと、不正操作や代行、自動プレイを行わないことを案内しています。
        </p>
        <a
          href="https://pjsekai.sega.jp/guideline/index.html"
          rel="noopener noreferrer"
          target="_blank"
        >
          公式ガイドラインを確認 ↗
        </a>
      </section>
    </main>
  </Layout>
);
const Privacy = () => (
  <Layout
    canonical={canonicalOrigin + "/privacy"}
    description="部屋灯が保存する短期募集データと、保存しない個人情報。"
    title="データ｜部屋灯"
  >
    <main class="info-page" id="main">
      <div class="info-heading privacy-heading">
        <div class="privacy-slots">
          {Array.from({ length: 5 }, () => (
            <i />
          ))}
        </div>
        <div>
          <p class="eyebrow">DATA BOUNDARY</p>
          <h1>5桁は短く。人の情報は持たない。</h1>
        </div>
      </div>
      <div class="data-grid">
        <section class="data-card keep">
          <h2>短く保存する</h2>
          <ul>
            <li>5桁、目的、残り席、固定条件</li>
            <li>任意の実効値、回数、短い補足</li>
            <li>匿名セッションの利用イベント</li>
            <li>管理鍵のSHA-256ハッシュ</li>
          </ul>
        </section>
        <section class="data-card never">
          <h2>保存しない</h2>
          <ul>
            <li>氏名、連絡先、SNS、アカウント</li>
            <li>画像、端末識別子、位置情報</li>
            <li>チャット、参加者名簿、決済</li>
            <li>ゲーム認証情報、プレイデータ</li>
          </ul>
        </section>
      </div>
      <p class="retention-note">
        募集は12分で非表示になり、期限から1時間後に関連データごと削除します。匿名利用イベントは35日後に削除します。
      </p>
    </main>
  </Layout>
);

app.use("*", requestId());
app.use("*", async (c, next) => {
  await next();
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  );
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  c.header("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=()");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
});

app.get("/", async (c) => {
  const selected = c.req.query("purpose") ?? "";
  const purpose = selected && isRoomPurpose(selected) ? selected : "";
  const query = purpose
    ? "SELECT * FROM rooms WHERE status = 'active' AND purpose = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 40"
    : "SELECT * FROM rooms WHERE status = 'active' AND expires_at > ? ORDER BY created_at DESC LIMIT 40";
  const statement = c.env.DB.prepare(query);
  const result = purpose
    ? await statement.bind(purpose, nowSeconds()).all<RoomRow>()
    : await statement.bind(nowSeconds()).all<RoomRow>();
  c.header("Cache-Control", "no-store");
  return c.html(<Home rooms={result.results} selected={purpose} />);
});
app.get("/guide", (c) => c.html(<Guide />));
app.get("/safety", (c) => c.html(<Safety />));
app.get("/privacy", (c) => c.html(<Privacy />));
app.get("/r/:id", async (c) => {
  const id = validateId(c.req.param("id"));
  await getRoom(c.env.DB, id);
  return c.html(<RoomShell id={id} mode="public" />);
});
app.get("/m/:id", async (c) => {
  const id = validateId(c.req.param("id"));
  await getRoom(c.env.DB, id, true);
  return c.html(<RoomShell id={id} mode="manage" />);
});
app.get("/sitemap.xml", (c) => {
  const paths = ["/", "/guide", "/safety", "/privacy"];
  c.header("Content-Type", "application/xml; charset=UTF-8");
  c.header("Cache-Control", "public, max-age=3600, s-maxage=86400");
  return c.body(
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      paths.map((path) => `  <url><loc>${canonicalOrigin}${path}</loc></url>`).join("\n") +
      "\n</urlset>",
  );
});

app.post("/api/telemetry", async (c) => {
  enforceSameOrigin(c);
  const payload = objectPayload(await parseJson(c, 512));
  const name = cleanText(payload, "name", 40);
  if (!telemetryNames.has(name)) throw new ApiError("invalid_event", 400);
  const roomId =
    typeof payload.roomId === "string" && idPattern.test(payload.roomId) ? payload.roomId : "";
  await recordEvent(c, name, roomId);
  return c.json({ ok: true }, 202);
});

app.post("/api/rooms", async (c) => {
  enforceSameOrigin(c);
  const actor = sessionId(c);
  const payload = objectPayload(await parseJson(c, 3072));
  if (payload.website !== "") throw new ApiError("invalid_request", 400);
  const roomCode = cleanText(payload, "roomCode", 5);
  if (!isRoomCode(roomCode)) throw new ApiError("invalid_roomCode", 400);
  const purposeText = cleanText(payload, "purpose", 16);
  if (!isRoomPurpose(purposeText)) throw new ApiError("invalid_purpose", 400);
  const purpose = purposeText;
  const song = cleanText(payload, "song", 40, { allowEmpty: true, blockUnsafe: true });
  const openSeats = integerValue(payload, "openSeats", 1, 4);
  const hostBonus = integerValue(payload, "hostBonus", 0, 999);
  const minimumBonus = integerValue(payload, "minimumBonus", 0, 999);
  const rounds = integerValue(payload, "rounds", 0, 99);
  const rules = normalizeRoomRules(payload.rules);
  if (!rules) throw new ApiError("invalid_rules", 400);
  const note = cleanText(payload, "note", 100, { allowEmpty: true, blockUnsafe: true });
  const current = nowSeconds();
  const recent = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM rooms WHERE creator_session_id = ? AND created_at > ?",
  )
    .bind(actor, current - 900)
    .first<{ count: number }>();
  if ((recent?.count ?? 0) >= 3) throw new ApiError("create_rate_limited", 429);
  const duplicate = await c.env.DB.prepare(
    "SELECT id FROM rooms WHERE room_code = ? AND status IN ('active','full') AND expires_at > ?",
  )
    .bind(roomCode, current)
    .first();
  if (duplicate) throw new ApiError("room_already_lit", 409);
  const id = randomHex(16);
  const token = randomHex(32);
  await c.env.DB.prepare(
    "INSERT INTO rooms (id,manager_token_hash,creator_session_id,room_code,purpose,song,open_seats,host_bonus,minimum_bonus,rounds,rules,note,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      await sha256(token),
      actor,
      roomCode,
      purpose,
      song,
      openSeats,
      hostBonus,
      minimumBonus,
      rounds,
      rules.join(","),
      note,
      current,
      current,
      current + 12 * 60,
    )
    .run();
  await recordEvent(c, "room_created", id, actor);
  return c.json({ id, manageUrl: `/m/${id}#key=${token}`, publicUrl: `/r/${id}` }, 201);
});

app.get("/api/rooms/:id", async (c) => {
  const id = validateId(c.req.param("id"));
  return c.json(await publicRoom(c.env.DB, await getRoom(c.env.DB, id)));
});
app.get("/api/rooms/:id/manage", async (c) => {
  const id = validateId(c.req.param("id"));
  const room = await managerRoom(c, id);
  return c.json({
    ...(await publicRoom(c.env.DB, room)),
    extensions: room.extensions,
    manager: true,
  });
});

app.post("/api/rooms/:id/copy", async (c) => {
  enforceSameOrigin(c);
  const id = validateId(c.req.param("id"));
  const room = await getRoom(c.env.DB, id);
  objectPayload(await parseJson(c, 256));
  await recordEvent(c, "room_code_copied", id);
  return c.json({ roomCode: room.room_code });
});
app.post("/api/rooms/:id/entered", async (c) => {
  enforceSameOrigin(c);
  const id = validateId(c.req.param("id"));
  await getRoom(c.env.DB, id);
  objectPayload(await parseJson(c, 256));
  const actor = sessionId(c);
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO room_signals (room_id,session_id,kind,created_at) VALUES (?,?,'entered',?)",
  )
    .bind(id, actor, nowSeconds())
    .run();
  await recordEvent(c, "entry_confirmed", id, actor);
  return c.json({ accepted: true }, 201);
});
app.post("/api/rooms/:id/full", async (c) => {
  enforceSameOrigin(c);
  const id = validateId(c.req.param("id"));
  await getRoom(c.env.DB, id);
  objectPayload(await parseJson(c, 256));
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO room_signals (room_id,session_id,kind,created_at) VALUES (?,?,'full',?)",
  )
    .bind(id, sessionId(c), nowSeconds())
    .run();
  return c.json({ accepted: true }, 202);
});
app.post("/api/rooms/:id/report", async (c) => {
  enforceSameOrigin(c);
  const id = validateId(c.req.param("id"));
  await getRoom(c.env.DB, id);
  const payload = objectPayload(await parseJson(c, 512));
  const reason = cleanText(payload, "reason", 16);
  if (!reportReasons.has(reason)) throw new ApiError("invalid_reason", 400);
  const actor = sessionId(c);
  const result = await c.env.DB.prepare(
    "INSERT OR IGNORE INTO content_reports (room_id,session_id,reason,created_at) VALUES (?,?,?,?)",
  )
    .bind(id, actor, reason, nowSeconds())
    .run();
  if (!result.meta.changes) throw new ApiError("already_reported", 409);
  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM content_reports WHERE room_id = ?",
  )
    .bind(id)
    .first<{ count: number }>();
  if ((count?.count ?? 0) >= 3)
    await c.env.DB.prepare(
      "UPDATE rooms SET status = 'hidden',room_code = '00000',updated_at = ? WHERE id = ?",
    )
      .bind(nowSeconds(), id)
      .run();
  return c.json({ accepted: true }, 202);
});

app.patch("/api/rooms/:id/manage", async (c) => {
  enforceSameOrigin(c);
  const id = validateId(c.req.param("id"));
  const room = await managerRoom(c, id);
  const payload = objectPayload(await parseJson(c, 768));
  const keys = Object.keys(payload).sort();
  const current = nowSeconds();
  if (keys.length === 1 && keys[0] === "openSeats") {
    const openSeats = integerValue(payload, "openSeats", 1, 4);
    await c.env.DB.prepare(
      "UPDATE rooms SET open_seats = ?,status = 'active',updated_at = ? WHERE id = ?",
    )
      .bind(openSeats, current, id)
      .run();
    await recordEvent(c, "room_managed", id, room.creator_session_id);
    return c.json({ openSeats, status: "active" });
  }
  if (keys.length === 1 && keys[0] === "status") {
    const status = cleanText(payload, "status", 16);
    if (!new Set(["active", "closed", "full"]).has(status))
      throw new ApiError("invalid_status", 400);
    await c.env.DB.prepare("UPDATE rooms SET status = ?,updated_at = ? WHERE id = ?")
      .bind(status, current, id)
      .run();
    await recordEvent(c, "room_managed", id, room.creator_session_id);
    return c.json({ status });
  }
  if (keys.length === 1 && keys[0] === "extend" && payload.extend === true) {
    if (room.extensions >= 1) throw new ApiError("extension_used", 409);
    const expiresAt = extensionExpiry(room.created_at, current);
    if (expiresAt <= current) throw new ApiError("room_expired", 409);
    await c.env.DB.prepare(
      "UPDATE rooms SET expires_at = ?,extensions = 1,updated_at = ? WHERE id = ?",
    )
      .bind(expiresAt, current, id)
      .run();
    await recordEvent(c, "room_managed", id, room.creator_session_id);
    return c.json({ expiresAt, extensions: 1 });
  }
  throw new ApiError("invalid_request", 400);
});
app.delete("/api/rooms/:id", async (c) => {
  enforceSameOrigin(c);
  const id = validateId(c.req.param("id"));
  await managerRoom(c, id);
  await c.env.DB.prepare("DELETE FROM rooms WHERE id = ?").bind(id).run();
  return c.json({ deleted: true });
});

app.get("/health", (c) => c.json({ ok: true, service: "heya-to" }));
app.notFound(async (c) => {
  if (c.req.path.startsWith("/api/") || !/\.[a-z0-9]{2,8}$/iu.test(c.req.path)) {
    return c.html(
      <Layout
        canonical={canonicalOrigin + "/"}
        description="指定された募集灯は見つかりませんでした。"
        noindex
        title="消灯しました｜部屋灯"
      >
        <main class="not-found" id="main">
          <div class="dark-seats">
            {Array.from({ length: 5 }, () => (
              <i />
            ))}
          </div>
          <h1>この部屋は消灯しました。</h1>
          <a class="button-link" href="/">
            点灯中の部屋へ
          </a>
        </main>
      </Layout>,
      404,
    );
  }
  return c.env.ASSETS.fetch(c.req.raw);
});
app.onError((error, c) => {
  if (error instanceof ApiError)
    return c.json({ error: error.code, requestId: c.get("requestId") }, error.status);
  console.error("unhandled_error", {
    message: error instanceof Error ? error.message : String(error),
    requestId: c.get("requestId"),
  });
  return c.json({ error: "internal_error", requestId: c.get("requestId") }, 500);
});

export const scheduled: ExportedHandlerScheduledHandler<Bindings> = async (_event, env) => {
  const current = nowSeconds();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM rooms WHERE expires_at <= ?").bind(current - 3600),
    env.DB.prepare("DELETE FROM product_events WHERE created_at <= ?").bind(current - 35 * 86400),
  ]);
};

export { app, purposeLabels, ruleLabels };
export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Bindings>;
