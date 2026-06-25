#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════╗
║  Yandex → Obsidian Knowledge Vault                       ║
║  Источники: Почта (IMAP) + Мессенджер + Диск + Plaud     ║
╚══════════════════════════════════════════════════════════╝

УСТАНОВКА ЗАВИСИМОСТЕЙ:
    pip install requests tqdm python-dateutil

НАСТРОЙКА (измените 3 строки ниже):
"""

# ══════════════════════════════════════════════
#  ⚙️  НАСТРОЙТЕ ЭТИ ПЕРЕМЕННЫЕ
# ══════════════════════════════════════════════
YANDEX_LOGIN    = "s.klevtsov@auchan.ru"   # ← ваш логин
YANDEX_PASSWORD = "eooseilqbazoffpt"       # ← пароль приложения (см. инструкцию ниже)
OUTPUT_VAULT    = "/Users/ods/Downloads/AI/ObsidianVault"         # ← куда сохранять vault
ANTHROPIC_KEY   = "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"     # ← ключ Claude API для AI выжимок Plaud

# Дополнительные пути (опционально)
PLAUD_TXT_FOLDER        = "/Users/ods/Downloads/AI/plaud_transcripts"   # папка с .txt файлами от Plaud
YANDEX_MESSENGER_EXPORT = "/Users/ods/Downloads/AI/messenger_export"    # папка с экспортом Яндекс Мессенджера
YANDEX_DISK_FOLDER      = "/Users/ods/Yandex.Disk-s.klevtsov@auchan.ru.localized"   # локальная копия Яндекс.Диска

# ══════════════════════════════════════════════
#  📌 КАК ПОЛУЧИТЬ ПАРОЛЬ ПРИЛОЖЕНИЯ:
#  1. mail.yandex.ru → Настройки → Безопасность
#  2. "Пароли приложений" → Создать новый
#  3. Выберите "Почта" → скопируйте пароль
#  4. Также включите IMAP: Настройки → Почтовые программы → IMAP
# ══════════════════════════════════════════════

import imaplib
import email
import email.header
import os
import re
import json
import glob
from datetime import datetime
from pathlib import Path
from collections import defaultdict

try:
    from dateutil import parser as dateparser
    HAS_DATEUTIL = True
except ImportError:
    HAS_DATEUTIL = False

try:
    from tqdm import tqdm
    HAS_TQDM = True
except ImportError:
    HAS_TQDM = False


# ──────────────────────────────────────────────
#  УТИЛИТЫ
# ──────────────────────────────────────────────

def safe_filename(name: str, max_len=80) -> str:
    """Очищает строку для использования как имя файла."""
    name = re.sub(r'[\\/*?:"<>|]', '_', name)
    name = name.strip(". ")
    return name[:max_len] if name else "untitled"


def decode_header_value(value) -> str:
    """Декодирует заголовок письма (поддержка UTF-8, Base64, QP)."""
    if value is None:
        return ""
    parts = email.header.decode_header(value)
    result = []
    for part, charset in parts:
        if isinstance(part, bytes):
            charset = charset or "utf-8"
            try:
                result.append(part.decode(charset, errors="replace"))
            except Exception:
                result.append(part.decode("utf-8", errors="replace"))
        else:
            result.append(str(part))
    return " ".join(result)


def extract_email_body(msg) -> str:
    """Извлекает текстовое тело письма."""
    body = ""
    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            cd = str(part.get("Content-Disposition", ""))
            if ct == "text/plain" and "attachment" not in cd:
                try:
                    charset = part.get_content_charset() or "utf-8"
                    body = part.get_payload(decode=True).decode(charset, errors="replace")
                    break
                except Exception:
                    pass
    else:
        try:
            charset = msg.get_content_charset() or "utf-8"
            body = msg.get_payload(decode=True).decode(charset, errors="replace")
        except Exception:
            pass
    return body.strip()


def write_md(path: Path, content: str):
    """Сохраняет markdown файл."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def progress(iterable, desc=""):
    if HAS_TQDM:
        return tqdm(iterable, desc=desc, ncols=80)
    print(f"  → {desc} ({len(iterable) if hasattr(iterable, '__len__') else '?'} шт.)")
    return iterable


# ──────────────────────────────────────────────
#  1. ЯНДЕКС ПОЧТА — IMAP
# ──────────────────────────────────────────────

