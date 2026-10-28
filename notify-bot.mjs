// Ежедневные напоминания клиентам в их Telegram-чатах: сколько материалов
// ждёт согласования на платформе, со ссылкой на кабинет.
//
// Это ОТДЕЛЬНЫЙ бот, не агент. Он живёт в клиентских чатах, поэтому нарочно
// не умеет ничего, кроме напоминаний: у него нет доступа к Claude, а к
// боевому серверу он ходит только за цифрами (скрипт notify-digest.mjs,
// чтение базы). Агентский бот с полным доступом в чаты клиентов не входит.
//
// Рассылка отсюда, а не с боевого сервера, потому что с того Telegram
// недоступен вовсе — провайдер не пропускает.

import { spawn } from "child_process";
import fs from "fs";
import http from "http";

const TOKEN = process.env.NOTIFY_BOT_TOKEN;
const OWNER_ID = String(process.env.TELEGRAM_OWNER_ID || "").trim();
const STATE_FILE = "/opt/tg-agent/notify-state.json";
const API = `https://api.telegram.org/bot${TOKEN}`;

const PROD_SSH = ["root@194.67.92.177"];
const DIGEST_CMD = "cd /opt/content-ceh && node deploy/notify-digest.mjs";

// 07:00 UTC = 10:00 по Москве — утро, но не раннее.
const DIGEST_HOUR_UTC = 7;

/** Напоминание — это просьба к живому человеку, поэтому шлём только тогда,
 *  когда он на работе: по будням и не в новогодние каникулы. День недели и
 *  дату считаем по Москве, а не по UTC: в 10:00 МСК ещё идут московские
 *  сутки, а в UTC — те же, но у границы, и на 1 января расхождение сыграло бы. */
function isWorkingMoment(now = new Date()) {
  const msk = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const day = msk.getUTCDay(); // 0 — воскресенье, 6 — суббота
  if (day === 0 || day === 6) return false;

  const month = msk.getUTCMonth() + 1;
  const date = msk.getUTCDate();
  // Новогодние каникулы: с 31 декабря по 7 января включительно.
  if (month === 12 && date === 31) return false;
  if (month === 1 && date <= 7) return false;

  return true;
}

if (!TOKEN || !OWNER_ID) {
  console.error("Не заданы NOTIFY_BOT_TOKEN и/или TELEGRAM_OWNER_ID");
  process.exit(1);
}

// ---- Состояние -----------------------------------------------------------
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { bindings: {}, lastDigest: null };
  }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
let state = loadState();

// ---- Telegram ------------------------------------------------------------
async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const err = new Error(`${method}: ${data.description || res.status}`);
    // Telegram кладёт сюда новый id, когда группа стала супергруппой.
    err.migrateTo = data.parameters?.migrate_to_chat_id ?? null;
    throw err;
  }
  return data.result;
}

/** Группа превратилась в супергруппу — переносим привязку на новый id.
 *
 *  Это случается само: как только боту дают права администратора, Telegram
 *  повышает обычную группу до супергруппы и меняет её идентификатор. Старый
 *  перестаёт работать молча — напоминания клиенту просто перестали бы
 *  уходить, и заметили бы это не скоро. */
function migrateBinding(oldId, newId) {
  const from = String(oldId);
  const to = String(newId);
  if (!state.bindings[from] || state.bindings[to]) return;
  state.bindings[to] = state.bindings[from];
  delete state.bindings[from];
  saveState(state);
  console.log(`чат ${from} стал супергруппой ${to} — привязка перенесена`);
}

async function say(chatId, text) {
  try {
    await tg("sendMessage", { chat_id: chatId, text });
  } catch (e) {
    if (e.migrateTo) {
      migrateBinding(chatId, e.migrateTo);
      // Повтор по новому адресу: сообщение не должно потеряться из-за того,
      // что чат поменял тип посреди рабочего дня.
      await tg("sendMessage", { chat_id: e.migrateTo, text }).catch((e2) =>
        console.error(`отправка в ${e.migrateTo} после переноса:`, e2.message)
      );
      return;
    }
    console.error(`отправка в ${chatId}:`, e.message);
  }
}

