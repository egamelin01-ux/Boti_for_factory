// Мостик между Telegram и Claude Code.
//
// Зачем он вообще: основной сервер стоит в России, откуда недоступны ни
// api.telegram.org, ни api.anthropic.com. Эта машина — в Европе, поэтому
// живёт здесь, а работу выполняет на боевом сервере по SSH.
//
// Библиотек для Telegram намеренно нет: всё общение — это два HTTP-запроса
// (getUpdates и sendMessage), ради них тащить зависимость и следить за её
// обновлениями незачем. В Node 22 fetch встроен.

import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID = String(process.env.TELEGRAM_OWNER_ID || "").trim();
const WORK_DIR = process.env.AGENT_WORK_DIR || "/opt/tg-agent/work";
const STATE_FILE = "/opt/tg-agent/state.json";
const PHOTOS_DIR = path.join(WORK_DIR, "photos");
const API = `https://api.telegram.org/bot${TOKEN}`;
const FILE_API = `https://api.telegram.org/file/bot${TOKEN}`;

// Telegram обрывает сообщения длиннее 4096 символов, режем с запасом.
const TG_LIMIT = 3900;
const TYPING_EVERY_MS = 4000;
const CLAUDE_TIMEOUT_MS = 20 * 60 * 1000;
// Контекст по умолчанию, когда пользователь не переключался командой /ctx.
const DEFAULT_CTX = "общее";

if (!TOKEN || !OWNER_ID) {
  console.error("Не заданы TELEGRAM_BOT_TOKEN и/или TELEGRAM_OWNER_ID");
  process.exit(1);
}

// ---- Состояние ---------------------------------------------------------
// Несколько именованных разговоров одновременно: каждый помнит свою историю
// (свой session_id Клода) независимо от других. current — тот, в котором
// сейчас находится пользователь; contexts — все, что когда-либо создавались.
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (raw.contexts) return raw;
    // Старый формат (один sessionId без имени) — переносим как контекст по умолчанию.
    return { current: DEFAULT_CTX, contexts: { [DEFAULT_CTX]: { sessionId: raw.sessionId || null } } };
  } catch {
    return { current: DEFAULT_CTX, contexts: { [DEFAULT_CTX]: { sessionId: null } } };
  }
}
function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn("не смог сохранить состояние:", e.message);
  }
}
function currentCtx(state) {
  if (!state.contexts[state.current]) state.contexts[state.current] = { sessionId: null };
  return state.contexts[state.current];
}

// ---- Telegram ------------------------------------------------------------
async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${method}: ${data.description || res.status}`);
  return data.result;
}

async function send(chatId, text) {
  const chunks = [];
  let cur = "";
  for (const line of String(text).split("\n")) {
    if ((cur + line).length > TG_LIMIT) {
      if (cur) chunks.push(cur);
      for (let i = 0; i < line.length; i += TG_LIMIT) chunks.push(line.slice(i, i + TG_LIMIT));
      cur = "";
    } else {
      cur += (cur ? "\n" : "") + line;
    }
  }
  if (cur) chunks.push(cur);
  for (const c of chunks) {
    await tg("sendMessage", { chat_id: chatId, text: c }).catch((e) =>
      console.error("отправка не удалась:", e.message)
    );
  }
}

// ---- Скачивание фото -----------------------------------------------------
// Claude Code умеет смотреть на файлы изображений напрямую (тем же
// инструментом, что читает код) — достаточно скачать фото на диск и
// упомянуть путь к нему в тексте задачи, отдельного сервиса распознавания
// не нужно.
const PHOTO_KEEP_DAYS = 7;

// Диск на сервере маленький — не копим скриншоты бесконечно.
function cleanupOldPhotos() {
  const cutoff = Date.now() - PHOTO_KEEP_DAYS * 24 * 60 * 60 * 1000;
  let names = [];
  try {
    names = fs.readdirSync(PHOTOS_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    const p = path.join(PHOTOS_DIR, name);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    } catch {}
  }
}

async function downloadPhoto(fileId, updateId) {
  const info = await tg("getFile", { file_id: fileId });
  const ext = path.extname(info.file_path) || ".jpg";
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });
  cleanupOldPhotos();
  const dest = path.join(PHOTOS_DIR, `${updateId}${ext}`);
  const res = await fetch(`${FILE_API}/${info.file_path}`);
  if (!res.ok) throw new Error(`скачивание фото: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return dest;
}

// ---- Claude ----------------------------------------------------------
/** Расшифровка отказа Claude Code в человеческие слова.
 *
 *  Бот ходит по подписке (CLAUDE_CODE_OAUTH_TOKEN), а не по ключу API. У этого
 *  два отказа, которые выглядят как обычная ошибка, но требуют разных действий:
 *  протухший токен чинится повторным входом, а упёршийся лимит — ожиданием.
 *  Без расшифровки в чат прилетало «Claude завершился с кодом 1» и сырой вывод,
 *  по которому не понять ни причины, ни что делать.
 */
