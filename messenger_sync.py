#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════╗
║  Яндекс Мессенджер → Obsidian Vault                          ║
║  • Режим 1: polling — новые сообщения каждый час             ║
║  • Режим 2: парсинг экспорта истории чатов                   ║
╚══════════════════════════════════════════════════════════════╝

УСТАНОВКА:
    pip install requests schedule

ЗАПУСК (polling, каждый час):
    python messenger_sync.py

ЗАПУСК (разовый парсинг экспорта):
    python messenger_sync.py --parse-export ./export_folder
"""

# ══════════════════════════════════════════════
#  ⚙️  НАСТРОЙТЕ ЭТИ ПЕРЕМЕННЫЕ
# ══════════════════════════════════════════════
from config import YANDEX_BOT_TOKEN as BOT_TOKEN, VAULT_PATH, SYNC_EVERY_HOURS

# ══════════════════════════════════════════════

import os
import re
import json
import time
import argparse
import requests
from pathlib import Path
from datetime import datetime

BASE_URL   = "https://botapi.messenger.yandex.net/bot/v1"
STATE_FILE = ".messenger_state.json"  # хранит последний offset


# ──────────────────────────────────────────────
#  УТИЛИТЫ
# ──────────────────────────────────────────────

def safe_name(s: str, max_len=60) -> str:
    s = re.sub(r'[\\/*?:"<>|]', '_', str(s)).strip(". ")
    return s[:max_len] or "untitled"


def ts_to_str(ts) -> str:
    try:
        return datetime.fromtimestamp(int(ts)).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return str(ts)


def ts_to_date(ts) -> str:
    try:
        return datetime.fromtimestamp(int(ts)).strftime("%Y-%m-%d")
    except Exception:
        return "unknown"


def api_get(endpoint: str, params=None) -> dict:
    headers = {"Authorization": f"OAuth {BOT_TOKEN}"}
    url = f"{BASE_URL}/{endpoint}"
    r = requests.get(url, headers=headers, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json()


# ──────────────────────────────────────────────
#  СОСТОЯНИЕ (offset между запусками)
# ──────────────────────────────────────────────

def load_state() -> dict:
    try:
        return json.loads(Path(STATE_FILE).read_text())
    except Exception:
        return {"offset": 0, "chats": {}}


def save_state(state: dict):
    Path(STATE_FILE).write_text(json.dumps(state, ensure_ascii=False, indent=2))


# ──────────────────────────────────────────────
#  СОХРАНЕНИЕ В VAULT
# ──────────────────────────────────────────────

def get_chat_path(vault: Path, chat_type: str, chat_id: str, chat_name: str) -> Path:
    """Возвращает путь к файлу чата в vault."""
    section = {
        "private": "02_Messenger/Личные",
        "group":   "02_Messenger/Группы",
        "channel": "02_Messenger/Каналы",
    }.get(chat_type, "02_Messenger/Другое")

    name = safe_name(chat_name or chat_id)
    return vault / section / f"{name}.md"


def append_message_to_vault(vault: Path, update: dict):
    """Дописывает одно сообщение в нужный файл vault."""
    chat      = update.get("chat", {})
    chat_type = chat.get("type", "unknown")
    chat_id   = chat.get("id", "")
    sender    = update.get("from", {})
    sender_name = sender.get("display_name", sender.get("login", "unknown"))
    text      = update.get("text", "")
    ts        = update.get("timestamp", 0)
    msg_id    = update.get("message_id", "")

    # Имя чата: для личного — имя собеседника, для группы — название
    if chat_type == "private":
        chat_name = sender_name
    else:
        chat_name = chat.get("title", chat_id)

    fpath = get_chat_path(vault, chat_type, chat_id, chat_name)

    # Создаём файл с frontmatter если его нет
    if not fpath.exists():
        fpath.parent.mkdir(parents=True, exist_ok=True)
        header = f"""---
type: messenger_chat
chat_type: {chat_type}
chat_id: "{chat_id}"
chat_name: "{chat_name}"
source: yandex_messenger
created: "{datetime.now().strftime('%Y-%m-%d')}"
---

# {'💬' if chat_type == 'private' else '👥'} {chat_name}