// ---- Боевой сервер -------------------------------------------------------
function sshDigest(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ssh", [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=20",
      ...PROD_SSH,
      `${DIGEST_CMD} ${args}`,
    ]);
    let out = "", err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => { proc.kill(); reject(new Error("боевой сервер не ответил за 60 с")); }, 60000);
    proc.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) return reject(new Error(err.slice(-400) || `ssh код ${code}`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error("нечитаемый ответ: " + out.slice(0, 200))); }
    });
  });
}

// ---- Текст сообщения -----------------------------------------------------
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
function composeParts(p) {
  const parts = [];
  if (p.scripts) parts.push(`${p.scripts} ${plural(p.scripts, "сценарий", "сценария", "сценариев")}`);
  if (p.videos) parts.push(`${p.videos} видео`);
  if (p.avatars) parts.push(`${p.avatars} ${plural(p.avatars, "аватар", "аватара", "аватаров")}`);
  if (p.trials) parts.push(`${p.trials} ${plural(p.trials, "пробное видео", "пробных видео", "пробных видео")}`);
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(", ") + " и " + parts[parts.length - 1];
}
function composeMessage(p, url) {
  const what = composeParts(p);
  if (!what) return null;
  return (
    `Партнёры, добрый день! У вас на платформе ${what} на согласование:\n${url}\n\n` +
    `Подскажите, когда посмотрите?`
  );
}

/** Отправляет напоминание в старом формате бота. Осталось только для
 *  ручной команды в чате: плановую рассылку и кнопку «Уведомить сейчас»
 *  теперь собирает платформа и присылает готовым текстом на /send.
 *
 *  Пояснение про пробные видео убрано 10.08.2026 по решению владельца. */
async function sendDigestTo(chatId, p, url) {
  const msg = composeMessage(p, url);
  if (!msg) return false;
  await say(chatId, msg);
  return true;
}

// ---- Рассылка ------------------------------------------------------------
async function runDigest(onlyChatId = null, report = null) {
  const bound = Object.entries(state.bindings);
  if (!bound.length) {
    if (report) await say(report, "Ни один чат пока не привязан — нечего рассылать.");
    return;
  }
  let list;
  try {
    list = await sshDigest("digest");
  } catch (e) {
    console.error("digest:", e.message);
    if (report) await say(report, `Не смог получить данные с платформы: ${e.message}`);
    return;
  }
  const byProject = Object.fromEntries(list.map((p) => [p.projectId, p]));
  let sent = 0, quiet = 0;
  for (const [chatId, b] of bound) {
    if (onlyChatId && chatId !== String(onlyChatId)) continue;
    const p = byProject[b.projectId];
    if (!p) continue; // проект в архиве или удалён — молчим
    const url = p.url || b.url;
    if (!(await sendDigestTo(chatId, p, url))) { quiet++; continue; }
    sent++;
  }
  if (report) await say(report, `Разослано: ${sent}. Без напоминания (нечего согласовывать): ${quiet}.`);
}

// Собственный ежедневный цикл отключён 10.08.2026: плановую рассылку теперь
// собирает и инициирует платформа (задача notify-clients, раз в час, отправка
// после 12:00 МСК по рабочим дням) через эндпоинт /send. Так клиент получает
// одно сообщение — дайджест со сроками, — а не два от разных отправителей.
// runDigest() остаётся для ручного вызова командой в чате.

// ---- Команды -------------------------------------------------------------
/** Привязка одним касанием: продюсер жмёт кнопку на странице проекта,
 *  Telegram открывает выбор группы и добавляет бота с номером проекта в
 *  довесок. Бот сам находит проект, запоминает связку и здоровается —
 *  ни ссылки, ни команд от человека не требуется.
 *
 *  Само добавление в группу всё равно делает человек: боту войти по ссылке
 *  Telegram не позволяет никому. */