function describeClaudeFailure(raw) {
  const t = String(raw || "");
  if (/rate.?limit|429|usage limit|quota|limit reached|too many requests/i.test(t)) {
    return (
      "Упёрлись в лимит подписки Claude.\n" +
      "Бот снова заработает, когда окно лимита сбросится — обычно через несколько часов.\n" +
      "Делать ничего не нужно, просто напишите позже."
    );
  }
  if (
    /oauth|unauthorized|401|403|authentication|invalid.*(token|api key)|expired|please (run )?.*login|not logged in/i.test(t)
  ) {
    return (
      "Claude не пускает: вход по подписке больше не действует.\n\n" +
      "Чинится так — зайти на сервер бота и выполнить:\n" +
      "  ssh -i ~/.ssh/content_ceh_ed25519 root@157.228.142.176\n" +
      "  claude setup-token\n\n" +
      "Полученный токен вписать в /opt/tg-agent/.env вместо строки " +
      "CLAUDE_CODE_OAUTH_TOKEN и перезапустить: systemctl restart tg-agent"
    );
  }
  return null;
}

function runClaude(prompt, sessionId) {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--output-format", "json"];
    if (sessionId) args.push("--resume", sessionId);

    const proc = spawn("claude", args, {
      cwd: WORK_DIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ text: "Задача выполнялась больше 20 минут и была остановлена.", sessionId });
    }, CLAUDE_TIMEOUT_MS);

    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({ text: `Не смог запустить claude: ${e.message}`, sessionId });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) {
        const human = describeClaudeFailure(err);
        resolve({
          text: human || `Claude завершился с кодом ${code}.\n${err.slice(-1500)}`,
          sessionId,
        });
        return;
      }
      try {
        const data = JSON.parse(out);
        const human = data.is_error ? describeClaudeFailure(data.result || out) : null;
        resolve({
          text: human || data.result || "(пустой ответ)",
          sessionId: data.session_id || sessionId,
        });
      } catch {
        resolve({ text: out.trim() || err.slice(-1500) || "(пустой ответ)", sessionId });
      }
    });
  });
}

// ---- Основной цикл ---------------------------------------------------
let state = loadState();
saveState(state);
let busy = false;

function listContexts(state) {
  const names = Object.keys(state.contexts);
  return names.map((n) => (n === state.current ? `→ ${n}` : `  ${n}`)).join("\n");
}

async function handle(chatId, text) {
  if (text === "/start") {
    await send(
      chatId,
      "На связи. Пишите задачу — выполню на сервере и отвечу.\n\n" +
        `Сейчас в разговоре «${state.current}».\n\n` +
        "/ctx имя — переключиться на разговор с этим именем (создаст новый, если такого не было)\n" +
        "/ctx — список всех разговоров\n" +
        "/new — забыть историю текущего разговора\n" +
        "/id — показать ваш Telegram-идентификатор"
    );
    return;
  }
  if (text === "/id") {
    await send(chatId, `Ваш идентификатор: ${chatId}`);
    return;
  }
  if (text === "/new") {
    currentCtx(state).sessionId = null;
    saveState(state);
    await send(chatId, `Разговор «${state.current}» начат заново — прошлый контекст забыт.`);
    return;
  }
  if (text === "/ctx" || text.startsWith("/ctx ")) {
    const name = text.slice(4).trim();
    if (!name) {
      await send(chatId, `Разговоры:\n${listContexts(state)}\n\nЧтобы переключиться: /ctx имя`);
      return;
    }
    const isNew = !state.contexts[name];
    state.current = name;
    currentCtx(state);
    saveState(state);
    await send(chatId, isNew ? `Начал новый разговор «${name}».` : `Переключился на «${name}».`);
    return;
  }

  if (busy) {
    await send(chatId, "Ещё занят предыдущей задачей — допишу и возьмусь за эту.");
    return;
  }

  busy = true;
  const typing = setInterval(
    () => tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}),
    TYPING_EVERY_MS
  );
  tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});

  try {
    const ctx = currentCtx(state);
    const res = await runClaude(text, ctx.sessionId);
    if (res.sessionId && res.sessionId !== ctx.sessionId) {
      ctx.sessionId = res.sessionId;
      saveState(state);
    }
    await send(chatId, res.text);
  } catch (e) {
    await send(chatId, `Сбой: ${e.message}`);
  } finally {
    clearInterval(typing);
    busy = false;
  }
}

async function main() {
  const me = await tg("getMe", {});
  console.log(`бот запущен: @${me.username}`);

  let offset = 0;
  try {
    const pending = await tg("getUpdates", { timeout: 0, offset: -1 });
    if (pending.length) offset = pending[pending.length - 1].update_id + 1;
  } catch {}

  for (;;) {
    let updates = [];
    try {
      updates = await tg("getUpdates", { timeout: 50, offset });
    } catch (e) {
      console.error("getUpdates:", e.message);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      const msg = u.message;
      if (!msg) continue;
      const from = String(msg.from?.id || "");
      if (from !== OWNER_ID) {
        console.warn(`чужое сообщение от ${from}, игнорирую`);
        continue;
      }

      if (msg.photo?.length) {
        // Telegram присылает несколько размеров одного и того же фото —
        // берём последний (самый крупный).
        const best = msg.photo[msg.photo.length - 1];
        try {
          const filePath = await downloadPhoto(best.file_id, u.update_id);
          const caption = (msg.caption || "").trim();
          const prompt = caption
            ? `${caption}\n\nСкриншот: ${filePath}`
            : `Посмотри на скриншот и разберись, что с ним делать: ${filePath}`;
          await handle(msg.chat.id, prompt);
        } catch (e) {
          await send(msg.chat.id, `Не смог скачать фото: ${e.message}`);
        }
        continue;
      }

      if (!msg.text) continue;
      await handle(msg.chat.id, msg.text.trim());
    }
  }
}

main().catch((e) => {
  console.error("бот упал:", e);
  process.exit(1);
});