def fetch_yandex_mail(vault: Path, login: str, password: str) -> dict:
    """
    Скачивает письма через IMAP и сохраняет в Obsidian vault.
    При повторном запуске скачивает только новые письма.
    """
    print("\n📧 Яндекс Почта → IMAP")

    contacts = defaultdict(list)
    topics   = defaultdict(list)
    count    = 0
    skipped  = 0

    mail_vault = vault / "01_Email"
    mail_vault.mkdir(parents=True, exist_ok=True)

    # Индекс уже скачанных писем: {папка: [uid1, uid2, ...]}
    index_file = mail_vault / ".downloaded.json"
    try:
        downloaded = json.loads(index_file.read_text())
    except Exception:
        downloaded = {}

    try:
        imap = imaplib.IMAP4_SSL("imap.yandex.ru", 993)
        imap.login(login, password)
    except Exception as e:
        print(f"  ❌ Ошибка подключения к IMAP: {e}")
        print("  Убедитесь что:")
        print("  - IMAP включён в настройках Яндекс Почты")
        print("  - Используется пароль приложения (не основной пароль)")
        return {"emails": 0, "contacts": 0}

    # Получаем список папок (Яндекс возвращает их в особом формате)
    _, folders_raw = imap.list()
    folders = []  # список кортежей (display_name, imap_name)

    for f in folders_raw:
        try:
            line = f.decode("utf-8", errors="replace")

            # Формат Яндекса:
            # (\HasChildren) "|" "Data Flow - clickhouse-kafka"
            # (\HasNoChildren) "|" INBOX
            # (\HasNoChildren) "|" "Accesses|CheckPoint"

            # Ищем имя папки — всё после разделителя "|" или "/"
            m = re.search(r'"[|/]"\s+(.+)$', line)
            if not m:
                continue

            raw_name = m.group(1).strip()
            # Убираем внешние кавычки если есть
            if raw_name.startswith('"') and raw_name.endswith('"'):
                raw_name = raw_name[1:-1]

            folders.append(raw_name)
        except Exception:
            continue

    # Если парсинг не дал результатов — стандартные папки Яндекса
    if not folders:
        folders = ["INBOX", "Sent", "Drafts", "Spam", "Trash"]

    print(f"  Найдено папок: {len(folders)}")
    if len(folders) > 5:
        print(f"  Папки: {', '.join(folders[:10])}{'...' if len(folders) > 10 else ''}")

    for folder in folders:
        try:
            # Пробуем разные варианты выбора папки
            status = "NO"
            tried = []

            # 1. Имя как есть в кавычках (самый надёжный для Яндекса)
            for attempt in [
                f'"{folder}"',           # "Data Flow - clickhouse-kafka"
                folder,                  # INBOX (без кавычек)
                f'"{folder.upper()}"',   # "INBOX"
            ]:
                try:
                    status, _ = imap.select(attempt, readonly=True)
                    if status == "OK":
                        break
                    tried.append(attempt)
                except Exception:
                    tried.append(attempt)
                    continue

            if status != "OK":
                continue

        except Exception:
            continue

        _, data = imap.search(None, "ALL")
        uids = data[0].split()
        if not uids:
            continue

        # Для вложенных папок (Accesses|CheckPoint) создаём подпапки
        folder_parts  = folder.replace("|", "/").split("/")
        folder_safe   = "/".join(safe_filename(p) for p in folder_parts)
        folder_path   = mail_vault / folder_safe
        folder_path.mkdir(parents=True, exist_ok=True)

        # Фильтруем уже скачанные UID
        done_uids = set(downloaded.get(folder, []))
        new_uids  = [u for u in uids if u.decode() not in done_uids]

        folder_skipped = len(uids) - len(new_uids)
        if folder_skipped:
            print(f"  📁 {folder}: {len(uids)} писем ({len(new_uids)} новых, {folder_skipped} пропущено)")
        else:
            print(f"  📁 {folder}: {len(uids)} писем (все новые)")

        if not new_uids:
            continue

        for uid in progress(new_uids, desc=safe_filename(folder_parts[-1])):
            try:
                _, msg_data = imap.fetch(uid, "(RFC822)")
                raw = msg_data[0][1]
                msg = email.message_from_bytes(raw)

                subject  = decode_header_value(msg.get("Subject", "Без темы"))
                from_    = decode_header_value(msg.get("From", ""))
                to_      = decode_header_value(msg.get("To", ""))
                date_str = msg.get("Date", "")
                body     = extract_email_body(msg)

                # Парсим дату
                try:
                    if HAS_DATEUTIL:
                        dt = dateparser.parse(date_str)
                        date_fmt = dt.strftime("%Y-%m-%d") if dt else "unknown"
                        date_display = dt.strftime("%d.%m.%Y %H:%M") if dt else date_str
                    else:
                        date_fmt = "unknown"
                        date_display = date_str
                except Exception:
                    date_fmt = "unknown"
                    date_display = date_str

                # Извлекаем email-адрес отправителя
                email_match = re.search(r"<(.+?)>", from_)
                sender_email = email_match.group(1) if email_match else from_
                sender_name  = re.sub(r"<.+?>", "", from_).strip().strip('"') or sender_email

                # Регистрируем контакт и тему
                contacts[sender_email].append(subject)
                topics[subject[:50]].append(date_fmt)

                # Создаём markdown заметку
                fname = safe_filename(f"{date_fmt}_{subject[:50]}")
                fpath = folder_path / f"{fname}.md"

                # Wikilinks на контакт
                contact_link = f"[[Contacts/{safe_filename(sender_name)}]]"

                md = f"""---
type: email
folder: {folder}
from: "{from_}"
to: "{to_}"
subject: "{subject}"
date: {date_fmt}
source: yandex_mail
---

# {subject}

**От:** {contact_link} (`{sender_email}`)
**Кому:** {to_}
**Дата:** {date_display}
**Папка:** {folder}

---

{body}
"""
                write_md(fpath, md)
                count += 1

                # Запоминаем скачанный UID
                if folder not in downloaded:
                    downloaded[folder] = []
                downloaded[folder].append(uid.decode())

            except Exception as e:
                continue  # пропускаем проблемные письма

        # Сохраняем индекс после каждой папки
        index_file.write_text(json.dumps(downloaded, ensure_ascii=False))
        skipped += folder_skipped if "folder_skipped" in dir() else 0

    imap.logout()

    # Итоговая статистика
    total_skipped = sum(
        len(downloaded.get(f, [])) for f in downloaded
    ) - count
    print(f"  ✅ Новых писем скачано: {count}")
    if total_skipped > 0:
        print(f"  ⏭️  Уже были в vault: {total_skipped} (пропущены)")
    return {"emails": count, "contacts": dict(contacts), "topics": dict(topics)}