async function bindByProjectId(chatId, projectId) {
  let info;
  try {
    info = await sshDigest(`project ${projectId}`);
  } catch (e) {
    await say(chatId, `Не смог связаться с платформой: ${e.message}`);
    return;
  }
  if (info.error) {
    await say(chatId, `Проект не найден. Попробуйте привязать вручную: /bind <ссылка на кабинет>`);
    return;
  }
  state.bindings[String(chatId)] = { projectId: info.projectId, name: info.name, url: info.url };
  saveState(state);

  const hello =
    `Здравствуйте! Я бот команды «Контент-цех» по проекту «${info.name}».\n\n` +
    (info.url
      ? `Буду напоминать здесь, когда на платформе появятся материалы, ждущие вашего согласования:\n${info.url}\n\n`
      : `Буду напоминать здесь, когда на платформе появятся материалы, ждущие вашего согласования.\n\n`) +
    `Пишу не чаще раза в день и только когда есть что посмотреть.`;
  await say(chatId, hello);

  // Инструкция идёт следом за приветствием — но только если в нём была
  // ссылка: показывать «зажмите ссылку», когда ссылки нет, бессмысленно.
  if (info.url) await sendInstruction(chatId);
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

async function handleCommand(msg) {
  const chatId = msg.chat.id;
  // «/bind@ИмяБота ...» в группах — срезаем упоминание.
  const text = msg.text.replace(/^(\/\w+)@\S+/, "$1").trim();

  // Telegram присылает «/start <номер проекта>», когда бота добавили по
  // кнопке с платформы.
  if (text.startsWith("/start ")) {
    const payload = text.slice(7).trim();
    if (payload && msg.chat.type !== "private") {
      await bindByProjectId(chatId, payload);
      return;
    }
  }

  if (text.startsWith("/bind")) {
    const arg = text.slice(5).trim();
    if (!arg) {
      await say(chatId, "Пришлите ссылку на кабинет клиента: /bind https://app.content-ceh.ru/p/XXXXX");
      return;
    }
    const m = arg.match(/\/p\/([A-Za-z0-9]+)/) || [null, arg.match(/^[A-Za-z0-9]{4,10}$/)?.[0]];
    const token = m[1];
    let info;
    if (token) {
      try { info = await sshDigest(`resolve ${token}`); } catch (e) {
        await say(chatId, `Не смог проверить ссылку: ${e.message}`);
        return;
      }
      if (info.error) { await say(chatId, `Ссылка не подошла: ${info.error}`); return; }
    } else {
      // Привязка по названию проекта — работает, только если ссылка уже в базе.
      let list;
      try { list = await sshDigest("digest"); } catch (e) {
        await say(chatId, `Не смог получить список проектов: ${e.message}`);
        return;
      }
      // Ищем и по клиентскому названию, и по внутреннему — вам привычнее
      // второе, а в чат уйдёт всё равно первое.
      const q = arg.toLowerCase();
      const found = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.internalName || "").toLowerCase().includes(q)
      );
      if (found.length !== 1) {
        await say(chatId, found.length ? `Нашёл несколько: ${found.map((p) => p.name).join(", ")} — уточните.` : "Проект с таким названием не нашёл. Надёжнее привязать ссылкой: /bind <ссылка на кабинет>");
        return;
      }
      if (!found[0].url) {
        await say(chatId, `У «${found[0].name}» в базе нет открытой ссылки — привяжите ссылкой: /bind <ссылка на кабинет>`);
        return;
      }
      info = { projectId: found[0].projectId, name: found[0].name, url: found[0].url };
    }
    state.bindings[String(chatId)] = { projectId: info.projectId, name: info.name, url: info.url };
    saveState(state);
    await say(chatId, `Готово: этот чат привязан к проекту «${info.name}». Напоминания — ежедневно в 10:00 по Москве, только когда есть что согласовать.`);
    return;
  }

  if (text === "/unbind") {
    const b = state.bindings[String(chatId)];
    delete state.bindings[String(chatId)];
    saveState(state);
    await say(chatId, b ? `Отвязал от «${b.name}» — напоминаний тут больше не будет.` : "Этот чат и не был привязан.");
    return;
  }

  if (text === "/status") {
    const b = state.bindings[String(chatId)];
    if (!b) { await say(chatId, "Чат не привязан. Привязать: /bind <ссылка на кабинет>"); return; }
    try {
      const list = await sshDigest("digest");
      const p = list.find((x) => x.projectId === b.projectId);
      const what = p ? composeParts(p) : null;
      await say(chatId, `Проект: «${b.name}»\nСейчас на согласовании: ${what || "ничего"}.`);
    } catch (e) {
      await say(chatId, `Привязан к «${b.name}», но данные сейчас недоступны: ${e.message}`);
    }
    return;
  }

  if (text === "/digest") {
    // Ручной прогон: в привязанном чате — только для него, в личке — для всех.
    if (state.bindings[String(chatId)]) await runDigest(chatId, chatId);
    else await runDigest(null, chatId);
    return;
  }

  if (msg.chat.type === "private") {
    await say(
      chatId,
      "Я бот-напоминалка: раз в день пишу в чат клиента, что на платформе ждёт согласования.\n\n" +
        "В чате клиента (от вашего имени):\n" +
        "/bind <ссылка на кабинет> — привязать чат к проекту\n" +
        "/status — что сейчас на согласовании\n" +
        "/unbind — отвязать\n" +
        "/digest — разослать напоминания прямо сейчас (для проверки)"
    );
  }
}

