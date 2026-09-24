#!/opt/tg-agent/stt/bin/python
"""Расшифровка голосовых из чатов — на этой машине, без внешних сервисов.

Почему локально: Wispr Flow отдаёт API только организациям на корпоративном
домене, через отдел продаж; личная подписка на диктовку сюда не годится.
Локальная модель не требует ни аккаунта, ни оплаты, и голосовые клиентов
никуда не уезжают.

Идёт по журналу бота, находит сохранённые голосовые, у которых ещё нет
расшифровки, и дописывает её в тот же журнал строкой event=transcript.
Журнал — единственный источник правды: помощник потом читает только его.

Запуск: transcribe-pending.py [--limit N]
"""

import json
import os
import subprocess
import sys
import tempfile

LOG = "/opt/tg-agent/reader-log.ndjson"
MODEL_DIR = "/opt/tg-agent/stt-model"
# medium — проверено на живой записи: small теряла слова и путала имена,
# medium расслышала верно. Цена — 40 с на 12 с записи, но расшифровка идёт
# фоном, её никто не ждёт. Размер модели ~1,5 ГБ.
MODEL_NAME = "medium"
AUDIO_KINDS = {"voice", "audio", "video_note"}

limit = None
if "--limit" in sys.argv:
    limit = int(sys.argv[sys.argv.index("--limit") + 1])


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


def to_wav(src):
    """Telegram отдаёт голосовые в OGG/Opus. Модель хочет 16 кГц моно."""
    fd, dest = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", src,
         "-ar", "16000", "-ac", "1", dest],
        check=True,
    )
    return dest


def main():
    rows = read_log()
    todo = pending(rows)
    if limit:
        todo = todo[:limit]
    if not todo:
        print("нечего расшифровывать")
        return

    from faster_whisper import WhisperModel

    print(f"к расшифровке: {len(todo)}")
    model = WhisperModel(
        MODEL_NAME, device="cpu", compute_type="int8", download_root=MODEL_DIR
    )

    for r in todo:
        wav = None
        try:
            wav = to_wav(r["path"])
            segments, info = model.transcribe(wav, language="ru", vad_filter=True)
            text = " ".join(s.text.strip() for s in segments).strip()
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
                            "engine": f"faster-whisper/{MODEL_NAME}",
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
            print(f"{r['path']}: {len(text)} символов — {text[:80]}")
        except Exception as e:  # noqa: BLE001 — падать целиком из-за одного файла нельзя
            print(f"не смог {r.get('path')}: {e}", file=sys.stderr)
        finally:
            if wav and os.path.exists(wav):
                os.unlink(wav)


if __name__ == "__main__":
    main()
