#!/usr/bin/python3
"""Расшифровка голосовых из чатов — через AssemblyAI, как записи брифов.

Почему не локально: faster-whisper medium на этой машине съедал ~2 ГБ,
падал по нехватке памяти и расшифровывал пятиминутное голосовое дольше
двадцати минут. AssemblyAI — тот же сервис, что расшифровывает брифы в
agent-worker (Universal-2, единственная модель с русским), и тот же ключ:
он берётся из /opt/agent-worker/.env, чтобы не держать две копии.

Идёт по журналу бота, находит сохранённые голосовые, у которых ещё нет
расшифровки, и дописывает её в тот же журнал строкой event=transcript.
Журнал — единственный источник правды: помощник потом читает только его.

Запуск: transcribe-pending.py [--limit N]
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

LOG = "/opt/tg-agent/reader-log.ndjson"
WORKER_ENV = "/opt/agent-worker/.env"
AAI = "https://api.assemblyai.com"
MODEL_NAME = "universal-2"
AUDIO_KINDS = {"voice", "audio", "video_note"}
POLL_S = 3
MAX_WAIT_S = 10 * 60

limit = None
if "--limit" in sys.argv:
    limit = int(sys.argv[sys.argv.index("--limit") + 1])


def api_key():
    key = os.environ.get("ASSEMBLYAI_API_KEY")
    if key:
        return key
    with open(WORKER_ENV, encoding="utf-8") as f:
        for line in f:
            name, _, value = line.strip().partition("=")
            if name == "ASSEMBLYAI_API_KEY" and value:
                return value.strip().strip('"').strip("'")
    raise SystemExit(f"ASSEMBLYAI_API_KEY не найден ни в окружении, ни в {WORKER_ENV}")


def read_log():
    rows = []
    with open(LOG, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def pending(rows):
    """Голосовые без расшифровки. Ключ — чат плюс сообщение: file_unique_id
    у Telegram свой на каждого бота, а пара chat/message стабильна."""
    done = {
        (r.get("chat_id"), r.get("message_id"))
        for r in rows
        if r.get("event") == "transcript"
    }
    out = []
    for r in rows:
        if r.get("event") != "media_saved" or r.get("kind") not in AUDIO_KINDS:
            continue
        if (r.get("chat_id"), r.get("message_id")) in done:
            continue
        if not r.get("path") or not os.path.exists(r["path"]):
            continue
        out.append(r)
    return out


def aai(key, path, body=None, content_type=None):
    req = urllib.request.Request(f"{AAI}{path}", data=body, method="POST" if body else "GET")
    req.add_header("authorization", key)
    if content_type:
        req.add_header("content-type", content_type)
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return json.load(res)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"AssemblyAI ответил {e.code}: {e.read()[:300].decode(errors='replace')}")


def transcribe(key, path):
    """Файл уходит как есть: OGG/Opus, MP3 и MP4 AssemblyAI разбирает сам."""
    with open(path, "rb") as f:
        up = aai(key, "/v2/upload", f.read(), "application/octet-stream")
    created = aai(
        key,
        "/v2/transcript",
        json.dumps({
            "audio_url": up["upload_url"],
            "language_code": "ru",
            "speech_models": [MODEL_NAME],
            "punctuate": True,
            "format_text": True,
        }).encode(),
        "application/json",
    )
    started = time.time()
    while True:
        t = aai(key, f"/v2/transcript/{created['id']}")
        if t["status"] == "completed":
            return (t.get("text") or "").strip()
        if t["status"] == "error":
            raise RuntimeError(f"расшифровка не удалась: {t.get('error') or 'без причины'}")
        if time.time() - started > MAX_WAIT_S:
            raise RuntimeError("AssemblyAI не ответил за 10 минут — повторю в следующий запуск")
        time.sleep(POLL_S)


def main():
    rows = read_log()
    todo = pending(rows)
    if limit:
        todo = todo[:limit]
    if not todo:
        print("нечего расшифровывать")
        return

    key = api_key()
    print(f"к расшифровке: {len(todo)}")

    for r in todo:
        try:
            text = transcribe(key, r["path"])
            with open(LOG, "a", encoding="utf-8") as f:
                f.write(
                    json.dumps(
                        {
                            "ts": r.get("ts"),
                            "chat_id": r.get("chat_id"),
                            "message_id": r.get("message_id"),
                            "event": "transcript",
                            "kind": r.get("kind"),
                            "duration": r.get("duration"),
                            "text": text or None,
                            "engine": f"assemblyai/{MODEL_NAME}",
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
            print(f"{r['path']}: {len(text)} символов — {text[:80]}")
        except Exception as e:  # noqa: BLE001 — падать целиком из-за одного файла нельзя
            print(f"не смог {r.get('path')}: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