# ──────────────────────────────────────────────
#  2. ЯНДЕКС МЕССЕНДЖЕР
# ──────────────────────────────────────────────

def parse_yandex_messenger(vault: Path, export_folder: str) -> dict:
    """
    Парсит экспорт Яндекс Мессенджера.
    Поддерживает форматы: JSON, TXT
    """
    print("\n💬 Яндекс Мессенджер")

    export_path = Path(export_folder)
    if not export_path.exists():
        print(f"  ⚠️  Папка не найдена: {export_folder}")
        print("  Как экспортировать: messenger.yandex.ru → ⋮ → Экспорт истории")
        return {"chats": 0}

    msg_vault = vault / "02_Messenger"
    msg_vault.mkdir(parents=True, exist_ok=True)

    count = 0
    contacts = set()

    import mailbox as mailbox_lib

    json_files = list(export_path.glob("**/*.json"))
    txt_files  = list(export_path.glob("**/*.txt"))

    # Яндекс экспортирует mbox как ПАПКУ с именем "Folder.mbox"
    # внутри лежит файл "mbox" (без расширения)
    # Ищем оба варианта: файлы *.mbox И файлы "mbox" внутри папок *.mbox
    mbox_files = []

    # Вариант 1: обычные файлы с расширением .mbox
    mbox_files += list(export_path.glob("**/*.mbox"))

    # Вариант 2: папки *.mbox содержащие файл "mbox" (формат Яндекса)
    for folder in export_path.glob("**/*.mbox"):
        if folder.is_dir():
            mbox_inner = folder / "mbox"
            if mbox_inner.exists():
                mbox_files.append(mbox_inner)

    # Убираем дубликаты
    mbox_files = list({str(f): f for f in mbox_files}.values())
    # Убираем папки — оставляем только файлы
    mbox_files = [f for f in mbox_files if f.is_file()]

    all_files = json_files + txt_files

    if not mbox_files and not all_files:
        found = list(export_path.iterdir())
        print(f"  ⚠️  Файлы экспорта не найдены в {export_folder}")
        print(f"  Содержимое папки: {[f.name for f in found[:10]]}")
        return {"chats": 0}

    print(f"  Найдено: json={len(json_files)}, txt={len(txt_files)}, mbox-папок={len(mbox_files)}")

    # ── Сначала обрабатываем все mbox ──
    for mbox_path in mbox_files:
        try:
            # Имя папки (например "Accesses.mbox") → красивое имя ящика
            folder_name = mbox_path.parent.name  # "Accesses.mbox"
            mailbox_name = folder_name.replace(".mbox", "") if folder_name.endswith(".mbox") else mbox_path.stem

            print(f"  📧 Читаю: {mailbox_name}...")
            mbox = mailbox_lib.mbox(str(mbox_path))

            mail_vault_folder = vault / "01_Email" / safe_filename(mailbox_name)
            mail_vault_folder.mkdir(parents=True, exist_ok=True)

            msg_count = 0
            for msg in mbox:
                try:
                    subject  = decode_header_value(msg.get("Subject", "Без темы"))
                    from_    = decode_header_value(msg.get("From", ""))
                    to_      = decode_header_value(msg.get("To", ""))
                    date_str = msg.get("Date", "")

                    # Парсим дату
                    try:
                        if HAS_DATEUTIL:
                            dt = dateparser.parse(date_str)
                            date_fmt = dt.strftime("%Y-%m-%d") if dt else "unknown"
                            date_display = dt.strftime("%d.%m.%Y %H:%M") if dt else date_str
                        else:
                            date_fmt = "unknown"
                            date_display = date_str
                    except Exception:
                        date_fmt = "unknown"
                        date_display = date_str

                    # Тело письма
                    body = ""
                    if msg.is_multipart():
                        for part in msg.walk():
                            if part.get_content_type() == "text/plain":
                                try:
                                    charset = part.get_content_charset() or "utf-8"
                                    body = part.get_payload(decode=True).decode(charset, errors="replace")
                                    break
                                except Exception:
                                    pass
                    else:
                        try:
                            charset = msg.get_content_charset() or "utf-8"
                            raw = msg.get_payload(decode=True)
                            if raw:
                                body = raw.decode(charset, errors="replace")
                        except Exception:
                            body = str(msg.get_payload() or "")

                    body = body.strip()[:3000]

                    # Отправитель для контактов
                    email_match = re.search(r"<(.+?)>", from_)
                    sender_email = email_match.group(1) if email_match else from_
                    contacts.add(from_)

                    # Каждое письмо — отдельный файл
                    fname = safe_filename(f"{date_fmt}_{subject[:50]}")
                    md = f"""---
type: email
mailbox: "{mailbox_name}"
from: "{from_}"
to: "{to_}"
subject: "{subject}"
date: {date_fmt}
source: mbox_export
---

# {subject}

**От:** {from_}
**Кому:** {to_}
**Дата:** {date_display}
**Папка:** {mailbox_name}

---

{body}
"""
                    write_md(mail_vault_folder / f"{fname}.md", md)
                    msg_count += 1
                    contacts.add(from_)

                except Exception:
                    continue

            print(f"  ✅ {mailbox_name}: {msg_count} писем")
            count += msg_count

        except Exception as e:
            print(f"  ⚠️  Ошибка в {mbox_path}: {e}")
            continue

    # ── Затем json и txt ──
    for fpath in progress(all_files, desc="Чаты"):
        try:
            if fpath.suffix == ".json":
                data = json.loads(fpath.read_text(encoding="utf-8"))
                chat_name = data.get("name", fpath.stem)
                messages  = data.get("messages", [])

                md_lines = [
                    f"---",
                    f"type: messenger_chat",
                    f"chat: \"{chat_name}\"",
                    f"messages_count: {len(messages)}",
                    f"source: yandex_messenger",
                    f"---",
                    f"",
                    f"# 💬 {chat_name}",
                    f"",
                ]

                for msg in messages:
                    sender = msg.get("from", msg.get("author", "unknown"))
                    text   = msg.get("text", msg.get("body", ""))
                    ts     = msg.get("date", msg.get("timestamp", ""))
                    contacts.add(str(sender))
                    if text:
                        md_lines.append(f"**{sender}** `{ts}`")
                        md_lines.append(f"> {text}")
                        md_lines.append("")

                fname = safe_filename(chat_name)
                write_md(msg_vault / f"{fname}.md", "\n".join(md_lines))
                count += 1

            elif fpath.suffix == ".txt":
                text = fpath.read_text(encoding="utf-8", errors="replace")
                chat_name = fpath.stem
                md = f"""---
type: messenger_chat
chat: "{chat_name}"
source: yandex_messenger
---

# 💬 {chat_name}

{text}
"""
                write_md(msg_vault / f"{safe_filename(chat_name)}.md", md)
                count += 1

        except Exception as e:
            print(f"  ⚠️  Ошибка в {fpath.name}: {e}")
            continue

    print(f"  ✅ Сохранено чатов: {count}")
    return {"chats": count, "contacts": list(contacts)}


