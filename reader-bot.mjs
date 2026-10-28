// Читатель рабочих чатов: складывает переписку и напоминает владельцу, когда
// его о чём-то спросили, а он не ответил.
//
// Версия 1 — ТОЛЬКО ЧТЕНИЕ. Бот никогда ничего не пишет в групповые чаты:
// единственный адресат исходящих — личка владельца (TELEGRAM_OWNER_ID).
// Ответы за владельца планируются отдельным этапом и сознательно не заложены
// даже заготовкой: пока в коде нет ни одного вызова sendMessage в группу,
// случайно «заговорить» в клиентском чате бот не может.
//
// Какие чаты читает — определяется тем, куда его добавили: у бота снят режим
// приватности, поэтому в группе он видит все сообщения, но только там, где он
// состоит. Отдельного списка чатов нет намеренно: список — это сам факт
// добавления, и владелец управляет им из Telegram, а не правкой конфига.

import fs from "fs";
import http from "http";

const TOKEN = process.env.READER_BOT_TOKEN;
const OWNER_ID = String(process.env.TELEGRAM_OWNER_ID || "").trim();
// Как понять, что «пинг» адресован владельцу: ответ на его сообщение или
// упоминание его @username. Без этого пришлось бы считать пингом любое
// сообщение в чате, а это шум.
const OWNER_USERNAME = String(process.env.READER_OWNER_USERNAME || "")
  .replace(/^@/, "")
  .toLowerCase();
// Аварийный режим на случай, если распознавание пингов окажется слишком узким:
// считать пингом любое чужое сообщение в чате.
const PING_ALL = process.env.READER_PING_ALL === "1";
// Мост для портала: приём «отправь сотруднику личное сообщение». Портал сам
// до Telegram не достаёт (с боевого сервера api.telegram.org закрыт),
// поэтому шлёт сюда, а бот доносит.
const STAFF_API_PORT = Number(process.env.ASSISTANT_API_PORT || 8788);
const STAFF_API_SECRET = process.env.ASSISTANT_API_SECRET || "";
// Куда подтверждать привязку сотрудника: /start <код> из лички уходит на
// портал, у которого этот код и лежит.
const PORTAL_WEBHOOK_URL = process.env.PORTAL_WEBHOOK_URL || "";

const STATE_FILE = "/opt/tg-agent/reader-state.json";
const LOG_FILE = "/opt/tg-agent/reader-log.ndjson";
const MUTED_FILE = "/opt/tg-agent/muted-chats.json";
const MEDIA_DIR = "/opt/tg-agent/media";
const API = `https://api.telegram.org/bot${TOKEN}`;

// «После пинга продюсера дергай меня через 1,5 часа» — владелец, 04.09.2026.
const PING_DELAY_MS = 90 * 60 * 1000;
// «22:00–09:00 МСК — тихие». Всё, что созрело ночью, ждёт девяти утра.
const QUIET_FROM_MSK = 22;
const QUIET_TO_MSK = 9;

if (!TOKEN || !OWNER_ID) {
  console.error("Не заданы READER_BOT_TOKEN и/или TELEGRAM_OWNER_ID");
  process.exit(1);
}

/** Час по Москве. Машина живёт в UTC, МСК = UTC+3. */
function mskHour(now = new Date()) {
  return new Date(now.getTime() + 3 * 60 * 60 * 1000).getUTCHours();
}

function isQuiet(now = new Date()) {
  const h = mskHour(now);
  return h >= QUIET_FROM_MSK || h < QUIET_TO_MSK;
}

// ---- Состояние -----------------------------------------------------------
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { offset: 0, chats: {} };
  }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

const state = loadState();

// ---- Telegram ------------------------------------------------------------
async function tg(method, body) {
  const r = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(`${method}: ${d.description}`);
  return d.result;
}

/** Единственный способ что-то отправить. Адресат зашит — личка владельца. */
async function dm(text) {
  await tg("sendMessage", {
    chat_id: OWNER_ID,
    text,
    disable_web_page_preview: true,
  }).catch((e) => console.error("dm:", e.message));
}

// ---- Вложения ------------------------------------------------------------
/** Что в сообщении, кроме текста. Голосовые и скриншоты с правками — это
 *  половина рабочей переписки: клиент присылает кружок вместо трёх абзацев
 *  или скрин с обведённым кадром. Ссылка на файл в Telegram живёт не вечно,
 *  поэтому файл забираем себе сразу, а расшифровку и разбор делаем потом. */