// ---- Приём команд от платформы -------------------------------------------
// Кнопка «Уведомить» на странице проекта: система на боевом сервере просит
// отправить напоминание немедленно. Сама она этого сделать не может —
// Telegram оттуда недоступен, поэтому обращается сюда.
//
// Защита двойная: секрет в заголовке и правило фаервола, пускающее только
// адреса боевого сервера. Секрета одного мало — порт торчит в интернет.
const NOTIFY_API_PORT = Number(process.env.NOTIFY_API_PORT || 8787);
const NOTIFY_API_SECRET = process.env.NOTIFY_API_SECRET || "";

function findChatByProject(projectId) {
  for (const [chatId, b] of Object.entries(state.bindings)) {
    if (b.projectId === projectId) return { chatId, binding: b };
  }
  return null;
}

async function notifyProjectNow(projectId) {
  const found = findChatByProject(projectId);
  if (!found) return { ok: false, reason: "чат не подключён" };

  let list;
  try {
    list = await sshDigest("digest");
  } catch (e) {
    return { ok: false, reason: `платформа не ответила: ${e.message}` };
  }
  const p = list.find((x) => x.projectId === projectId);
  if (!p) return { ok: false, reason: "проект не найден" };

  const delivered = await sendDigestTo(found.chatId, p, p.url || found.binding.url);
  if (!delivered) return { ok: false, reason: "сейчас нечего согласовывать" };

  return { ok: true, chat: found.binding.name };
}

/** Доставить в чат проекта готовый текст, сочинённый платформой.
 *
 *  В отличие от /notify текст здесь не сочиняется: производственный
 *  календарь, шаблоны уведомлений и защита от повторов живут на платформе.
 *  Боту остаётся доставка — он единственный, кому Telegram виден.
 *
 *  «Чат не подключён» возвращаем отдельным признаком unbound: для платформы
 *  это не сбой отправки, а несделанная настройка, и записывать её как
 *  неудачную попытку каждый час не нужно.
 */
const INSTRUCTION_FILE = "/opt/tg-agent/client-link-instruction.jpg";

/** Картинка «как открыть ссылку в браузере, а не внутри Telegram».
 *
 *  Telegram открывает ссылки своим встроенным браузером, и в нём у клиентов
 *  часть вещей работает хуже. Заставить ссылку открыться снаружи нельзя —
 *  такого механизма в Telegram нет, — поэтому показываем клиенту, как это
 *  сделать руками: зажать ссылку и выбрать «Открыть в…».
 *
 *  Первую отправку Telegram принимает файлом, дальше переиспользуем выданный
 *  им file_id: так картинка не заливается заново при каждой отправке.
 */