# ──────────────────────────────────────────────
#  3. ЯНДЕКС ДИСК
# ──────────────────────────────────────────────

def parse_yandex_disk(vault: Path, disk_folder: str) -> dict:
    """
    Обрабатывает файлы из локальной копии Яндекс.Диска.
    Поддерживает: .txt, .md, .json, .csv
    """
    print("\n💾 Яндекс Диск")

    disk_path = Path(disk_folder)
    if not disk_path.exists():
        print(f"  ⚠️  Папка не найдена: {disk_folder}")
        print("  Установите Яндекс.Диск и синхронизируйте нужные папки")
        return {"files": 0}

    disk_vault = vault / "03_YandexDisk"
    disk_vault.mkdir(parents=True, exist_ok=True)

    count = 0
    extensions = {".txt", ".md", ".json", ".csv", ".html"}

    all_files = [
        f for f in disk_path.rglob("*")
        if f.is_file() and f.suffix.lower() in extensions
    ]

    print(f"  Найдено файлов: {len(all_files)}")

    for fpath in progress(all_files, desc="Файлы Диска"):
        try:
            text = fpath.read_text(encoding="utf-8", errors="replace")
            rel  = fpath.relative_to(disk_path)

            # Сохраняем структуру папок
            out_path = disk_vault / rel.parent / f"{safe_filename(fpath.stem)}.md"

            md = f"""---
type: disk_file
original_path: "{rel}"
original_name: "{fpath.name}"
source: yandex_disk
---

# 📄 {fpath.name}

{text}
"""
            write_md(out_path, md)
            count += 1

        except Exception:
            continue

    print(f"  ✅ Сохранено файлов: {count}")
    return {"files": count}