function describeMedia(m) {
  const pick = (kind, o, extra = {}) =>
    o && {
      kind,
      file_id: o.file_id,
      file_unique_id: o.file_unique_id,
      size: o.file_size ?? null,
      mime: o.mime_type ?? null,
      ...extra,
    };
  if (m.voice) return pick("voice", m.voice, { duration: m.voice.duration });
  if (m.video_note) return pick("video_note", m.video_note, { duration: m.video_note.duration });
  if (m.audio) return pick("audio", m.audio, { duration: m.audio.duration, name: m.audio.file_name ?? null });
  if (m.photo?.length) return pick("photo", m.photo[m.photo.length - 1]); // последняя — самая крупная
  if (m.video) return pick("video", m.video, { duration: m.video.duration });
  if (m.document) return pick("document", m.document, { name: m.document.file_name ?? null });
  if (m.sticker) return pick("sticker", m.sticker);
  return null;
}

const EXT = {
  voice: "ogg", video_note: "mp4", audio: "mp3", photo: "jpg",
  video: "mp4", document: "bin", sticker: "webp",
};

/** Скачиваем по одному, в фоне: очередь не даёт голосовым и картинкам
 *  выстроиться в параллель и съесть память на маленькой машине. */
const downloadQueue = [];
let downloading = false;

function enqueueMedia(row) {
  if (!row.media?.file_id) return;
  if (row.media.kind === "sticker") return; // стикеры нам ничего не говорят
  downloadQueue.push(row);
  if (!downloading) void drainQueue();
}

async function drainQueue() {
  downloading = true;
  while (downloadQueue.length) {
    const row = downloadQueue.shift();
    try {
      await saveMedia(row);
    } catch (e) {
      console.error(`вложение ${row.media.kind} из ${row.chat_id}:`, e.message);
    }
  }
  downloading = false;
}

async function saveMedia(row) {
  const info = await tg("getFile", { file_id: row.media.file_id });
  const ext = (info.file_path?.split(".").pop() || EXT[row.media.kind] || "bin").toLowerCase();
  const dir = `${MEDIA_DIR}/${row.chat_id}`;
  fs.mkdirSync(dir, { recursive: true });
  const dest = `${dir}/${row.message_id}-${row.media.file_unique_id}.${ext}`;
  if (fs.existsSync(dest)) return;

  const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${info.file_path}`);
  if (!r.ok) throw new Error(`скачивание: HTTP ${r.status}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));

  // Отмечаем в журнале, где лежит файл: журнал — единственное место, по
  // которому помощник потом восстановит переписку целиком.
  fs.appendFileSync(
    LOG_FILE,
    JSON.stringify({
      ts: new Date().toISOString(),
      chat_id: row.chat_id,
      message_id: row.message_id,
      event: "media_saved",
      kind: row.media.kind,
      path: dest,
      duration: row.media.duration ?? null,
    }) + "\n",
  );
  console.log(`сохранено вложение ${row.media.kind}: ${dest}`);
}

// ---- Журнал --------------------------------------------------------------
/** Пишем всё подряд построчно: разбирать переписку задним числом проще по
 *  сырым данным, чем по тому, что мы сочли важным в момент приёма. */
function logMessage(m) {
  const row = {
    ts: new Date((m.date || 0) * 1000).toISOString(),
    chat_id: m.chat?.id,
    chat_title: m.chat?.title || m.chat?.username || null,
    chat_type: m.chat?.type,
    message_id: m.message_id,
    from_id: m.from?.id,
    from: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") || null,
    username: m.from?.username || null,
    text: m.text || m.caption || null,
    reply_to_id: m.reply_to_message?.message_id || null,
    reply_to_from_id: m.reply_to_message?.from?.id || null,
    media: describeMedia(m),
  };
  fs.appendFileSync(LOG_FILE, JSON.stringify(row) + "\n");
  return row;
}

// ---- Разбор ---------------------------------------------------------------
function isOwner(m) {
  return String(m.from?.id || "") === OWNER_ID;
}

/** Пинг — это когда обращаются к владельцу: ответом на его сообщение или
 *  упоминанием. Свои же сообщения пингом не считаем никогда. */
