// Сверка покрытия: у живого проекта должен быть чат, а в чате — ассистент.
//
// Три источника, каждый знает свою часть правды:
//   портал (боевой)      — какие проекты вообще есть и не в архиве ли они;
//   notify-state.json    — к какому проекту привязан какой чат;
//   Telegram             — состоит ли ассистент в этом чате на самом деле.
//
// Присутствие спрашиваем у Telegram, а не по своим записям: бота могли
// добавить или выкинуть из чата, пока служба лежала, и тогда наши записи
// врут, а getChatMember — нет.
//
// Запуск:  node audit-coverage.mjs           — показать отчёт в консоль
//          node audit-coverage.mjs --send    — прислать владельцу в личку
//          node audit-coverage.mjs --send --force  — и в тихие часы тоже

import { execFile } from "child_process";
import fs from "fs";

const TOKEN = process.env.READER_BOT_TOKEN;
const OWNER_ID = String(process.env.TELEGRAM_OWNER_ID || "").trim();
const BOT_ID = Number(String(TOKEN || "").split(":")[0]);
const NOTIFY_STATE = "/opt/tg-agent/notify-state.json";
const EXCEPTIONS_FILE = "/opt/tg-agent/audit-exceptions.json";
const MUTED_FILE = "/opt/tg-agent/muted-chats.json";
const PROD = "root@194.67.92.177";
const DB = "dnevnik_saas";

const SEND = process.argv.includes("--send");
const FORCE = process.argv.includes("--force");

if (!TOKEN || !OWNER_ID) {
  console.error("Не заданы READER_BOT_TOKEN и/или TELEGRAM_OWNER_ID");
  process.exit(1);
}

function isQuiet(now = new Date()) {
  const h = new Date(now.getTime() + 3 * 60 * 60 * 1000).getUTCHours();
  return h >= 22 || h < 9;
}

function sh(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 8 << 20 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout),
    );
  });
}

/** Живые проекты с боевого. Только чтение, ничего не меняем. */
async function fetchProjects() {
  // Берём и архивные тоже: по ним видно, где ассистент слушает чат проекта,
  // который уже закрыт.
  const sql =
    "select coalesce(json_agg(json_build_object(" +
    "'id', id, 'number', number, 'internal', \"internalName\", 'client', \"clientCompanyName\", " +
    "'archived', archived" +
    ") order by number), '[]') from \"Project\";";
  const out = await sh("ssh", [
    "-o", "ConnectTimeout=20", "-o", "BatchMode=yes", PROD,
    `sudo -u postgres psql -d ${DB} -tAc ${JSON.stringify(sql)}`,
  ]);
  return JSON.parse(out.trim());
}

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}

/** Состоит ли ассистент в чате. Telegram отвечает ошибкой и когда чата нет,
 *  и когда бота там нет — для нас это одно и то же: покрытия нет. */
async function assistantIn(chatId) {
  const d = await tg("getChatMember", { chat_id: chatId, user_id: BOT_ID });
  if (!d.ok) return { present: false, why: d.description };
  const st = d.result?.status;
  return { present: st === "member" || st === "administrator", why: st };
}

function loadBindings() {
  try {
    return JSON.parse(fs.readFileSync(NOTIFY_STATE, "utf8")).bindings || {};
  } catch {
    return {};
  }
}

/** Проекты, которым чат с ботами не положен по договорённости. Без этого
 *  списка сверка каждый день повторяла бы то, что уже решено, и её перестали
 *  бы читать — а вместе с ней и настоящие пробелы. */
/** Пишем ассистенту список чатов, которые можно не слушать. Ходить в его
 *  состояние напрямую не хотим: он живёт своим процессом, а файл — общая
 *  граница, которую оба понимают. */
/** Чаты, которые нельзя глушить, даже если проект за ними закрыт. */
function loadKeptChats() {
  try {
    return JSON.parse(fs.readFileSync(EXCEPTIONS_FILE, "utf8")).чаты || {};
  } catch {
    return {};
  }
}

function writeMuted(finished) {
  const keep = loadKeptChats();
  const out = {};
  for (const f of finished) {
    if (keep[String(f.chatId)]) continue;
    out[f.chatId] = `${f.name}: ${f.reason}`;
  }
  fs.writeFileSync(MUTED_FILE, JSON.stringify(out, null, 2));
}

function loadExceptions() {
  try {
    const raw = JSON.parse(fs.readFileSync(EXCEPTIONS_FILE, "utf8"));
    return new Map(
      Object.entries(raw)
        .filter(([k]) => /^\d+$/.test(k))
        .map(([k, v]) => [Number(k), v]),
    );
  } catch {
    return new Map();
  }
}