# ──────────────────────────────────────────────
#  4. PLAUD NOTE ТРАНСКРИПЦИИ + AI ВЫЖИМКА
# ──────────────────────────────────────────────

def generate_plaud_summary(text: str, filename: str, anthropic_key: str) -> dict:
    """
    Генерирует структурированную выжимку транскрипции через Claude API.
    Возвращает словарь с саммари, задачами, людьми, проектами.
    """
    try:
        import anthropic
        client = anthropic.Anthropic(api_key=anthropic_key)

        prompt = f"""Проанализируй транскрипцию голосовой записи и выдай структурированную выжимку.

Транскрипция ({filename}):
{text[:6000]}

Ответь СТРОГО в формате JSON (без markdown, без пояснений):
{{
  "title": "короткое название записи (5-7 слов)",
  "summary": "о чём говорили — 2-4 предложения",
  "decisions": ["решение 1", "решение 2"],
  "tasks": [
    {{"task": "описание задачи", "who": "ответственный или пусто", "deadline": "срок или пусто"}}
  ],
  "people": ["Имя Фамилия или @упоминание"],
  "projects": ["название проекта или темы"],
  "key_points": ["ключевой момент 1", "ключевой момент 2", "ключевой момент 3"]
}}"""

        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1000,
            messages=[{"role": "user", "content": prompt}]
        )
        raw = response.content[0].text.strip()
        # Убираем возможные markdown-блоки
        raw = re.sub(r"```json|```", "", raw).strip()
        return json.loads(raw)

    except Exception as e:
        print(f"    ⚠️  AI выжимка не удалась: {e}")
        return None