function isPing(m) {
  if (isOwner(m)) return false;
  if (PING_ALL) return true;
  if (String(m.reply_to_message?.from?.id || "") === OWNER_ID) return true;
  const text = (m.text || m.caption || "").toLowerCase();
  if (OWNER_USERNAME && text.includes("@" + OWNER_USERNAME)) return true;
  return false;
}

/** Признак состоявшейся встречи — ссылка на созвон в чате. Правило владельца
 *  (05.09.2026): встреча считается прошедшей через 3 часа после ссылки, и к
 *  этому моменту продюсер должен подвести итог со следующими шагами и сроками.
 *  Судить, подведён ли итог, будет помощник — здесь только фиксируем событие,
 *  потому что Telegram не отдаёт боту переписку задним числом: не поймали в
 *  момент — потеряли навсегда. Ловим и соседние сервисы: правило написано про
 *  зум, но созвон в Телемосте или Meet — та же встреча, а стоит это ноль. */
const MEETING_RE =
  /(zoom\.us\/j\/|zoom\.us\/my\/|\.zoom\.us\/|meet\.google\.com\/|telemost\.yandex\.|meet\.jit\.si\/|teams\.microsoft\.com\/l\/meetup)/i;

function chatState(id) {
  const key = String(id);
  if (!state.chats[key]) state.chats[key] = { pending: null, title: null };
  return state.chats[key];
}