"""
        fpath.write_text(header, encoding="utf-8")

    # Дописываем сообщение
    line = f"**{sender_name}** `{ts_to_str(ts)}`\n> {text}\n\n"
    with fpath.open("a", encoding="utf-8") as f:
        f.write(line)

    return chat_name


# ──────────────────────────────────────────────
#  РЕЖИМ 1: POLLING (новые сообщения)
# ──────────────────────────────────────────────

def poll_updates(vault: Path) -> int:
    """
    Забирает новые сообщения через getUpdates polling.
    Возвращает количество новых сообщений.
    """
    state  = load_state()
    offset = state.get("offset", 0)
    count  = 0
    chats_updated = set()

    print(f"  📡 Polling с offset={offset}...")

    while True:
        try:
            data = api_get("messages/getUpdates/", {"limit": 100, "offset": offset})
        except requests.HTTPError as e:
            print(f"  ❌ Ошибка API: {e}")
            break

        updates = data.get("updates", [])
        if not updates:
            break

        for upd in updates:
            update_id = upd.get("update_id", 0)

            # Пропускаем нетекстовые (стикеры, файлы)
            if not upd.get("text"):
                offset = max(offset, update_id + 1)
                continue

            chat_name = append_message_to_vault(vault, upd)
            chats_updated.add(chat_name)
            count += 1
            offset = max(offset, update_id + 1)

        # Если пришло меньше 100 — значит всё получили
        if len(updates) < 100:
            break

    # Сохраняем новый offset
    state["offset"] = offset
    save_state(state)

    if chats_updated:
        print(f"  ✅ Получено сообщений: {count}")
        print(f"  📁 Обновлены чаты: {', '.join(sorted(chats_updated))}")
    else:
        print("  ✅ Новых сообщений нет")

    return count


# ──────────────────────────────────────────────
#  РЕЖИМ 2: ПАРСИНГ ЭКСПОРТА
# ──────────────────────────────────────────────

def parse_export(vault: Path, export_folder: str):
    """
    Парсит экспорт истории чатов Яндекс Мессенджера.
    Поддерживает форматы: JSON, HTML, TXT
    """
    export_path = Path(export_folder)
    if not export_path.exists():
        print(f"  ❌ Папка не найдена: {export_folder}")
        return

    print(f"\n📂 Парсю экспорт из: {export_folder}")

    json_files = list(export_path.rglob("*.json"))
    html_files = list(export_path.rglob("*.html"))
    txt_files  = list(export_path.rglob("*.txt"))

    total = 0

    # ── JSON формат ──
    for fpath in json_files:
        try:
            data = json.loads(fpath.read_text(encoding="utf-8"))
            count = _parse_json_export(vault, data, fpath.stem)
            total += count
            print(f"  ✅ {fpath.name}: {count} сообщений")
        except Exception as e:
            print(f"  ⚠️  {fpath.name}: {e}")

    # ── HTML формат ──
    for fpath in html_files:
        try:
            count = _parse_html_export(vault, fpath)
            total += count
            print(f"  ✅ {fpath.name}: {count} сообщений")
        except Exception as e:
            print(f"  ⚠️  {fpath.name}: {e}")

    # ── TXT формат ──
    for fpath in txt_files:
        try:
            count = _parse_txt_export(vault, fpath)
            total += count
            print(f"  ✅ {fpath.name}: {count} сообщений")
        except Exception as e:
            print(f"  ⚠️  {fpath.name}: {e}")

    print(f"\n  📊 Итого импортировано: {total} сообщений")


def _parse_json_export(vault: Path, data: dict, filename: str) -> int:
    """Парсит JSON экспорт Яндекс Мессенджера."""
    # Возможные форматы JSON от Яндекса
    messages  = (
        data.get("messages") or
        data.get("history") or
        (data if isinstance(data, list) else [])
    )
    chat_name = data.get("name") or data.get("title") or filename
    chat_type = data.get("type", "group")

    if not messages:
        return 0

    fpath = get_chat_path(vault, chat_type, filename, chat_name)
    fpath.parent.mkdir(parents=True, exist_ok=True)

    lines = [
        f"---",
        f"type: messenger_chat",
        f"chat_type: {chat_type}",
        f"chat_name: \"{chat_name}\"",
        f"source: yandex_messenger_export",
        f"messages_count: {len(messages)}",
        f"---",
        f"",
        f"# {'💬' if chat_type == 'private' else '👥'} {chat_name}",
        f"",
        f"*Экспорт: {len(messages)} сообщений*",
        f"",
    ]

    for msg in messages:
        # Разные форматы полей
        sender = (
            msg.get("from") or
            msg.get("author") or
            msg.get("sender") or
            "unknown"
        )
        if isinstance(sender, dict):
            sender = sender.get("display_name") or sender.get("login") or "unknown"

        text = msg.get("text") or msg.get("body") or msg.get("content") or ""
        ts   = msg.get("timestamp") or msg.get("date") or msg.get("time") or ""
        dt   = ts_to_str(ts) if str(ts).isdigit() else str(ts)

        if text:
            lines.append(f"**{sender}** `{dt}`")
            lines.append(f"> {text}")
            lines.append("")

    fpath.write_text("\n".join(lines), encoding="utf-8")
    return len([m for m in messages if m.get("text") or m.get("body")])


def _parse_html_export(vault: Path, fpath: Path) -> int:
    """Парсит HTML экспорт — извлекает сообщения без BeautifulSoup."""
    html  = fpath.read_text(encoding="utf-8", errors="replace")
    count = 0

    # Извлекаем имя чата из <title>
    title_m   = re.search(r"<title[^>]*>([^<]+)</title>", html, re.IGNORECASE)
    chat_name = title_m.group(1).strip() if title_m else fpath.stem

    # Ищем сообщения по типичным паттернам экспорта
    # Яндекс Мессенджер обычно оборачивает в div.message
    msg_pattern = re.compile(
        r'class="[^"]*message[^"]*"[^>]*>.*?'
        r'(?:class="[^"]*author[^"]*"[^>]*>([^<]+)</|from[^>]*>([^<]+)</).*?'
        r'(?:class="[^"]*text[^"]*"[^>]*>([^<]+)<|<p[^>]*>([^<]+)</p)',
        re.DOTALL | re.IGNORECASE
    )

    lines = [
        f"---",
        f"type: messenger_chat",
        f"chat_name: \"{chat_name}\"",
        f"source: yandex_messenger_export",
        f"---",
        f"",
        f"# 💬 {chat_name}",
        f"",
    ]

    for m in msg_pattern.finditer(html):
        sender = (m.group(1) or m.group(2) or "").strip()
        text   = (m.group(3) or m.group(4) or "").strip()
        text   = re.sub(r"<[^>]+>", "", text)  # убираем теги
        if text:
            lines.append(f"**{sender or 'unknown'}**")
            lines.append(f"> {text}")
            lines.append("")
            count += 1

    # Если паттерн не сработал — сохраняем как plain text
    if count == 0:
        clean = re.sub(r"<[^>]+>", " ", html)
        clean = re.sub(r"\s+", " ", clean).strip()
        lines.append(clean[:50000])  # первые 50к символов
        count = 1

    out = get_chat_path(vault, "group", fpath.stem, chat_name)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")
    return count


def _parse_txt_export(vault: Path, fpath: Path) -> int:
    """Парсит TXT экспорт — типичный формат: 'Имя [дата]: текст'."""
    text  = fpath.read_text(encoding="utf-8", errors="replace")
    lines_out = [
        f"---",
        f"type: messenger_chat",
        f"chat_name: \"{fpath.stem}\"",
        f"source: yandex_messenger_export",
        f"---",
        f"",
        f"# 💬 {fpath.stem}",
        f"",
    ]

    count = 0
    # Паттерны: "Имя [2024-01-15 10:30]: текст" или "10:30 Имя: текст"
    patterns = [
        re.compile(r"^(.+?)\s*\[(.+?)\]:\s*(.+)$"),
        re.compile(r"^(\d{1,2}:\d{2})\s+(.+?):\s*(.+)$"),
        re.compile(r"^(.+?):\s*(.+)$"),
    ]

    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue

        matched = False
        for pat in patterns:
            m = pat.match(line)
            if m and len(m.groups()) >= 2:
                if len(m.groups()) == 3:
                    sender, dt, msg = m.group(1), m.group(2), m.group(3)
                else:
                    sender, msg = m.group(1), m.group(2)
                    dt = ""
                lines_out.append(f"**{sender.strip()}** `{dt}`")
                lines_out.append(f"> {msg.strip()}")
                lines_out.append("")
                count += 1
                matched = True
                break

        if not matched and line:
            lines_out.append(line)

    out = get_chat_path(vault, "group", fpath.stem, fpath.stem)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines_out), encoding="utf-8")
    return count


# ──────────────────────────────────────────────
#  ОБНОВЛЕНИЕ ИНДЕКСА VAULT
# ──────────────────────────────────────────────

def update_messenger_index(vault: Path):
    """Создаёт/обновляет индексную страницу мессенджера в vault."""
    messenger_path = vault / "02_Messenger"
    if not messenger_path.exists():
        return

    all_chats = list(messenger_path.rglob("*.md"))
    all_chats = [f for f in all_chats if "_index" not in f.name]

    private = [f for f in all_chats if "Личные" in str(f)]
    groups  = [f for f in all_chats if "Группы" in str(f)]

    def chat_links(files):
        return "\n".join([
            f"- [[{f.relative_to(vault).with_suffix('')}]]"
            for f in sorted(files)
        ]) or "_нет чатов_"

    index = f"""---