def format_plaud_md(fpath_stem: str, date_str: str, text: str,
                    speakers: set, summary: dict = None) -> str:
    """Формирует итоговый Markdown для транскрипции с выжимкой."""

    words = len(text.split())

    # Блок выжимки
    if summary:
        title = summary.get("title", fpath_stem)

        people_links = " ".join([
            f"[[Contacts/{safe_filename(p)}]]"
            for p in summary.get("people", []) if p
        ])

        projects_links = " ".join([
            f"[[Projects/{safe_filename(p)}]]"
            for p in summary.get("projects", []) if p
        ])

        tasks_md = "\n".join([
            f"- [ ] {t.get('task','')} "
            f"{'— ' + t.get('who','') if t.get('who') else ''} "
            f"{'(' + t.get('deadline','') + ')' if t.get('deadline') else ''}"
            for t in summary.get("tasks", [])
        ]) or "_задач не найдено_"

        decisions_md = "\n".join([
            f"- {d}" for d in summary.get("decisions", [])
        ]) or "_решений не найдено_"

        key_points_md = "\n".join([
            f"- {k}" for k in summary.get("key_points", [])
        ])

        summary_block = f"""## 🤖 AI Выжимка

**О чём:** {summary.get('summary', '')}

### Ключевые моменты
{key_points_md}

### Решения
{decisions_md}

### Задачи
{tasks_md}

### Люди
{people_links or '_не упомянуты_'}

### Проекты и темы
{projects_links or '_не упомянуты_'}

---
"""
    else:
        title = fpath_stem
        summary_block = "_Выжимка не сгенерирована (нет ANTHROPIC_KEY)_\n\n---\n"

    speakers_str = ", ".join(sorted(speakers)[:10]) if speakers else "—"

    return f"""---
type: voice_transcript
source: plaud_note
date: {date_str}
original_file: "{fpath_stem}.txt"
speakers: {list(speakers)}
word_count: {words}
has_summary: {"true" if summary else "false"}
---

# 🎙️ {title}

**Дата:** {date_str}
**Слов:** {words}
**Спикеры:** {speakers_str}

{summary_block}
## 📝 Полная транскрипция

{text}
"""


def parse_plaud_transcripts(vault: Path, plaud_folder: str,
                            anthropic_key: str = "") -> dict:
    """
    Парсит .txt транскрипции из Plaud Note.
    Каждый файл = одна запись + AI выжимка если есть anthropic_key.
    Пропускает уже обработанные файлы (инкрементальное обновление).
    """
    print("\n🎙️  Plaud Note транскрипции")

    plaud_path = Path(plaud_folder)
    if not plaud_path.exists():
        print(f"  ⚠️  Папка не найдена: {plaud_folder}")
        return {"transcripts": 0}

    plaud_vault = vault / "04_Plaud_Transcripts"
    plaud_vault.mkdir(parents=True, exist_ok=True)

    # Индекс уже обработанных файлов
    processed_index = plaud_vault / ".processed.json"
    try:
        processed = json.loads(processed_index.read_text())
    except Exception:
        processed = {}

    txt_files = list(plaud_path.glob("*.txt"))
    print(f"  Найдено транскрипций: {len(txt_files)}")

    if anthropic_key:
        print("  🤖 AI выжимка: включена (Claude API)")
    else:
        print("  ⚠️  AI выжимка: выключена (укажите ANTHROPIC_KEY)")

    count    = 0
    skipped  = 0
    topics   = []

    for fpath in progress(txt_files, desc="Транскрипции"):
        try:
            # Проверяем изменился ли файл (по размеру+дате)
            file_sig = f"{fpath.stat().st_size}_{fpath.stat().st_mtime}"
            out_name = safe_filename(f"{fpath.stem}")

            if processed.get(fpath.name) == file_sig:
                skipped += 1
                continue  # файл не изменился — пропускаем

            text = fpath.read_text(encoding="utf-8", errors="replace").strip()
            if not text:
                continue

            # Дата из имени файла
            date_match = re.search(r"(\d{4}[-_]\d{2}[-_]\d{2})", fpath.stem)
            date_str   = date_match.group(1).replace("_", "-") if date_match else "unknown"

            # Спикеры
            speakers = set(re.findall(r"^([^:\n]{2,30}):", text, re.MULTILINE))
            speakers = {s.strip() for s in speakers if len(s.strip()) > 1}

            first_line = text.split("\n")[0][:80]
            topics.append(first_line)

            # AI выжимка
            summary = None
            if anthropic_key and len(text) > 100:
                print(f"    🤖 Генерирую выжимку: {fpath.name}...")
                summary = generate_plaud_summary(text, fpath.stem, anthropic_key)

            # Формируем и сохраняем заметку
            md = format_plaud_md(fpath.stem, date_str, text, speakers, summary)
            write_md(plaud_vault / f"{out_name}.md", md)

            # Запоминаем обработанный файл
            processed[fpath.name] = file_sig
            count += 1

        except Exception as e:
            print(f"  ⚠️  Ошибка в {fpath.name}: {e}")
            continue

    # Сохраняем индекс обработанных
    processed_index.write_text(json.dumps(processed, ensure_ascii=False))

    # Создаём сводный дайджест всех записей
    _create_plaud_digest(vault, plaud_vault)

    if skipped:
        print(f"  ⏭️  Пропущено (не изменились): {skipped}")
    print(f"  ✅ Обработано транскрипций: {count}")
    return {"transcripts": count, "topics": topics}