async function main() {
  const all = await fetchProjects();
  const exceptions = loadExceptions();
  const live = all.filter((p) => !p.archived);
  const projects = live.filter((p) => !exceptions.has(p.number));
  const skipped = live.filter((p) => exceptions.has(p.number));
  const byId = new Map(all.map((p) => [p.id, p]));
  const bindings = loadBindings();

  // Проект → чаты, привязанные к нему.
  const byProject = new Map();
  for (const [chatId, b] of Object.entries(bindings)) {
    if (!byProject.has(b.projectId)) byProject.set(b.projectId, []);
    byProject.get(b.projectId).push({ chatId, name: b.name });
  }

  const noChat = [];        // проект есть, чата нет
  const noAssistant = [];   // чат есть, ассистента в нём нет
  const covered = [];       // всё на месте
  for (const p of projects) {
    const chats = byProject.get(p.id) || [];
    if (!chats.length) {
      noChat.push(p);
      continue;
    }
    for (const c of chats) {
      const { present, why } = await assistantIn(c.chatId);
      (present ? covered : noAssistant).push({ ...p, chat: c, why });
    }
  }

  // Чаты закрытых проектов: работа кончилась, слушать там больше нечего.
  // Разделяем архив и «проекта нет вовсе» — это разные истории: первое штатно,
  // второе значит, что привязка указывает в никуда.
  const alive = new Set(live.map((p) => p.id));
  const finished = [];
  for (const [chatId, b] of Object.entries(bindings)) {
    if (alive.has(b.projectId)) continue;
    const p = byId.get(b.projectId);
    const { present } = await assistantIn(chatId);
    finished.push({
      chatId,
      name: b.name,
      present,
      reason: p ? `проект №${p.number} в архиве` : "проекта нет в портале",
    });
  }
  const stillListening = finished.filter((f) => f.present);

  // Список чатов, которые ассистенту слушать не нужно. Он его перечитывает и
  // просто пропускает эти чаты: выходить из группы не станем — уход бота виден
  // клиенту и необратим одним кликом, а вернуть проект из архива легко.
  const kept = loadKeptChats();
  writeMuted(finished);

  const lines = [];
  lines.push(
    `Покрытие ассистентом: ${covered.length} из ${projects.length} живых проектов.`,
  );
  if (noChat.length) {
    lines.push("", `Проект есть, чата нет (${noChat.length}):`);
    for (const p of noChat) lines.push(`  №${p.number} ${p.internal} — ${p.client}`);
  }
  if (noAssistant.length) {
    lines.push("", `Чат есть, ассистента в нём нет (${noAssistant.length}):`);
    for (const x of noAssistant)
      lines.push(`  №${x.number} ${x.internal} — чат «${x.chat.name}» (${x.why})`);
  }
  const muted = stillListening.filter((f) => !kept[String(f.chatId)]);
  if (muted.length) {
    lines.push(
      "",
      `Слушал чаты закрытых проектов (${muted.length}) — больше не нужно, ` +
        "поставил на игнор:",
    );
    for (const f of muted) lines.push(`  «${f.name}» — ${f.reason}`);
  }
  const finishedAbsent = finished.filter((f) => !f.present);
  if (finishedAbsent.length) {
    lines.push(
      "",
      `Привязки закрытых проектов без ассистента (${finishedAbsent.length}): ` +
        finishedAbsent.map((f) => `«${f.name}»`).join(", "),
    );
  }
  if (!noChat.length && !noAssistant.length) {
    lines.push("", "Пробелов нет: у каждого живого проекта есть чат, и ассистент в нём.");
  }
  if (skipped.length) {
    lines.push(
      "",
      `Не проверялись по договорённости (${skipped.length}): ` +
        skipped.map((p) => `№${p.number} ${p.internal}`).join(", "),
    );
  }

  const report = lines.join("\n");
  console.log(report);

  if (SEND) {
    if (isQuiet() && !FORCE) {
      console.log("\n(в личку не отправлено: тихие часы 22:00–09:00 МСК)");
      return;
    }
    // Молчим, когда всё в порядке: ежедневный отчёт «всё хорошо» перестают
    // читать через неделю, и тогда пропускают тот, где что-то не так.
    if (!noChat.length && !noAssistant.length) {
      console.log("\n(в личку не отправлено: пробелов нет)");
      return;
    }
    const d = await tg("sendMessage", { chat_id: OWNER_ID, text: report });
    console.log(d.ok ? "\nотправлено в личку" : `\nне отправилось: ${d.description}`);
  }
}

main().catch((e) => {
  console.error("сверка не прошла:", e.message);
  process.exit(1);
});