async function sendInstruction(chatId) {
  if (state.instructionFileId) {
    try {
      await tg("sendPhoto", { chat_id: chatId, photo: state.instructionFileId });
      return true;
    } catch (e) {
      // file_id мог протухнуть (например, картинку заменили) — зальём заново.
      console.error("инструкция по file_id не ушла, заливаю файл:", e.message);
      state.instructionFileId = null;
    }
  }

  let bytes;
  try {
    bytes = fs.readFileSync(INSTRUCTION_FILE);
  } catch (e) {
    console.error("нет файла инструкции:", e.message);
    return false;
  }

  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", new Blob([bytes], { type: "image/jpeg" }), "instruction.jpg");
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, {
      method: "POST",
      body: form,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description || `HTTP ${res.status}`);
    // Самый крупный размер — его file_id и запоминаем.
    const sizes = data.result?.photo || [];
    const biggest = sizes[sizes.length - 1];
    if (biggest?.file_id) {
      state.instructionFileId = biggest.file_id;
      saveState(state);
    }
    return true;
  } catch (e) {
    console.error("инструкция не отправилась:", e.message);
    return false;
  }
}

async function sendTextToProject(projectId, text) {
  const found = findChatByProject(projectId);
  if (!found) return { ok: false, unbound: true, reason: "чат не подключён" };
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, unbound: false, reason: "пустой текст" };
  }
  try {
    await tg("sendMessage", {
      chat_id: found.chatId,
      text,
      link_preview_options: { is_disabled: true },
    });
  } catch (e) {
    return { ok: false, unbound: false, reason: e.message };
  }
  return { ok: true, chatId: found.chatId, chat: found.binding.name };
}

/** Ссылка на кабинет + картинка-инструкция следом. Дёргается кнопкой
 *  «Отправить клиенту в чат» на странице проекта. */
async function sendLinkToProject(projectId, text) {
  const sent = await sendTextToProject(projectId, text);
  if (!sent.ok) return sent;
  const withPhoto = await sendInstruction(sent.chatId);
  return { ...sent, instruction: withPhoto };
}

function startNotifyApi() {
  if (!NOTIFY_API_SECRET) {
    console.warn("NOTIFY_API_SECRET не задан — кнопка «Уведомить» работать не будет");
    return;
  }
  http
    .createServer(async (req, res) => {
      const reply = (code, body) => {
        res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
      };
      // /notify — бот сам собирает дайджест (кнопка «Уведомить»).
      // /send   — платформа прислала готовый текст, бот только доставляет.
      const route = req.url;
      if (
        req.method !== "POST" ||
        (route !== "/notify" && route !== "/send" && route !== "/send-link")
      ) {
        return reply(404, { error: "нет такого" });
      }
      if (req.headers["x-notify-secret"] !== NOTIFY_API_SECRET) return reply(403, { error: "нет доступа" });

      let raw = "";
      req.on("data", (d) => {
        raw += d;
        // Текст уведомления длиннее дайджеста, но всё равно небольшой.
        if (raw.length > 16384) req.destroy();
      });
      req.on("end", async () => {
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return reply(400, { error: "некорректный запрос" });
        }
        if (!body.projectId) return reply(400, { error: "не указан проект" });
        try {
          const r =
            route === "/send"
              ? await sendTextToProject(body.projectId, body.text)
              : route === "/send-link"
                ? await sendLinkToProject(body.projectId, body.text)
                : await notifyProjectNow(body.projectId);
          reply(r.ok ? 200 : 409, r);
        } catch (e) {
          reply(500, { ok: false, reason: e.message });
        }
      });
    })
    .listen(NOTIFY_API_PORT, () => console.log(`приём команд платформы: порт ${NOTIFY_API_PORT}`));
}