type: section_index
section: messenger
updated: "{datetime.now().strftime('%Y-%m-%d %H:%M')}"
---

# 💬 Яндекс Мессенджер

Последнее обновление: **{datetime.now().strftime('%d.%m.%Y %H:%M')}**
Всего чатов: **{len(all_chats)}**

## 👤 Личные чаты ({len(private)})

{chat_links(private)}

## 👥 Групповые чаты ({len(groups)})

{chat_links(groups)}
"""
    (messenger_path / "_index.md").write_text(index, encoding="utf-8")


# ──────────────────────────────────────────────
#  MAIN
# ──────────────────────────────────────────────

def run_sync(vault: Path):
    print(f"\n[{datetime.now().strftime('%H:%M:%S')}] 🔄 Синхронизация...")
    poll_updates(vault)
    update_messenger_index(vault)
    print(f"[{datetime.now().strftime('%H:%M:%S')}] ⏰ Следующая синхронизация через {SYNC_EVERY_HOURS} ч.")


def main():
    parser = argparse.ArgumentParser(description="Яндекс Мессенджер → Obsidian Vault")
    parser.add_argument("--parse-export", metavar="FOLDER",
                        help="Разово распарсить экспорт из папки")
    parser.add_argument("--once", action="store_true",
                        help="Одна синхронизация и выход (без расписания)")
    args = parser.parse_args()

    if BOT_TOKEN == "YOUR_BOT_TOKEN":
        print("❌ Укажите BOT_TOKEN в настройках скрипта!")
        print("   Токен берётся на admin.yandex.ru → Боты в Мессенджере")
        return

    vault = Path(VAULT_PATH)
    vault.mkdir(parents=True, exist_ok=True)

    print("╔══════════════════════════════════════════════╗")
    print("║  Яндекс Мессенджер → Obsidian               ║")
    print("╚══════════════════════════════════════════════╝")
    print(f"  Vault: {vault.resolve()}")

    # Режим: парсинг экспорта
    if args.parse_export:
        parse_export(vault, args.parse_export)
        update_messenger_index(vault)
        print("\n✅ Экспорт импортирован в vault!")
        return

    # Режим: одна синхронизация
    if args.once:
        run_sync(vault)
        return

    # Режим: автоматический polling по расписанию
    print(f"\n🚀 Запуск polling каждые {SYNC_EVERY_HOURS} ч.")
    print("   Остановка: Ctrl+C\n")

    # Сразу первый запуск
    run_sync(vault)

    # Потом по расписанию
    interval = SYNC_EVERY_HOURS * 3600
    while True:
        time.sleep(interval)
        run_sync(vault)


if __name__ == "__main__":
    main()