function snippet(text, n = 200) {
  if (!text) return "(без текста)";
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/** Чаты закрытых проектов: список ведёт сверка, мы его только перечитываем.
 *  Проверяем время правки, а не читаем файл каждый раз, — сообщений много,
 *  а меняется список раз в сутки. */
let mutedCache = { mtime: 0, set: new Set() };
function isMuted(chatId) {
  try {
    const mtime = fs.statSync(MUTED_FILE).mtimeMs;
    if (mtime !== mutedCache.mtime) {
      const raw = JSON.parse(fs.readFileSync(MUTED_FILE, "utf8"));
      mutedCache = { mtime, set: new Set(Object.keys(raw)) };
      console.log(`список молчания обновлён: ${mutedCache.set.size} чатов`);
    }
  } catch {
    // Файла ещё нет — значит, молчать не о чем.
  }
  return mutedCache.set.has(String(chatId));
}

/** Кнопка «Подключить …» на портале — ссылка startgroup: в веб-версии
 *  Telegram она открывает список групп. Приложение Telegram на компьютере
 *  так не умеет: приводит в личку с ботом и шлёт «/start <id проекта>».
 *  Тогда объясняем картинкой, как открыть ссылку в вебе (решение владельца
 *  28.10.2026: подключать ботов только через веб-версию). */
const PROJECT_ID_RE = /^c[a-z0-9]{20,32}$/;
const CONNECT_PICTURE = "/opt/tg-agent/connect-via-web.jpg";
const CONNECT_CAPTION =
  "Подключите меня через веб-версию Telegram (в браузере). Для этого нажмите то, что на картинке: " +
  "в окне «Открыть приложение Telegram?» — «Отмена» (1), затем «Open in Web» (2) и выберите чат клиента.";
let connectPictureId = null;
async function sendConnectHelp(chatId) {
  // Картинку загружаем один раз, дальше шлём по file_id.
  if (connectPictureId) {
    await tg("sendPhoto", { chat_id: chatId, photo: connectPictureId, caption: CONNECT_CAPTION });
    return;
  }
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", CONNECT_CAPTION);
  form.append("photo", new Blob([fs.readFileSync(CONNECT_PICTURE)], { type: "image/jpeg" }), "connect-via-web.jpg");
  const r = await fetch(`${API}/sendPhoto`, { method: "POST", body: form });
  const d = await r.json();
  if (!d.ok) throw new Error(`sendPhoto: ${d.description}`);
  connectPictureId = d.result.photo?.at(-1)?.file_id ?? null;
}

function handleMessage(m) {
  if (!m || !m.chat) return;
  // Проект закрыт — переписку в его чате не храним и напоминаний по ней не
  // делаем. Личку владельца это не касается: там нет проекта.
  if (m.chat.type !== "private" && isMuted(m.chat.id)) return;
  const row = logMessage(m);
  enqueueMedia(row);
  const cs = chatState(m.chat.id);
  cs.title = row.chat_title;

  // Сотрудник привязывает свой аккаунт к порталу: в личке приходит
  // «/start <код>» по ссылке из настроек. Код проверяет портал — он его и
  // выдал; бот только передаёт и сообщает результат человеку.
  const priv = m.chat.type === "private" && (row.text || "").match(/^\/start\s+(\S+)/);
  if (priv && PROJECT_ID_RE.test(priv[1])) {
    void sendConnectHelp(m.chat.id).catch((e) => console.error("подсказка подключения:", e.message));
    return;
  }
  if (priv) {
    void confirmStaffLink(priv[1], m.chat.id);
    return;
  }

  // Кнопка «Подключить ассистента» на странице проекта приводит бота в чат с
  // «/start <id проекта>» — берём привязку сразу, чтобы не выяснять её потом
  // сверкой по названиям.
  const start = (row.text || "").match(/^\/start(?:@\S+)?\s+(\S+)/);
  if (start && m.chat.type !== "private" && !cs.projectId) {
    cs.projectId = start[1];
    console.log(`чат «${cs.title || m.chat.id}» привязан к проекту ${cs.projectId}`);
    saveState(state);
  }

  // Встречу фиксируем от кого угодно: ссылку может кинуть и клиент.
  if (MEETING_RE.test(row.text || "")) {
    cs.meetings = cs.meetings || [];
    cs.meetings.push({
      at: row.ts,
      by: row.from || row.username || null,
      message_id: row.message_id,
      // Через 3 часа после ссылки встреча считается прошедшей — с этого
      // момента ждём от продюсера итог со сроками.
      summaryDueAt: new Date(Date.parse(row.ts) + 3 * 60 * 60 * 1000).toISOString(),
      summarized: null, // решает помощник, когда он появится
    });
    console.log(`встреча: чат «${cs.title || m.chat.id}», ссылка в ${row.ts}`);
  }

  // Владелец ответил сам — напоминать не о чем.
  if (isOwner(m)) {
    cs.pending = null;
    return;
  }
  // Уже висит неотвеченный пинг — не сдвигаем срок на каждое новое сообщение,
  // иначе в живом чате напоминание не наступит никогда.
  if (cs.pending) return;

  if (isPing(m)) {
    cs.pending = {
      since: Date.now(),
      from: row.from || row.username || "коллега",
      text: row.text
        ? snippet(row.text)
        : row.media
          ? `[${row.media.kind}${row.media.duration ? `, ${row.media.duration} с` : ""}]`
          : snippet(null),
      message_id: row.message_id,
    };
  }
}

/** Бота добавили в чат или убрали из него. Ведём список присутствия, чтобы
 *  было с чем сверять привязки напоминалки. */
function handleMembership(ev) {
  const chat = ev.chat || {};
  const status = ev.new_chat_member?.status;
  const inChat = status === "member" || status === "administrator";
  const cs = chatState(chat.id);
  cs.title = chat.title || chat.username || cs.title;
  cs.present = inChat;
  cs.membershipAt = new Date().toISOString();
  console.log(
    `${inChat ? "добавлен в чат" : "убран из чата"}: «${cs.title || chat.id}» (${chat.id})`,
  );
  saveState(state);
}

/** Созревшие напоминания. В тихие часы копятся и уходят утром одним письмом. */
async function flushReminders() {
  if (isQuiet()) return;
  const now = Date.now();
  const due = [];
  for (const [id, cs] of Object.entries(state.chats)) {
    if (!cs.pending) continue;
    if (now - cs.pending.since < PING_DELAY_MS) continue;
    due.push({ id, cs });
  }
  if (!due.length) return;

  for (const { cs } of due) {
    const waited = Math.round((now - cs.pending.since) / 60000);
    await dm(
      `Ждут ответа ${waited} мин — «${cs.title || "чат"}»\n` +
        `${cs.pending.from}: ${cs.pending.text}`,
    );
    // Напоминаем один раз: повторы каждые полтора часа быстро превращаются
    // в фон, который перестают читать.
    cs.pending = null;
  }
  saveState(state);
}

/** Подтвердить привязку сотрудника на портале и ответить человеку.
 *  Портал отвечает { linked: true/false } — по нему и текст ответа. */
async function confirmStaffLink(code, chatId) {
  if (!PORTAL_WEBHOOK_URL) {
    console.error("привязка сотрудника: PORTAL_WEBHOOK_URL не задан");
    return;
  }
  let linked = false;
  try {
    const r = await fetch(PORTAL_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { text: `/start ${code}`, chat: { id: chatId } } }),
    });
    const d = await r.json().catch(() => ({}));
    linked = d.linked === true;
  } catch (e) {
    console.error("привязка сотрудника:", e.message);
  }
  await tg("sendMessage", {
    chat_id: chatId,
    text: linked
      ? "Готово: аккаунт привязан к порталу. Сюда будут приходить ваши задачи."
      : "Код не подошёл или уже использован. Откройте «Настройки → Telegram» на портале и попробуйте по свежей ссылке.",
  }).catch((e) => console.error("ответ о привязке:", e.message));
}

