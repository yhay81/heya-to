const sessionKey = "heya_to_session";
const seenKey = "heya_to_seen";
const automatedQa =
  new URLSearchParams(window.location.search).get("qa") === "1" || navigator.webdriver === true;

function sessionId() {
  if (automatedQa) return crypto.randomUUID();
  const existing = localStorage.getItem(sessionKey);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(sessionKey, created);
  return created;
}

const session = sessionId();

function headers(json = false) {
  const value = { "X-Heya-QA": automatedQa ? "1" : "0", "X-Heya-Session": session };
  if (json) value["Content-Type"] = "application/json";
  return value;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || "request_failed");
    error.code = body.error || "request_failed";
    throw error;
  }
  return body;
}

async function recordEvent(name) {
  try {
    await fetch("/api/telemetry", {
      body: JSON.stringify({ name }),
      headers: headers(true),
      keepalive: true,
      method: "POST",
    });
  } catch {
    // 計測できない場合も募集盤は利用できます。
  }
}

const errorMessages = {
  create_rate_limited: "15分に作れる募集灯は3件までです。少し待ってください。",
  room_already_lit: "同じ5桁の募集灯がすでに点いています。",
  invalid_hostBonus: "主の実効値は0〜999で入力してください。",
  invalid_minimumBonus: "募集の実効値は0〜999で入力してください。",
  invalid_note: "ひとことは100文字以内で入力してください。",
  invalid_openSeats: "残り席を1〜4人から選んでください。",
  invalid_roomCode: "ルーム番号は半角数字5桁で入力してください。",
  invalid_rounds: "予定回数は0〜99で入力してください。",
  invalid_song: "曲・周回名は40文字以内で入力してください。",
  unsafe_note: "ひとことに連絡先、外部URL、不正行為は書けません。",
  unsafe_song: "曲・周回名に連絡先、外部URL、不正行為は書けません。",
};

const createButton = document.querySelector("[data-open-create]");
const form = document.querySelector("[data-create-form]");

createButton?.addEventListener("click", () => {
  document.querySelector("#create-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  form?.elements.roomCode.focus({ preventScroll: true });
});

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = form.querySelector('button[type="submit"]');
  const message = form.querySelector("[data-form-message]");
  message.textContent = "";
  submit.disabled = true;
  submit.textContent = "募集灯を点検中…";
  try {
    const result = await requestJson("/api/rooms", {
      body: JSON.stringify({
        hostBonus: Number(form.elements.hostBonus.value),
        minimumBonus: Number(form.elements.minimumBonus.value),
        note: form.elements.note.value,
        openSeats: Number(form.elements.openSeats.value),
        purpose: form.elements.purpose.value,
        roomCode: form.elements.roomCode.value,
        rounds: Number(form.elements.rounds.value),
        rules: [...form.querySelectorAll('input[name="rules"]:checked')].map(
          (input) => input.value,
        ),
        song: form.elements.song.value,
        website: form.elements.website.value,
      }),
      headers: headers(true),
      method: "POST",
    });
    message.textContent = "募集灯を点けました。募集主の操作盤へ移動します。";
    window.location.assign(result.manageUrl);
  } catch (error) {
    message.textContent =
      errorMessages[error.code] ||
      "募集灯を点けられませんでした。入力と通信状態を確認してください。";
    submit.disabled = false;
    submit.textContent = "12分の募集灯を点ける";
  }
});

for (const button of document.querySelectorAll("[data-copy-code]")) {
  button.addEventListener("click", async () => {
    try {
      const result = await requestJson(`/api/rooms/${button.dataset.roomId}/copy`, {
        body: "{}",
        headers: headers(true),
        method: "POST",
      });
      await navigator.clipboard.writeText(result.roomCode);
      button.textContent = "コピーしました";
      setTimeout(() => {
        button.textContent = "5桁をコピー";
      }, 1800);
    } catch {
      button.textContent = "コピーできませんでした";
    }
  });
}

if (new URLSearchParams(window.location.search).has("purpose")) void recordEvent("board_filtered");
void recordEvent("visited");
if (!automatedQa && localStorage.getItem(seenKey) === "1") void recordEvent("returned");
if (!automatedQa) localStorage.setItem(seenKey, "1");