// ---- Цикл ----------------------------------------------------------------
async function main() {
  const me = await tg("getMe", {});
  console.log(`бот-напоминалка запущен: @${me.username}`);
  startNotifyApi();

  let offset = 0;
  try {
    const pending = await tg("getUpdates", { timeout: 0, offset: -1 });
    if (pending.length) offset = pending[pending.length - 1].update_id + 1;
  } catch {}

  for (;;) {
    let updates = [];
    try {
      // my_chat_member по умолчанию не приходит — просим его явно, иначе
      // не узнаем, что бота добавили в группу.
      updates = await tg("getUpdates", {
        timeout: 50,
        offset,
        allowed_updates: ["message", "my_chat_member"],
      });
    } catch (e) {
      console.error("getUpdates:", e.message);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;

      // Бота добавили в группу — если без номера проекта, подскажем, что делать.
      if (u.my_chat_member) {
        const st = u.my_chat_member.new_chat_member?.status;
        const was = u.my_chat_member.old_chat_member?.status;
        const chat = u.my_chat_member.chat;
        // Повышение до администратора и превращение группы в супергруппу
        // приходят тем же событием, что и добавление. Подсказку «меня
        // добавили без привязки» в этих случаях показывать нельзя: бот в
        // чате давно, а сообщение увидит клиент — и решит, что мы что-то
        // сломали. Реальное добавление — это переход из «вышел/выгнан».
        const reallyAdded = was === "left" || was === "kicked" || was === undefined;
        if (reallyAdded && (st === "member" || st === "administrator") && chat?.type !== "private") {
          console.log(`бота добавили в чат ${chat.id} «${chat.title || "?"}»`);
          const known = state.bindings[String(chat.id)];
          if (!known) {
            // Даём фору сообщению «/start <проект>»: оно приходит следом,
            // и если привязка случится — подсказка не нужна.
            const chatId = chat.id;
            setTimeout(async () => {
              if (state.bindings[String(chatId)]) return;
              await say(
                chatId,
                "Здравствуйте! Я бот-напоминалка «Контент-цеха».\n\n" +
                  "Меня добавили без привязки к проекту. Продюсер: подключите проект кнопкой на его странице " +
                  "или командой /bind <ссылка на кабинет клиента>."
              );
            }, 4000);
          }
        }
        continue;
      }

      const msg = u.message;
      // Служебное сообщение о превращении группы в супергруппу приходит
      // в старый чат — ловим его до проверки на текст, текста в нём нет.
      if (msg?.migrate_to_chat_id) {
        migrateBinding(msg.chat.id, msg.migrate_to_chat_id);
        continue;
      }
      // В новой супергруппе приходит зеркальное сообщение — со старым id.
      // Ловим и его: какое из двух дойдёт первым, зависит от порядка
      // обновлений, а привязку надо перенести в любом случае.
      if (msg?.migrate_from_chat_id) {
        migrateBinding(msg.migrate_from_chat_id, msg.chat.id);
        continue;
      }
      if (!msg?.text) continue;

      const fromOwner = String(msg.from?.id || "") === OWNER_ID;
      const inGroup = msg.chat.type !== "private";

      // Упоминание бота срезаем ДО проверок. В группах клиент Telegram
      // подставляет имя к команде — «/start@ИмяБота <проект>», — и сравнение с
      // сырым текстом такую команду молча выбрасывало, хотя обработчик ниже
      // разобрать её умеет. Привязка по кнопке с платформы из-за этого не
      // срабатывала, а продюсер видел «меня добавили без привязки».
      const command = msg.text.replace(/^(\/\w+)@\S+/, "$1").trim();

      // Привязку делает продюсер, а не владелец бота, поэтому «/start <проект>»
      // и «/bind <ссылка>» пропускаем от любого. Пропуском служит само знание
      // номера проекта или ссылки на кабинет: посторонний их не знает, а у кого
      // они есть — и так имеет доступ к проекту.
      //
      // Раньше здесь пропускался только «/start», и подсказка бота советовала
      // продюсеру «/bind», которую тот же фильтр и выбрасывал.
      const isBinding =
        inGroup && (command.startsWith("/start ") || command.startsWith("/bind"));
      if (!inGroup && PROJECT_ID_RE.test(command.replace(/^\/start\s+/, "")) && command.startsWith("/start ")) {
        await sendConnectHelp(msg.chat.id).catch((e) => console.error("подсказка подключения:", e.message));
        continue;
      }
      if (!fromOwner && !isBinding) continue;
      if (fromOwner && !command.startsWith("/") && inGroup) continue;

      if (isBinding) {
        console.log(`привязка из чата ${msg.chat.id}: ${command.slice(0, 80)}`);
      }

      try {
        await handleCommand(msg);
      } catch (e) {
        console.error("обработка:", e.message);
      }
    }
  }
}

main().catch((e) => {
  console.error("бот упал:", e);
  process.exit(1);
});