/** Мост для портала: личные сообщения сотрудникам.
 *
 *  Принимаются ТОЛЬКО положительные chat_id — это лички. Групповые id у
 *  Telegram отрицательные, и этот отказ держит главное обещание бота:
 *  в чаты клиентов он не пишет, каким бы путём его ни попросили. */
function startStaffApi() {
  if (!STAFF_API_SECRET) {
    console.error("мост для портала выключен: ASSISTANT_API_SECRET не задан");
    return;
  }
  const server = http.createServer((req, res) => {
    const reply = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "GET" && req.url === "/health") return reply(200, { ok: true });
    if (req.method !== "POST" || req.url !== "/send-user") return reply(404, { error: "нет такого пути" });
    if (req.headers["x-assistant-secret"] !== STAFF_API_SECRET) return reply(403, { error: "нет доступа" });
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 16384) req.destroy();
    });
    req.on("end", async () => {
      try {
        const body = JSON.parse(raw || "{}");
        const chatId = Number(body.chatId);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!Number.isFinite(chatId) || chatId <= 0) {
          return reply(400, { error: "chatId должен быть личным (положительным)" });
        }
        if (!text || text.length > 4000) return reply(400, { error: "нет текста" });
        // Разметку принимаем только HTML и только по явной просьбе портала.
        const parseMode = body.parseMode === "HTML" ? "HTML" : null;
        try {
          await tg("sendMessage", {
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
            ...(parseMode ? { parse_mode: parseMode } : {}),
          });
        } catch (e) {
          // Ошибка разметки не должна съедать уведомление: одна незакрытая
          // скобка в комментарии клиента — и человек не узнал бы о задаче.
          // Повторяем без разметки, сняв теги.
          if (!parseMode) throw e;
          console.error("разметка не прошла, шлю обычным текстом:", e.message);
          await tg("sendMessage", {
            chat_id: chatId,
            text: text.replace(/<[^>]+>/g, ""),
            disable_web_page_preview: true,
          });
        }
        reply(200, { ok: true });
      } catch (e) {
        reply(502, { error: e.message });
      }
    });
  });
  server.listen(STAFF_API_PORT, () =>
    console.log(`мост для портала слушает :${STAFF_API_PORT}`),
  );
}

// ---- Основной цикл --------------------------------------------------------
async function main() {
  startStaffApi();
  const me = await tg("getMe", {});
  console.log(
    `Читатель запущен: @${me.username}, приватность снята: ${me.can_read_all_group_messages}`,
  );
  if (!me.can_read_all_group_messages) {
    console.error(
      "ВНИМАНИЕ: у бота включён режим приватности — в группах он увидит только " +
        "команды и ответы себе. Снимается у @BotFather: /setprivacy → Disable.",
    );
  }

  for (;;) {
    let updates = [];
    try {
      updates = await tg("getUpdates", {
        timeout: 30,
        offset: state.offset,
        // my_chat_member по умолчанию не приходит. Он нужен, чтобы знать, в
        // каких чатах бот вообще состоит: этот список сверяется с привязками
        // бота-напоминалки, и расхождение означает «сюда читателя забыли
        // добавить». Иначе про такой чат мы узнаем, только когда там кто-то
        // напишет — то есть уже потеряв часть переписки.
        allowed_updates: ["message", "edited_message", "my_chat_member"],
      });
    } catch (e) {
      console.error("getUpdates:", e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }

    for (const u of updates) {
      state.offset = u.update_id + 1;
      try {
        if (u.my_chat_member) handleMembership(u.my_chat_member);
        else handleMessage(u.message || u.edited_message);
      } catch (e) {
        console.error("разбор:", e.message);
      }
    }
    if (updates.length) saveState(state);

    await flushReminders().catch((e) => console.error("напоминания:", e.message));
  }
}

main().catch((e) => {
  console.error("упал:", e.message);
  process.exit(1);
});
