const sessionKey = "heya_to_session";
const automatedQa =
  new URLSearchParams(window.location.search).get("qa") === "1" || navigator.webdriver === true;
const shell = document.querySelector("[data-room-id]");
const roomId = shell.dataset.roomId;
const mode = shell.dataset.mode;
const key = new URLSearchParams(window.location.hash.slice(1)).get("key") || "";
let room;

function sessionId() {
  if (automatedQa) return crypto.randomUUID();
  const existing = localStorage.getItem(sessionKey);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(sessionKey, created);
  return created;
}

const session = sessionId();

function headers(json = false, manager = false) {
  const value = { "X-Heya-QA": automatedQa ? "1" : "0", "X-Heya-Session": session };
  if (json) value["Content-Type"] = "application/json";
  if (manager) value["X-Heya-Key"] = key;
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

function replaceChildrenWithTextParts(target, values, className = "") {
  target.replaceChildren();
  for (const value of values) {
    const node = document.createElement("i");
    if (className) node.className = className;
    node.textContent = value;
    target.append(node);
  }
}

function render(nextRoom) {
  room = nextRoom;
  document.querySelector("[data-purpose]").textContent = room.purposeLabel;
  document.querySelector("[data-song]").textContent = room.song || room.purposeLabel;
  document.querySelector("[data-remaining]").textContent =
    room.status === "full"
      ? "満室で消灯しています"
      : `あと${room.openSeats}人・残り約${room.minutesRemaining}分`;
  replaceChildrenWithTextParts(document.querySelector("[data-code]"), [...room.roomCode]);

  const seats = document.querySelector("[data-seats]");
  [...seats.children].forEach((seat, index) => {
    seat.className = index === 0 ? "host" : index <= room.openSeats ? "open" : "filled";
  });

  document.querySelector("[data-minutes]").textContent = `${room.minutesRemaining} MIN`;
  [...document.querySelector("[data-time-rail]").children].forEach((tick, index) => {
    tick.classList.toggle("lit", index < Math.min(12, room.minutesRemaining));
  });
  document.querySelector("[data-host-bonus]").textContent = room.hostBonus ? room.hostBonus : "—";
  document.querySelector("[data-minimum-bonus]").textContent = room.minimumBonus
    ? room.minimumBonus
    : "—";
  document.querySelector("[data-rounds]").textContent = room.rounds ? room.rounds : "—";
  replaceChildrenWithTextParts(
    document.querySelector("[data-rules]"),
    room.ruleLabels,
    "rule-chip",
  );
  document.querySelector("[data-note]").textContent = room.note || "補足はありません。";
  document.querySelector("[data-open-seats]").value = String(room.openSeats);
  document.querySelector("[data-extend]").disabled = room.extensions >= 1;
  document.querySelector("[data-loading]").hidden = true;
  document.querySelector("[data-room-app]").hidden = false;
}

function message(selector, text) {
  document.querySelector(selector).textContent = text;
}

async function copyCode() {
  const result = await requestJson(`/api/rooms/${roomId}/copy`, {
    body: "{}",
    headers: headers(true),
    method: "POST",
  });
  await navigator.clipboard.writeText(result.roomCode);
  message("[data-action-message]", "5桁をコピーしました。");
}

document.querySelector("[data-copy]").addEventListener("click", () => {
  void copyCode().catch(() => message("[data-action-message]", "コピーできませんでした。"));
});

document.querySelector("[data-entered]").addEventListener("click", async (event) => {
  try {
    await requestJson(`/api/rooms/${roomId}/entered`, {
      body: "{}",
      headers: headers(true),
      method: "POST",
    });
    event.currentTarget.disabled = true;
    message("[data-action-message]", "入室できた合図を送りました。");
  } catch {
    message("[data-action-message]", "合図を送れませんでした。");
  }
});

document.querySelector("[data-full]").addEventListener("click", async () => {
  try {
    await requestJson(`/api/rooms/${roomId}/full`, {
      body: "{}",
      headers: headers(true),
      method: "POST",
    });
    message("[data-action-message]", "満室だった合図を送りました。募集主が確認できます。");
  } catch {
    message("[data-action-message]", "合図を送れませんでした。");
  }
});

document.querySelector("[data-share]").addEventListener("click", async () => {
  try {
    if (navigator.share) {
      await navigator.share({ title: "部屋灯", url: window.location.href.split("#")[0] });
    } else {
      await navigator.clipboard.writeText(window.location.href.split("#")[0]);
      message("[data-action-message]", "募集灯のURLをコピーしました。");
    }
  } catch {
    // 共有をキャンセルした場合は何もしません。
  }
});

document.querySelector("[data-report]").addEventListener("click", async () => {
  if (!window.confirm("個人情報、不正行為、迷惑な募集として報告しますか？")) return;
  try {
    await requestJson(`/api/rooms/${roomId}/report`, {
      body: JSON.stringify({ reason: "unsafe" }),
      headers: headers(true),
      method: "POST",
    });
    message("[data-action-message]", "報告を受け付けました。");
  } catch {
    message("[data-action-message]", "報告できませんでした。");
  }
});

async function manage(payload) {
  const result = await requestJson(`/api/rooms/${roomId}/manage`, {
    body: JSON.stringify(payload),
    headers: headers(true, true),
    method: "PATCH",
  });
  room = { ...room, ...result };
  return result;
}

document.querySelector("[data-save-seats]").addEventListener("click", async () => {
  try {
    const openSeats = Number(document.querySelector("[data-open-seats]").value);
    await manage({ openSeats });
    room.openSeats = openSeats;
    room.status = "active";
    render(room);
    message("[data-manager-message]", "残り席を更新しました。");
  } catch {
    message("[data-manager-message]", "残り席を更新できませんでした。");
  }
});

document.querySelector("[data-mark-full]").addEventListener("click", async () => {
  try {
    await manage({ status: "full" });
    room.status = "full";
    render(room);
    message("[data-manager-message]", "満室として消灯しました。");
  } catch {
    message("[data-manager-message]", "消灯できませんでした。");
  }
});

document.querySelector("[data-extend]").addEventListener("click", async (event) => {
  try {
    const result = await manage({ extend: true });
    room.extensions = result.extensions;
    room.expiresAt = result.expiresAt;
    event.currentTarget.disabled = true;
    message("[data-manager-message]", "募集灯を延長しました。");
  } catch (error) {
    message(
      "[data-manager-message]",
      error.code === "extension_used" ? "延長は1回までです。" : "延長できませんでした。",
    );
  }
});

document.querySelector("[data-delete]").addEventListener("click", async () => {
  if (!window.confirm("この募集灯を削除しますか？")) return;
  try {
    await requestJson(`/api/rooms/${roomId}`, {
      headers: headers(false, true),
      method: "DELETE",
    });
    window.location.replace("/");
  } catch {
    message("[data-manager-message]", "削除できませんでした。");
  }
});

async function load() {
  const manager = mode === "manage";
  if (manager && !key) throw new Error("missing_key");
  const result = await requestJson(
    manager ? `/api/rooms/${roomId}/manage` : `/api/rooms/${roomId}`,
    { headers: headers(false, manager) },
  );
  document.querySelector("[data-public-actions]").hidden = manager;
  document.querySelector("[data-manager-console]").hidden = !manager;
  render(result);
}

void load().catch(() => {
  document.querySelector("[data-loading] p").textContent =
    mode === "manage" ? "募集主の鍵を確認できませんでした。" : "この部屋は消灯しました。";
});