def _create_plaud_digest(vault: Path, plaud_vault: Path):
    """Создаёт сводную страницу всех Plaud записей с мини-саммари."""
    all_notes = sorted(
        [f for f in plaud_vault.glob("*.md") if not f.name.startswith("_")],
        reverse=True
    )

    lines = [
        "---",
        "type: plaud_digest",
        f"updated: \"{datetime.now().strftime('%Y-%m-%d %H:%M')}\"",
        "---",
        "",
        "# 🎙️ Все голосовые записи",
        "",
        f"Всего записей: **{len(all_notes)}**  ",
        f"Обновлено: {datetime.now().strftime('%d.%m.%Y %H:%M')}",
        "",
    ]

    for note in all_notes:
        try:
            content = note.read_text(encoding="utf-8")
            # Достаём дату и саммари из файла
            date_m   = re.search(r"^date:\s*(.+)$", content, re.MULTILINE)
            summ_m   = re.search(r"\*\*О чём:\*\*\s*(.+)", content)
            date_val = date_m.group(1).strip() if date_m else "—"
            summ_val = summ_m.group(1).strip()[:120] if summ_m else "_без выжимки_"
            lines.append(f"### [[04_Plaud_Transcripts/{note.stem}|{note.stem}]]")
            lines.append(f"**{date_val}** — {summ_val}")
            lines.append("")
        except Exception:
            continue

    write_md(plaud_vault / "_digest.md", "\n".join(lines))


# ──────────────────────────────────────────────
#  5. КОНТАКТЫ — ИНДЕКСНЫЕ СТРАНИЦЫ
# ──────────────────────────────────────────────

def create_contacts(vault: Path, email_stats: dict):
    """Создаёт страницу для каждого контакта с упоминаниями."""
    print("\n👤 Создаю контакты...")

    contacts_vault = vault / "Contacts"
    contacts_vault.mkdir(parents=True, exist_ok=True)

    contacts = email_stats.get("contacts", {})
    count = 0

    for email_addr, subjects in contacts.items():
        name  = email_addr.split("@")[0]
        fname = safe_filename(name)

        links = "\n".join([f"- [[01_Email/{safe_filename(s[:50])}]]" for s in subjects[:20]])

        md = f"""---
type: contact
email: "{email_addr}"
source: yandex_mail
messages_count: {len(subjects)}
---

# 👤 {name}

**Email:** `{email_addr}`
**Писем:** {len(subjects)}

## Переписка

{links}
"""
        write_md(contacts_vault / f"{fname}.md", md)
        count += 1

    print(f"  ✅ Создано контактов: {count}")
    return count


# ──────────────────────────────────────────────
#  6. ГЛАВНАЯ КАРТА ЗНАНИЙ (MOC)
# ──────────────────────────────────────────────

def create_moc(vault: Path, stats: dict):
    """Создаёт главную навигационную карту знаний."""
    print("\n🗺️  Создаю карту знаний (MOC)...")

    now = datetime.now().strftime("%d.%m.%Y %H:%M")

    # Собираем статистику файлов
    total_files = sum(1 for _ in vault.rglob("*.md"))

    moc = f"""---
type: moc
title: "Главная карта знаний"
created: "{now}"
---

# 🧠 База знаний

> Сгенерировано: {now}

## 📊 Статистика

| Источник | Записей |
|---|---|
| 📧 Яндекс Почта | {stats.get('emails', 0)} |
| 💬 Яндекс Мессенджер | {stats.get('chats', 0)} |
| 💾 Яндекс Диск | {stats.get('files', 0)} |
| 🎙️ Plaud транскрипции | {stats.get('transcripts', 0)} |
| 👤 Контакты | {stats.get('contacts', 0)} |
| **Всего заметок** | **{total_files}** |

## 🗂️ Разделы

- [[01_Email/|📧 Вся переписка]]
- [[02_Messenger/|💬 Мессенджер]]
- [[03_YandexDisk/|💾 Яндекс Диск]]
- [[04_Plaud_Transcripts/|🎙️ Голосовые записи]]
- [[Contacts/|👤 Контакты]]

## 🔍 Быстрая навигация

### По типу
- Тип: `email` → все письма
- Тип: `messenger_chat` → все чаты
- Тип: `voice_transcript` → все транскрипции
- Тип: `disk_file` → файлы с диска
- Тип: `contact` → все контакты

### Советы по работе в Obsidian
1. Откройте граф: `Ctrl+G` — видите все связи
2. Поиск по тегам: `#тип` в строке поиска
3. Dataview плагин: запросы `WHERE type = "email"`
4. Canvas: создайте доску из заметок

---
*Создано скриптом yandex_to_obsidian.py*
"""

    write_md(vault / "000_MOC.md", moc)

    # Навигационные карты по разделам
    sections = [
        ("01_Email", "📧 Email переписка", "email"),
        ("02_Messenger", "💬 Мессенджер", "messenger_chat"),
        ("03_YandexDisk", "💾 Яндекс Диск", "disk_file"),
        ("04_Plaud_Transcripts", "🎙️ Голосовые записи", "voice_transcript"),
    ]

    for folder, title, type_tag in sections:
        folder_path = vault / folder
        if folder_path.exists():
            files = list(folder_path.rglob("*.md"))
            links = "\n".join([
                f"- [[{f.relative_to(vault).with_suffix('')}]]"
                for f in sorted(files)[:100]  # первые 100
            ])
            section_moc = f"""---
type: section_index
section: "{folder}"
---

# {title}

Записей в разделе: **{len(files)}**

## Содержимое

{links}
{"..." if len(files) > 100 else ""}
"""
            write_md(folder_path / "_index.md", section_moc)

    print("  ✅ Карта знаний создана: 000_MOC.md")


# ──────────────────────────────────────────────
#  MAIN
# ──────────────────────────────────────────────

def main():
    print("╔══════════════════════════════════════════════╗")
    print("║  Yandex → Obsidian Knowledge Vault Builder   ║")
    print("╚══════════════════════════════════════════════╝")

    vault = Path(OUTPUT_VAULT)
    vault.mkdir(parents=True, exist_ok=True)
    print(f"\n📂 Vault: {vault.resolve()}")

    stats = {}

    # 1. Яндекс Почта (IMAP)
    if YANDEX_LOGIN != "your_login@yandex.ru":
        email_result = fetch_yandex_mail(vault, YANDEX_LOGIN, YANDEX_PASSWORD)
        stats["emails"]   = email_result.get("emails", 0)
        contacts_count    = create_contacts(vault, email_result)
        stats["contacts"] = contacts_count
    else:
        print("\n⚠️  Почта пропущена — укажите YANDEX_LOGIN и YANDEX_PASSWORD")
        stats["emails"]   = 0
        stats["contacts"] = 0

    # 2. Яндекс Мессенджер
    messenger_result = parse_yandex_messenger(vault, YANDEX_MESSENGER_EXPORT)
    stats["chats"] = messenger_result.get("chats", 0)

    # 3. Яндекс Диск
    disk_result = parse_yandex_disk(vault, YANDEX_DISK_FOLDER)
    stats["files"] = disk_result.get("files", 0)

    # 4. Plaud транскрипции
    _key = ANTHROPIC_KEY if ANTHROPIC_KEY != "your_anthropic_key" else ""
    plaud_result = parse_plaud_transcripts(vault, PLAUD_TXT_FOLDER, anthropic_key=_key)
    stats["transcripts"] = plaud_result.get("transcripts", 0)

    # 5. Главная карта знаний
    create_moc(vault, stats)

    # Итог
    total = sum(1 for _ in vault.rglob("*.md"))
    print("\n╔══════════════════════════════════════════════╗")
    print("║  ✅ ГОТОВО!                                   ║")
    print("╠══════════════════════════════════════════════╣")
    print(f"║  📧 Писем:           {stats['emails']:<6}                  ║")
    print(f"║  💬 Чатов:           {stats['chats']:<6}                  ║")
    print(f"║  💾 Файлов с диска:  {stats['files']:<6}                  ║")
    print(f"║  🎙️  Транскрипций:   {stats['transcripts']:<6}                  ║")
    print(f"║  👤 Контактов:       {stats['contacts']:<6}                  ║")
    print(f"║  📝 Всего заметок:   {total:<6}                  ║")
    print("╠══════════════════════════════════════════════╣")
    print(f"║  📂 Vault: {str(vault.resolve())[:38]:<38} ║")
    print("╚══════════════════════════════════════════════╝")
    print("\n🚀 Откройте Obsidian → Open folder as vault → выберите папку выше")
    print("   Граф знаний: Ctrl+G")


if __name__ == "__main__":
    main()
