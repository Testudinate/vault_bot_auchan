#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════╗
║  Vault Bot v3 — Полный агент по личной базе знаний           ║
║                                                              ║
║  Новое в v3:                                                 ║
║  • Временной поиск («письма за март», «прошлая неделя»)      ║
║  • Поиск по людям (/person Иванов)                           ║
║  • Кросс-источниковые ответы                                 ║
║  • Проактивные инсайты (/insights)                           ║
║  • Цепочка рассуждений для сложных вопросов                  ║
║  • Задачи с отметкой выполнения (/tasks)                     ║
║  • Аналитика активности (/analytics)                         ║
║  • Голосовые сообщения → транскрипция → поиск                ║
║  • Избранное (/favorites)                                     ║
║  • Экспорт результатов в файл                                ║
╚══════════════════════════════════════════════════════════════╝

УСТАНОВКА:
    pip install python-telegram-bot anthropic rank-bm25

ЗАПУСК:
    python vault_bot.py
"""

# ══════════════════════════════════════════════
#  Все настройки загружаются из .env файла
#  Скопируйте: cp .env.template .env
#  Заполните токены в .env и запустите бота
# ══════════════════════════════════════════════
from config import (
    TELEGRAM_TOKEN, ANTHROPIC_KEY, GROK_KEY, GROQ_KEY,
    VAULT_PATH, ALLOWED_USER_ID, MY_EMAIL,
    ALERT_KEYWORDS, DIGEST_WEEKDAY, DIGEST_HOUR,
    GROK_STT_URL, GROK_CHAT_URL, GROK_CHAT_MODEL, GROK_LANGUAGE,
    GROQ_CHAT_URL, GROQ_MODEL, AVAILABLE_MODELS, DEFAULT_MODEL,
    YANDEX_DISK_TOKEN, MY_KERNEL_ID,
)
MY_NAME = MY_EMAIL.split("@")[0].replace(".", " ").title()
# ══════════════════════════════════════════════

import re, json, hashlib, logging, math, requests
import ssl, urllib3

# Глобальный фикс SSL для Python 3.9 на macOS
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
try:
    _orig_https = ssl.SSLContext.wrap_socket
    def _patched_wrap(self, *args, **kwargs):
        kwargs.setdefault("server_hostname", None)
        try:
            return _orig_https(self, *args, **kwargs)
        except ssl.SSLEOFError:
            self.check_hostname = False
            self.verify_mode    = ssl.CERT_NONE
            return _orig_https(self, *args, **kwargs)
    ssl.SSLContext.wrap_socket = _patched_wrap
except Exception:
    pass
from pathlib import Path
from datetime import datetime, timedelta
from typing import Optional
from collections import defaultdict, Counter

import anthropic
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, Voice
from telegram.ext import (
    Application, CommandHandler, MessageHandler,
    CallbackQueryHandler, ContextTypes, filters
)

try:
    from rank_bm25 import BM25Okapi
    HAS_BM25 = True
except ImportError:
    HAS_BM25 = False

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(message)s",
    level=logging.INFO,
    handlers=[logging.FileHandler("vault_bot.log"), logging.StreamHandler()]
)
log = logging.getLogger(__name__)


# ──────────────────────────────────────────────
#  ХРАНИЛИЩЕ СОСТОЯНИЯ
# ──────────────────────────────────────────────

STATE_FILE = ".vault_bot_state.json"

def load_state() -> dict:
    try:
        state = json.loads(Path(STATE_FILE).read_text(encoding="utf-8"))
        # Добавляем отсутствующие поля для обратной совместимости
        state.setdefault("filters",      {})
        state.setdefault("dialogs",      {})
        state.setdefault("favorites",    {})
        state.setdefault("tasks",        {})
        state.setdefault("active_model", {})
        state.setdefault("token_stats",  {})
        return state
    except Exception:
        return {"filters": {}, "dialogs": {}, "favorites": {}, "tasks": {},
                "active_model": {}, "token_stats": {}}

def save_state(state: dict):
    Path(STATE_FILE).write_text(
        json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")

STATE = load_state()

# Активная модель пользователя
def get_active_model(uid: int) -> dict:
    key = STATE["active_model"].get(str(uid), DEFAULT_MODEL)
    return AVAILABLE_MODELS.get(key, AVAILABLE_MODELS[DEFAULT_MODEL])

def set_active_model(uid: int, model_key: str):
    STATE["active_model"][str(uid)] = model_key
    save_state(STATE)

def get_model_key(uid: int) -> str:
    return STATE["active_model"].get(str(uid), DEFAULT_MODEL)

# Статистика токенов
def add_tokens(uid: int, model_key: str, tokens_in: int, tokens_out: int):
    u = str(uid)
    if "token_stats" not in STATE:
        STATE["token_stats"] = {}
    if u not in STATE["token_stats"]:
        STATE["token_stats"][u] = {}
    if model_key not in STATE["token_stats"][u]:
        STATE["token_stats"][u][model_key] = {"in": 0, "out": 0, "requests": 0}
    STATE["token_stats"][u][model_key]["in"]       += tokens_in
    STATE["token_stats"][u][model_key]["out"]      += tokens_out
    STATE["token_stats"][u][model_key]["requests"] += 1
    save_state(STATE)
    log.debug(f"Tokens saved: uid={uid} model={model_key} in={tokens_in} out={tokens_out}")

def get_token_stats(uid: int) -> dict:
    return STATE["token_stats"].get(str(uid), {})

# Фильтры
def get_filter(uid: int) -> dict:
    return STATE["filters"].get(str(uid), {"folders": [], "types": []})

def set_filter(uid: int, key: str, value):
    u = str(uid)
    if u not in STATE["filters"]:
        STATE["filters"][u] = {"folders": [], "types": []}
    STATE["filters"][u][key] = value
    save_state(STATE)

# Диалог
def get_dialog(uid: int) -> list:
    return STATE["dialogs"].get(str(uid), [])

def add_to_dialog(uid: int, role: str, content: str):
    u = str(uid)
    if u not in STATE["dialogs"]:
        STATE["dialogs"][u] = []
    STATE["dialogs"][u].append({"role": role, "content": content[:2000]})
    STATE["dialogs"][u] = STATE["dialogs"][u][-10:]
    save_state(STATE)

def clear_dialog(uid: int):
    STATE["dialogs"][str(uid)] = []
    save_state(STATE)

# Избранное
def get_favorites(uid: int) -> list:
    return STATE["favorites"].get(str(uid), [])

def add_favorite(uid: int, doc: dict):
    u = str(uid)
    if u not in STATE["favorites"]:
        STATE["favorites"][u] = []
    entry = {"title": doc.get("title",""), "path": doc.get("path",""),
             "date": doc.get("date",""), "folder": doc.get("folder",""),
             "saved_at": datetime.now().strftime("%Y-%m-%d %H:%M")}
    if not any(f["path"] == entry["path"] for f in STATE["favorites"][u]):
        STATE["favorites"][u].append(entry)
    save_state(STATE)

# Задачи
def get_tasks(uid: int) -> list:
    return STATE["tasks"].get(str(uid), [])

def save_tasks(uid: int, tasks: list):
    STATE["tasks"][str(uid)] = tasks
    save_state(STATE)


# ──────────────────────────────────────────────
#  ВРЕМЕННОЙ ПАРСЕР
# ──────────────────────────────────────────────

def parse_time_expression(text: str) -> tuple:
    """
    Парсит временные выражения из запроса.
    Возвращает (date_from, date_to, cleaned_query).
    """
    now   = datetime.now()
    text_lower = text.lower()

    date_from = date_to = None
    cleaned   = text

    patterns = [
        # «за прошлую неделю», «на прошлой неделе»
        (r"(за |на |прошл\w+ )(недел\w+)",
         lambda: (now - timedelta(days=now.weekday()+7),
                  now - timedelta(days=now.weekday()+1))),
        # «за эту неделю»
        (r"(за |эт\w+ )(недел\w+)",
         lambda: (now - timedelta(days=now.weekday()), now)),
        # «за последние N дней»
        (r"за последни\w+ (\d+) дн\w+",
         lambda m: (now - timedelta(days=int(m.group(1))), now)),
        # «за вчера»
        (r"вчера|за вчера",
         lambda: (now - timedelta(days=1), now - timedelta(days=1))),
        # «за сегодня»
        (r"сегодня|за сегодня",
         lambda: (now, now)),
        # «за март», «в марте» и т.д.
        (r"(за |в |во )(январ\w+|феврал\w+|март\w+|апрел\w+|ма[йя]\w*|июн\w+|июл\w+|август\w+|сентябр\w+|октябр\w+|ноябр\w+|декабр\w+)",
         lambda m: _month_range(m.group(2))),
        # «за последний месяц»
        (r"за последни\w+ месяц",
         lambda: (now - timedelta(days=30), now)),
        # «за последние 3 месяца»
        (r"за последни\w+ (\d+) месяц\w+",
         lambda m: (now - timedelta(days=30*int(m.group(1))), now)),
    ]

    for pattern, getter in patterns:
        m = re.search(pattern, text_lower)
        if m:
            try:
                if callable(getter.__code__.co_varnames) or getter.__code__.co_argcount > 0:
                    result = getter(m)
                else:
                    result = getter()
                if result:
                    date_from, date_to = result
                    cleaned = re.sub(pattern, "", text_lower).strip()
                    break
            except Exception:
                pass

    return date_from, date_to, cleaned


def _month_range(month_str: str) -> tuple:
    months = {
        "январ": 1, "феврал": 2, "март": 3, "апрел": 4,
        "ма": 5, "июн": 6, "июл": 7, "август": 8,
        "сентябр": 9, "октябр": 10, "ноябр": 11, "декабр": 12
    }
    now = datetime.now()
    for key, num in months.items():
        if month_str.startswith(key):
            year = now.year if num <= now.month else now.year - 1
            from_date = datetime(year, num, 1)
            if num == 12:
                to_date = datetime(year+1, 1, 1) - timedelta(days=1)
            else:
                to_date = datetime(year, num+1, 1) - timedelta(days=1)
            return from_date, to_date
    return None


# ──────────────────────────────────────────────
#  VAULT INDEX
# ──────────────────────────────────────────────

class VaultIndex:
    def __init__(self, vault_path: str):
        self.vault = Path(vault_path)
        self.docs  = []
        self.bm25  = None
        self._inv  = defaultdict(list)
        self._people_index = defaultdict(list)  # имя → [doc_idx]
        self._build()

    def _tok(self, text: str) -> list:
        return re.findall(r"[а-яёa-z0-9]{2,}", text.lower())

    def _parse_fm(self, text: str) -> dict:
        meta = {}
        if text.startswith("---"):
            end = text.find("---", 3)
            if end > 0:
                for line in text[3:end].split("\n"):
                    if ":" in line:
                        k, _, v = line.partition(":")
                        meta[k.strip()] = v.strip().strip('"')
        return meta

    def _strip_fm(self, text: str) -> str:
        if text.startswith("---"):
            end = text.find("---", 3)
            if end > 0:
                return text[end+3:].strip()
        return text

    def _extract_people(self, text: str) -> list:
        """Извлекает имена людей из текста (Имя Фамилия)."""
        return re.findall(r"[А-ЯA-Z][а-яa-z]{2,}\s+[А-ЯA-Z][а-яa-z]{2,}", text)

    def _build(self):
        log.info("📚 Индексирую vault...")
        md_files = list(self.vault.rglob("*.md"))
        corpus   = []
        folder_stats = Counter()

        for fpath in md_files:
            try:
                raw     = fpath.read_text(encoding="utf-8", errors="replace")
                meta    = self._parse_fm(raw)
                body    = self._strip_fm(raw)
                rel     = fpath.relative_to(self.vault)
                top     = rel.parts[0] if len(rel.parts) > 1 else "root"
                folder_stats[top] += 1

                dtype   = meta.get("type", "unknown")
                # Определяем тип по пути если не указан во frontmatter
                if dtype == "unknown":
                    rel_str = str(rel)
                    if rel_str.startswith("01_Email"):        dtype = "email"
                    elif rel_str.startswith("02_Messenger"):  dtype = "messenger_chat"
                    elif rel_str.startswith("03_YandexDisk"): dtype = "disk_file"
                    elif rel_str.startswith("04_Plaud"):      dtype = "voice_transcript"
                subject   = meta.get("subject", fpath.stem)
                from_     = meta.get("from", "")
                folder    = meta.get("folder", meta.get("mailbox",
                            str(rel.parent) if len(rel.parts) > 1 else ""))
                chat_name = meta.get("chat_name", meta.get("chat", fpath.stem))

                # Парсим дату документа
                doc_date = meta.get("date", "")
                try:
                    if doc_date and doc_date != "unknown":
                        doc_date_obj = datetime.strptime(doc_date[:10], "%Y-%m-%d")
                    else:
                        doc_date_obj = None
                except Exception:
                    doc_date_obj = None

                # Взвешенный текст — для мессенджера имя важнее тела
                if dtype == "messenger_chat":
                    weighted = (
                        f"{chat_name} " * 5 +
                        f"{fpath.stem} " * 3 +
                        body[:5000]
                    )
                else:
                    weighted = (f"{subject} " * 3 + f"{from_} " * 2 +
                                f"{folder} " + body[:3000])

                tokens   = self._tok(weighted)
                corpus.append(tokens)

                idx = len(self.docs)
                doc = {
                    "id":        hashlib.md5(str(fpath).encode()).hexdigest(),
                    "path":      str(rel),
                    "title":     chat_name if dtype == "messenger_chat" else subject,
                    "body":      body,
                    "type":      dtype,
                    "date":      doc_date,
                    "date_obj":  doc_date_obj,
                    "folder":    folder,
                    "from":      from_,
                    "subject":   subject,
                    "chat_name": chat_name,
                }
                self.docs.append(doc)

                # Инвертированный индекс
                seen = {}
                if dtype == "messenger_chat":
                    fields = [(chat_name,5),(fpath.stem,3),(body[:3000],1)]
                else:
                    fields = [(subject,5),(from_,3),(folder,2),(body[:2000],1)]
                for field, w in fields:
                    for t in self._tok(field):
                        if t not in seen or seen[t] < w:
                            seen[t] = w
                for t, w in seen.items():
                    self._inv[t].append((idx, w))

                # Индекс людей
                people = self._extract_people(f"{from_} {subject} {body[:1000]}")
                for person in people:
                    pkey = person.lower()
                    if idx not in self._people_index[pkey]:
                        self._people_index[pkey].append(idx)

            except Exception:
                continue

        if HAS_BM25 and corpus:
            self.bm25 = BM25Okapi(corpus)

        log.info(f"   ✅ {len(self.docs)} заметок, {len(self._inv):,} токенов")
        log.info("   " + ", ".join(f"{k}:{v}" for k,v in folder_stats.most_common(5)))

    def search(self, query: str, top_k=7, doc_type=None,
               folders=None, date_from=None, date_to=None) -> list:
        tokens = self._tok(query)
        if not tokens:
            return []

        scores = {}
        if self.bm25:
            for idx, sc in enumerate(self.bm25.get_scores(tokens)):
                if sc > 0:
                    scores[idx] = scores.get(idx, 0) + sc * 2

        for tok in tokens:
            for idx, w in self._inv.get(tok, []):
                scores[idx] = scores.get(idx, 0) + w
            if len(tok) >= 4:
                for token, postings in self._inv.items():
                    if token.startswith(tok) and token != tok:
                        for idx, w in postings:
                            scores[idx] = scores.get(idx, 0) + w * 0.5

        # Фильтры
        filtered = {}
        for idx, sc in scores.items():
            doc = self.docs[idx]
            if doc_type and doc["type"] != doc_type:
                continue
            if folders:
                fl = [f.lower() for f in folders]
                if not any(f in doc["folder"].lower() or
                           f in doc["path"].lower() for f in fl):
                    continue
            if date_from and doc["date_obj"]:
                if doc["date_obj"] < date_from:
                    continue
            if date_to and doc["date_obj"]:
                if doc["date_obj"] > date_to:
                    continue
            filtered[idx] = sc
        scores = filtered

        top = sorted(scores.items(), key=lambda x: -x[1])[:top_k]
        return [{**self.docs[idx], "score": sc} for idx, sc in top]

    def search_by_person(self, name: str, top_k=10) -> list:
        """Поиск всех документов связанных с человеком."""
        name_lower = name.lower()
        matches    = set()

        # По индексу людей
        for pkey, idxs in self._people_index.items():
            if name_lower in pkey:
                matches.update(idxs)

        # По всем полям включая chat_name для мессенджера
        for idx, doc in enumerate(self.docs):
            if name_lower in doc.get("from", "").lower():
                matches.add(idx)
            if name_lower in doc.get("subject", "").lower():
                matches.add(idx)
            if name_lower in doc.get("chat_name", "").lower():
                matches.add(idx)
            if name_lower in doc.get("title", "").lower():
                matches.add(idx)
            # Для мессенджера — ищем по имени файла
            if name_lower in doc.get("path", "").lower():
                matches.add(idx)

        result = [self.docs[i] for i in matches]
        return sorted(result, key=lambda x: x.get("date",""), reverse=True)[:top_k]

    def get_recent(self, doc_type=None, days=7) -> list:
        cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
        docs   = [d for d in self.docs
                  if (not doc_type or d["type"] == doc_type)
                  and d.get("date","") >= cutoff]
        return sorted(docs, key=lambda x: x.get("date",""), reverse=True)[:20]

    def stats(self) -> dict:
        return {"total": len(self.docs),
                "by_type": dict(Counter(d["type"] for d in self.docs))}

    def get_contacts(self, top_n=20) -> list:
        counter = Counter()
        for doc in self.docs:
            if doc["type"] == "email" and doc.get("from"):
                m     = re.search(r"<(.+?)>", doc["from"])
                email = m.group(1) if m else doc["from"]
                name  = re.sub(r"<.+?>","",doc["from"]).strip().strip('"') or email
                counter[(name, email)] += 1
        return [(n,e,c) for (n,e),c in counter.most_common(top_n)]

    def get_folders(self) -> dict:
        result = {"📧 Почта": set(), "💬 Мессенджер": set(),
                  "🎙️ Plaud": set(), "💾 Диск": set()}
        for doc in self.docs:
            p     = doc["path"]
            parts = Path(p).parts
            if p.startswith("01_Email") and len(parts) > 2:
                result["📧 Почта"].add(parts[1])
            elif p.startswith("02_Messenger") and len(parts) > 2:
                result["💬 Мессенджер"].add(parts[1])
            elif p.startswith("04_Plaud"):
                result["🎙️ Plaud"].add("Все записи")
            elif p.startswith("03_YandexDisk"):
                result["💾 Диск"].add("Все файлы")
        return {k: sorted(v) for k,v in result.items()}

    def get_activity_stats(self) -> dict:
        """Аналитика активности: по дням, по источникам, топ тем."""
        by_month  = Counter()
        by_type   = Counter()
        by_folder = Counter()
        topics    = Counter()

        for doc in self.docs:
            if doc.get("date") and len(doc["date"]) >= 7:
                by_month[doc["date"][:7]] += 1
            by_type[doc["type"]] += 1
            if doc.get("folder"):
                by_folder[doc["folder"]] += 1
            # Топ слов из заголовков
            for w in self._tok(doc.get("subject","")):
                if len(w) > 4:
                    topics[w] += 1

        return {
            "by_month":  dict(sorted(by_month.items())[-12:]),
            "by_type":   dict(by_type),
            "by_folder": dict(by_folder.most_common(10)),
            "top_topics": dict(topics.most_common(15)),
        }


# ──────────────────────────────────────────────
#  CLAUDE RAG v3
# ──────────────────────────────────────────────

class ClaudeRAG:
    def __init__(self, api_key: str, index: VaultIndex):
        self.client = anthropic.Anthropic(api_key=api_key)
        self.index  = index
        self.model  = "claude-haiku-4-5-20251001"  # fallback

    def _call_llm(self, messages: list, system: str = "",
                  max_tokens: int = 800, uid: int = 0) -> str:
        """
        Универсальный вызов LLM — Anthropic или Groq в зависимости от
        активной модели пользователя. Считает токены.
        """
        model_cfg = get_active_model(uid)
        provider  = model_cfg["provider"]
        model     = model_cfg["model"]
        model_key = get_model_key(uid)

        if provider == "anthropic":
            msgs = messages
            resp = self.client.messages.create(
                model=model, max_tokens=max_tokens,
                system=system, messages=msgs
            )
            tokens_in  = resp.usage.input_tokens
            tokens_out = resp.usage.output_tokens
            text       = resp.content[0].text

        elif provider == "groq":
            if not GROQ_KEY:
                raise ValueError("Укажите GROQ_KEY в .env файле")
            groq_msgs = []
            if system:
                groq_msgs.append({"role": "system", "content": system})
            groq_msgs.extend(messages)
            resp = requests.post(
                GROQ_CHAT_URL,
                headers={"Authorization": f"Bearer {GROQ_KEY}",
                         "Content-Type": "application/json"},
                json={"model": model, "messages": groq_msgs,
                      "max_tokens": max_tokens, "temperature": 0.7},
                timeout=30
            )
            resp.raise_for_status()
            data       = resp.json()
            choices    = data.get("choices", [])
            if not choices:
                raise ValueError(f"Groq вернул пустой ответ: {data}")
            text       = choices[0].get("message", {}).get("content", "")
            usage      = data.get("usage", {})
            tokens_in  = usage.get("prompt_tokens", 0)
            tokens_out = usage.get("completion_tokens", 0)
        else:
            raise ValueError(f"Неизвестный провайдер: {provider}")

        # Сохраняем статистику токенов
        add_tokens(uid, model_key, tokens_in, tokens_out)
        log.info(f"LLM [{model_key}] in={tokens_in} out={tokens_out}")
        return text

    def _ctx(self, docs: list, max_chars=4000) -> str:
        parts, total = [], 0
        for i, doc in enumerate(docs, 1):
            chunk = (f"[{i}] {doc['title']} ({doc['type']}, {doc.get('date','')})\n"
                     f"От: {doc.get('from','')}\nПапка: {doc.get('folder','')}\n"
                     f"{doc['body'][:500]}\n")
            if total + len(chunk) > max_chars:
                break
            parts.append(chunk)
            total += len(chunk)
        return "\n---\n".join(parts)

    def _rephrase(self, question: str, uid: int = 0) -> list:
        try:
            text = self._call_llm(
                messages=[{"role":"user","content":
                    f"2 альтернативных формулировки (по строке):\n{question}"}],
                max_tokens=150, uid=uid
            )
            variants = [v.strip() for v in text.strip().split("\n") if v.strip()]
            return [question] + variants[:2]
        except Exception:
            return [question]

    def ask(self, question: str, user_id: int = 0,
            doc_type=None, folders=None) -> str:
        # Парсим временное выражение
        date_from, date_to, cleaned = parse_time_expression(question)
        search_q = cleaned if cleaned else question

        # Проверяем нужна ли цепочка рассуждений
        is_complex = any(w in question.lower() for w in
                        ["сравни", "проанализируй", "почему", "как связаны",
                         "что общего", "динамика", "тренд", "история"])

        if is_complex:
            return self._chain_of_thought(question, user_id, doc_type, folders,
                                          date_from, date_to)

        # Обычный поиск с переформулировкой
        all_docs, seen = [], set()
        for q in self._rephrase(search_q, uid=user_id):
            for doc in self.index.search(q, top_k=4, doc_type=doc_type,
                                         folders=folders, date_from=date_from,
                                         date_to=date_to):
                if doc["id"] not in seen:
                    seen.add(doc["id"])
                    all_docs.append(doc)

        context  = self._ctx(all_docs[:6]) if all_docs else "Документы не найдены."
        history  = get_dialog(user_id)

        date_note = ""
        if date_from:
            date_note = f"\n[Период: {date_from.strftime('%d.%m.%Y')} — {(date_to or datetime.now()).strftime('%d.%m.%Y')}]"

        messages = history + [{"role":"user","content":
            f"Вопрос: {question}{date_note}\n\nДокументы:\n{context}"}]

        answer = self._call_llm(
            messages=messages,
            system=("Ты личный ИИ-ассистент. База знаний: письма, чаты, голосовые, файлы. "
                    "Отвечай на русском, конкретно. Указывай из каких документов информация."),
            max_tokens=800, uid=user_id
        )
        add_to_dialog(user_id, "user",      question)
        add_to_dialog(user_id, "assistant", answer)
        return answer

    def _chain_of_thought(self, question: str, user_id: int,
                           doc_type, folders, date_from, date_to) -> str:
        """Многошаговое рассуждение для сложных вопросов."""
        # Шаг 1: план поиска
        plan_text = self._call_llm(
            messages=[{"role":"user","content":
                f"Разбей на 3 поисковых подзапроса для ответа на вопрос:\n{question}\n"
                "Каждый подзапрос на отдельной строке, без нумерации."}],
            max_tokens=200, uid=user_id
        )
        subqueries = [q.strip() for q in plan_text.strip().split("\n")
                      if q.strip()][:3]

        # Шаг 2: поиск по каждому подзапросу
        all_docs, seen = [], set()
        for sq in subqueries:
            for doc in self.index.search(sq, top_k=3, doc_type=doc_type,
                                         folders=folders, date_from=date_from,
                                         date_to=date_to):
                if doc["id"] not in seen:
                    seen.add(doc["id"])
                    all_docs.append(doc)

        context = self._ctx(all_docs[:8]) if all_docs else "Документы не найдены."

        # Шаг 3: синтез ответа
        answer = self._call_llm(
            messages=[{"role":"user","content":
                f"Вопрос: {question}\n\n"
                f"Поисковые подзапросы которые использовались:\n" +
                "\n".join(f"- {q}" for q in subqueries) +
                f"\n\nНайденные документы:\n{context}\n\n"
                "Дай развёрнутый аналитический ответ."}],
            system="Ты аналитик. Давай структурированные развёрнутые ответы на русском.",
            max_tokens=1000, uid=user_id
        )
        add_to_dialog(user_id, "user",      question)
        add_to_dialog(user_id, "assistant", answer)
        return f"🔗 Анализ по {len(subqueries)} направлениям:\n\n{answer}"

    def person_report(self, name: str, uid: int = 0, doc_types: list = None) -> str:
        """Полный отчёт по человеку из всех источников."""
        docs = self.index.search_by_person(name, top_k=15)
        if not docs:
            return f"Ничего не найдено по запросу '{name}'."

        # Применяем фильтр по типу
        if doc_types:
            docs = [d for d in docs if d["type"] in doc_types]
        if not docs:
            return f"По запросу '{name}' ничего не найдено в выбранных источниках."

        by_type = defaultdict(list)
        for doc in docs:
            by_type[doc["type"]].append(doc)

        context = self._ctx(docs[:10])
        answer_pr = self._call_llm(
            messages=[{"role":"user","content":
                f"Сделай сводку по человеку '{name}' из всех источников:\n{context}\n\n"
                "Включи:\n"
                "1. Кто это (роль, контекст)\n"
                "2. История общения (когда, о чём)\n"
                "3. Открытые вопросы/задачи\n"
                "4. Последний контакт"}],
            max_tokens=800, uid=uid
        )
        stats = f"Найдено: {len(docs)} документов"
        for t, ds in by_type.items():
            e = {"email":"📧","messenger_chat":"💬","voice_transcript":"🎙️"}.get(t,"📄")
            stats += f" | {e}{len(ds)}"
        return f"👤 {name}\n{stats}\n\n{answer_pr}"

    def proactive_insights(self) -> str:
        """Проактивные инсайты — что бот замечает сам."""
        insights = []

        # 1. Контакты без ответа > 14 дней
        contacts    = self.index.get_contacts(top_n=20)
        recent_docs = self.index.get_recent(days=3)
        recent_from = {d.get("from","").lower() for d in recent_docs}

        silent = []
        for name, email, cnt in contacts[:10]:
            if email.lower() not in recent_from and cnt > 2:
                # Найдём последний контакт
                person_docs = self.index.search_by_person(name, top_k=1)
                if person_docs:
                    last_date = person_docs[0].get("date","")
                    if last_date:
                        try:
                            days_ago = (datetime.now() -
                                       datetime.strptime(last_date[:10], "%Y-%m-%d")).days
                            if days_ago > 14:
                                silent.append(f"• {name} — {days_ago} дней назад")
                        except Exception:
                            pass
        if silent:
            insights.append("😶 Давно не общались:\n" + "\n".join(silent[:5]))

        # 2. Часто упоминаемые темы за последнюю неделю
        recent_week = self.index.get_recent(days=7)
        topic_counter = Counter()
        for doc in recent_week:
            for w in re.findall(r"[А-Яа-яA-Za-z]{5,}", doc.get("subject","") + " " + doc["body"][:200]):
                if len(w) > 5:
                    topic_counter[w.lower()] += 1

        hot_topics = [w for w, c in topic_counter.most_common(5) if c >= 3]
        if hot_topics:
            insights.append("🔥 Горячие темы недели:\n• " + "\n• ".join(hot_topics))

        # 3. Активность по дням
        stats    = self.index.get_activity_stats()
        by_month = stats["by_month"]
        if len(by_month) >= 2:
            months  = list(by_month.items())
            last    = months[-1]
            prev    = months[-2]
            delta   = last[1] - prev[1]
            arrow   = "📈" if delta > 0 else "📉"
            insights.append(f"{arrow} Активность: {last[0]} — {last[1]} документов "
                           f"({'+'if delta>0 else ''}{delta} к предыдущему)")

        # 4. Задачи из переписки
        task_docs = self.index.get_recent(days=30)
        deadline_pattern = re.compile(
            r"(до|к|дедлайн|deadline|срок).{0,30}(\d{1,2}[./]\d{1,2})", re.IGNORECASE)
        found_deadlines = []
        for doc in task_docs[:20]:
            for m in deadline_pattern.finditer(doc["body"][:500]):
                found_deadlines.append(f"• {doc['title'][:40]}: {m.group(0)[:50]}")
        if found_deadlines:
            insights.append("⏰ Дедлайны в переписке:\n" + "\n".join(found_deadlines[:4]))

        if not insights:
            return "✅ Всё спокойно. Новых инсайтов нет."

        return "💡 Проактивные инсайты:\n\n" + "\n\n".join(insights)

    def analytics_report(self) -> str:
        """Аналитика активности — ASCII визуализация."""
        stats     = self.index.get_activity_stats()
        by_month  = stats["by_month"]
        by_folder = stats["by_folder"]
        topics    = stats["top_topics"]

        text = "📊 Аналитика базы знаний\n\n"

        # Активность по месяцам (ASCII bar chart)
        if by_month:
            text += "📅 Активность по месяцам:\n"
            max_val = max(by_month.values()) or 1
            for month, cnt in list(by_month.items())[-6:]:
                bar   = "█" * int(cnt / max_val * 15)
                text += f"{month}  {bar} {cnt}\n"
            text += "\n"

        # Топ папок
        if by_folder:
            text += "📁 Топ папок:\n"
            max_f = max(by_folder.values()) or 1
            for folder, cnt in list(by_folder.items())[:7]:
                bar   = "█" * int(cnt / max_f * 12)
                short = folder[:20]
                text += f"{short:<20} {bar} {cnt}\n"
            text += "\n"

        # Топ тем
        if topics:
            text += "🔤 Топ тем и слов:\n"
            text += ", ".join(f"{w}({c})" for w,c in list(topics.items())[:10])

        return text

    def summarize(self, doc_type: str, uid: int = 0) -> str:
        docs = self.index.get_recent(doc_type=doc_type, days=7)
        if not docs:
            return "Нет документов за последние 7 дней."
        return self._call_llm(
            messages=[{"role":"user","content":
                f"Саммари за неделю:\n{self._ctx(docs[:10])}\n\n"
                "1. Главные темы\n2. Решения\n3. Задачи\n4. Активные контакты"}],
            max_tokens=800, uid=uid
        )

    def extract_tasks(self, uid: int = 0) -> str:
        docs = []
        for t in ["email","messenger_chat","voice_transcript"]:
            docs.extend(self.index.get_recent(doc_type=t, days=30))
        if not docs:
            return "Документов не найдено."
        return self._call_llm(
            messages=[{"role":"user","content":
                f"Задачи, дедлайны, договорённости:\n{self._ctx(docs[:12])}\n\n"
                "📋 ЗАДАЧИ:\n- [ ] задача | источник | срок\n"
                "⏰ ДЕДЛАЙНЫ:\n- дедлайн | дата\n"
                "🤝 ДОГОВОРЁННОСТИ:\n- с кем | о чём"}],
            max_tokens=1000, uid=uid
        )

    def weekly_digest(self) -> str:
        sections = []
        for dtype, label in [("email","📧 Почта"),("messenger_chat","💬 Мессенджер"),
                              ("voice_transcript","🎙️ Голосовые")]:
            docs = self.index.get_recent(doc_type=dtype, days=7)
            if docs:
                section_text = self._call_llm(
                    messages=[{"role":"user","content":
                        f"3-5 пунктов о главном из {label}:\n{self._ctx(docs[:8], 1500)}"}],
                    max_tokens=300
                )
                sections.append(f"{label}\n{section_text}")
        sections.append(f"📋 Задачи\n{self.extract_tasks(uid=0)}")
        insights = self.proactive_insights()
        sections.append(insights)
        return (f"🗓 Дайджест ({datetime.now().strftime('%d.%m.%Y')})\n\n"
                + "\n\n".join(sections))

    def transcribe_voice(self, audio_path: str) -> str:
        """Транскрибирует голосовое сообщение через Claude."""
        try:
            with open(audio_path, "rb") as f:
                audio_data = f.read()
            import base64
            b64 = base64.b64encode(audio_data).decode()
            resp = self.client.messages.create(
                model="claude-haiku-4-5-20251001", max_tokens=500,
                messages=[{"role":"user","content":[
                    {"type":"text","text":"Транскрибируй это голосовое сообщение на русском:"},
                    {"type":"document","source":{"type":"base64",
                     "media_type":"audio/ogg","data":b64}}
                ]}]
            )
            return resp.content[0].text
        except Exception as e:
            return f"Не удалось транскрибировать: {e}"

    def check_alerts(self, keywords: list) -> list:
        cutoff = (datetime.now() - timedelta(hours=1)).strftime("%Y-%m-%d")
        alerts = []
        for doc in self.index.docs:
            if doc["type"] != "email" or doc.get("date","") < cutoff:
                continue
            text = f"{doc.get('subject','')} {doc['body']}".lower()
            for kw in keywords:
                if kw.lower() in text:
                    alerts.append({"keyword":kw,"subject":doc.get("subject",""),
                                   "from":doc.get("from",""),"date":doc.get("date","")})
                    break
        return alerts


# ──────────────────────────────────────────────
#  ГЛОБАЛЬНЫЕ ОБЪЕКТЫ
# ──────────────────────────────────────────────

vault_index: Optional[VaultIndex] = None
claude_rag:  Optional[ClaudeRAG]  = None

def check_access(update: Update) -> bool:
    return ALLOWED_USER_ID == 0 or update.effective_user.id == ALLOWED_USER_ID


# ──────────────────────────────────────────────
#  КЛАВИАТУРА ПАПОК
# ──────────────────────────────────────────────

def build_folder_keyboard(active_folders, active_types, page=0) -> tuple:
    PAGE  = 8
    TYPES = {"📧 Почта":"email","💬 Мессенджер":"messenger_chat",
             "🎙️ Plaud":"voice_transcript","💾 Диск":"disk_file"}
    keyboard = []
    rows = list(TYPES.items())
    for i in range(0, len(rows), 2):
        keyboard.append([
            InlineKeyboardButton(
                f"{'✅' if dt in active_types else '☐'} {lb}",
                callback_data=f"filter_type_{dt}")
            for lb, dt in rows[i:i+2]
        ])
    keyboard.append([InlineKeyboardButton("── Папки почты ──", callback_data="noop")])

    folders     = vault_index.get_folders().get("📧 Почта", [])
    total_pages = max(1, (len(folders)+PAGE-1)//PAGE)
    page        = max(0, min(page, total_pages-1))
    page_items  = folders[page*PAGE:(page+1)*PAGE]

    btns = [
        InlineKeyboardButton(
            f"{'✅' if f in active_folders else '☐'} {f[:16]}{'…'if len(f)>16 else ''}",
            callback_data=f"ff_{f[:35]}")
        for f in page_items
    ]
    for i in range(0, len(btns), 2):
        keyboard.append(btns[i:i+2])

    nav = []
    if page > 0:        nav.append(InlineKeyboardButton("◀", callback_data=f"fpage_{page-1}"))
    nav.append(InlineKeyboardButton(f"{page+1}/{total_pages}", callback_data="noop"))
    if page < total_pages-1: nav.append(InlineKeyboardButton("▶", callback_data=f"fpage_{page+1}"))
    if nav: keyboard.append(nav)

    keyboard.append([
        InlineKeyboardButton("✅ Все папки", callback_data="filter_all"),
        InlineKeyboardButton("🔄 Сбросить",  callback_data="filter_reset"),
    ])

    inv    = {v:k for k,v in TYPES.items()}
    status = "🔍 Где искать?\n\n"
    if not active_folders and not active_types:
        status += "Везде\n"
    else:
        if active_types:
            status += "Источники: " + ", ".join(inv.get(t,t) for t in active_types) + "\n"
        if active_folders:
            shown  = ", ".join(active_folders[:4])
            extra  = f" +{len(active_folders)-4}" if len(active_folders)>4 else ""
            status += f"Папки ({len(active_folders)}): {shown}{extra}\n"
    status += "\nНажмите папку чтобы включить/выключить:"
    return keyboard, status


# ──────────────────────────────────────────────
#  КОМАНДЫ
# ──────────────────────────────────────────────

async def cmd_disk_search(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Поиск только по файлам Яндекс Диска."""
    if not check_access(update): return
    q = " ".join(context.args) if context.args else ""
    if not q:
        # Показываем статистику и инструкцию
        disk_docs = [d for d in vault_index.docs if d["type"] == "disk_file"]
        status    = _get_disk_status()
        await update.message.reply_text(
            f"💾 Поиск по Яндекс Диску\n\n"
            f"Файлов в индексе: {len(disk_docs)}\n"
            f"Последняя синхронизация: {status['last_sync']}\n\n"
            f"Использование: /disk_search <запрос>\n"
            f"Например: /disk_search отчёт за квартал"
        )
        return

    uid  = update.effective_user.id
    msg  = await update.message.reply_text(f"💾 Ищу в Яндекс Диске: {q}...")
    try:
        docs = vault_index.search(q, top_k=7, doc_type="disk_file")
        if not docs:
            # Пробуем без фильтра по типу — возможно тип не проставлен
            all_docs = vault_index.search(q, top_k=10)
            docs = [d for d in all_docs if "03_YandexDisk" in d.get("path","")]

        if not docs:
            disk_count = sum(1 for d in vault_index.docs if d["type"] == "disk_file"
                            or "03_YandexDisk" in d.get("path",""))
            await msg.edit_text(
                f"💾 Ничего не найдено по запросу «{q}»\n\n"
                f"Файлов диска в индексе: {disk_count}\n"
                f"Попробуйте другой запрос или запустите синхронизацию: /disk"
            )
            return

        text = f"💾 Яндекс Диск: {q}\n\n"
        for doc in docs:
            snip  = doc["body"][:120].replace("\n"," ").strip()
            fname = doc.get("subject", doc["title"])
            fpath = doc.get("folder", doc.get("path",""))
            text += f"📄 {fname}\n"
            text += f"   📂 {fpath}\n"
            if doc.get("date"): text += f"   📅 {doc['date']}\n"
            text += f"   {snip}…\n\n"

        await msg.edit_text(text[:4000])
    except Exception as e:
        await msg.edit_text(f"❌ {e}")


async def cmd_disk_sync(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Запускает синхронизацию Яндекс Диска."""
    if not check_access(update): return

    status = _get_disk_status()
    last   = status.get("last_sync", "никогда")
    total  = status.get("total_files", 0)

    kb = [
        [InlineKeyboardButton("🔄 Синхронизировать",     callback_data="disk_sync_start")],
        [InlineKeyboardButton("🔄 Принудительно всё",    callback_data="disk_sync_force")],
        [InlineKeyboardButton("📊 Статус диска",         callback_data="disk_sync_status")],
    ]
    text = (f"💾 Яндекс Диск\n\n"
            f"Файлов в vault: {total}\n"
            f"Последняя синхронизация: {last or 'никогда'}\n\n"
            f"Выберите действие:")
    await update.message.reply_text(text, reply_markup=InlineKeyboardMarkup(kb))


def _get_disk_status() -> dict:
    """Читает статус синхронизации из файла состояния."""
    try:
        state = json.loads(Path(".disk_sync_state.json").read_text(encoding="utf-8"))
        return {
            "total_files": len(state.get("files", {})),
            "last_sync":   state.get("last_sync", "никогда")[:19].replace("T"," ") if state.get("last_sync") else "никогда",
        }
    except Exception:
        return {"total_files": 0, "last_sync": "никогда"}


async def _run_disk_sync_async(bot, chat_id: int, msg_id: int, force: bool = False):
    """Запускает синхронизацию диска в фоне с прогресс-обновлениями."""
    import sys, importlib.util

    # Динамически импортируем disk_sync.py
    script_dir = Path(__file__).parent
    sync_path  = script_dir / "disk_sync.py"

    if not sync_path.exists():
        await bot.edit_message_text(
            "❌ Файл disk_sync.py не найден рядом с vault_bot.py",
            chat_id=chat_id, message_id=msg_id
        )
        return

    spec   = importlib.util.spec_from_file_location("disk_sync", sync_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    # Патчим токен из настроек бота
    module.YANDEX_DISK_TOKEN = YANDEX_DISK_TOKEN
    module.VAULT_PATH        = VAULT_PATH

    if not YANDEX_DISK_TOKEN:
        await bot.edit_message_text(
            "⚠️ Укажите YANDEX_DISK_TOKEN в настройках vault_bot.py",
            chat_id=chat_id, message_id=msg_id
        )
        return

    last_update = [0]
    import time

    def progress(current, total, filename):
        now = time.time()
        if now - last_update[0] > 3:  # обновляем не чаще раза в 3 сек
            last_update[0] = now
            pct  = int(current / total * 100)
            bar  = "█" * (pct // 10) + "░" * (10 - pct // 10)
            text = (f"💾 Синхронизация Яндекс Диска\n\n"
                    f"{bar} {pct}%\n"
                    f"{current}/{total} файлов\n\n"
                    f"⬇️ {filename[:40]}")
            import asyncio
            asyncio.get_event_loop().run_until_complete(
                bot.edit_message_text(text, chat_id=chat_id, message_id=msg_id)
            )

    try:
        stats = module.sync_disk(force=force, progress_callback=None)

        # Переиндексируем vault с новыми файлами
        await bot.edit_message_text(
            "⏳ Переиндексирую vault...",
            chat_id=chat_id, message_id=msg_id
        )
        global vault_index, claude_rag
        vault_index = VaultIndex(VAULT_PATH)
        claude_rag  = ClaudeRAG(ANTHROPIC_KEY, vault_index)

        # Считаем файлы диска в новом индексе
        disk_docs = sum(1 for d in vault_index.docs if d["type"] == "disk_file")

        result = (
            f"✅ Синхронизация завершена!\n\n"
            f"📥 Новых файлов: {stats['new']}\n"
            f"🔄 Обновлено: {stats['updated']}\n"
            f"⏭  Пропущено: {stats['skipped']}\n"
            f"❌ Ошибок: {stats['errors']}\n"
            f"📁 Всего на диске: {stats['total']}\n\n"
            f"💾 В индексе файлов диска: {disk_docs}\n"
            f"📝 Всего заметок в vault: {len(vault_index.docs)}\n\n"
            f"Готово! Теперь можно искать по файлам диска."
        )

    except Exception as e:
        result = f"❌ Ошибка синхронизации:\n{e}"

    await bot.edit_message_text(result, chat_id=chat_id, message_id=msg_id)


async def cmd_refresh(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Переиндексирует vault и показывает дайджест новых данных."""
    if not check_access(update): return

    global vault_index, claude_rag

    stats_before = vault_index.stats()
    msg = await update.message.reply_text(
        "🔄 Переиндексирую vault... " +
        f"Сейчас: {stats_before['total']} заметок"
    )

    try:
        vault_index = VaultIndex(VAULT_PATH)
        claude_rag  = ClaudeRAG(ANTHROPIC_KEY, vault_index)
        stats_after = vault_index.stats()
        new_docs    = stats_after["total"] - stats_before["total"]
        sign        = ("+" + str(new_docs)) if new_docs >= 0 else str(new_docs)

        out = ["✅ Индекс обновлён!",
               f"Было: {stats_before['total']} → Стало: {stats_after['total']} ({sign})",
               ""]

        # 1. Последнее письмо — только с реальной датой, не от себя
        emails = [d for d in vault_index.docs
                  if d["type"] == "email"
                  and d.get("date","") > "2020"
                  and MY_EMAIL.lower() not in d.get("from","").lower()
                  and MY_NAME.lower() not in d.get("from","").lower()]
        emails.sort(key=lambda x: x.get("date",""), reverse=True)
        if emails:
            e = emails[0]
            subj = e.get("subject", e["title"])[:55]
            frm  = e.get("from","")[:45]
            # Убираем технические письма
            skip = ["background process","tech-bckg","noreply","no-reply","mailer-daemon"]
            if not any(s in frm.lower() for s in skip):
                out += ["📧 Последнее письмо:",
                        f"   📅 {e.get('date','')}",
                        f"   📌 {subj}",
                        f"   👤 {frm}", ""]

        # 2. Последний файл с диска — фильтруем технические
        disks = [d for d in vault_index.docs
                 if d["type"] == "disk_file"
                 and d.get("date","") > "2020"
                 and d["title"] not in ("0", "_index", "index")
                 and not d["title"].startswith("_")]
        disks.sort(key=lambda x: x.get("date",""), reverse=True)
        if disks:
            df   = disks[0]
            path = df.get("path","").replace("03_YandexDisk/","").rsplit("/",1)[0]
            out += ["💾 Последний файл с Яндекс Диска:",
                    f"   📅 {df.get('date','')}",
                    f"   📄 {df['title'][:55]}",
                    f"   📂 {path[:45]}", ""]

        # 3. Топ контактов — исключаем себя
        all_contacts = vault_index.get_contacts(top_n=50)
        filtered = [(n, e, c) for n, e, c in all_contacts
                    if MY_NAME.lower() not in n.lower()
                    and MY_EMAIL.lower() not in e.lower()][:3]
        if filtered:
            out.append("👥 Топ контактов:")
            for name, email, cnt in filtered:
                out.append(f"   👤 {name[:35]} — {cnt} писем")
            out.append("")

        # 4. Последняя запись Plaud — только с реальной датой и именем
        plauds = [d for d in vault_index.docs
                  if d["type"] == "voice_transcript"
                  and d.get("date","") > "2020"
                  and d["title"] not in ("0",)]
        plauds.sort(key=lambda x: x.get("date",""), reverse=True)
        if plauds:
            p    = plauds[0]
            body = p.get("body","")
            subj = ""
            for line in body.split("\n"):
                if "чём:" in line.lower() and len(line) > 8:
                    subj = line.split(":",1)[-1].replace("**","").strip()[:60]
                    break
            title = subj or p["title"]
            if title != "0":
                out += ["🎙️ Последняя запись Plaud:",
                        f"   📅 {p.get('date','')}",
                        f"   📝 {title}", ""]

        # 5. Последний чат мессенджера
        chats = [d for d in vault_index.docs if d["type"] == "messenger_chat"]
        chats.sort(key=lambda x: x.get("date",""), reverse=True)
        if chats:
            c    = chats[0]
            body = c.get("body","")
            last = ""
            for line in reversed(body.split("\n")):
                line = line.strip()
                if line.startswith("> ") and len(line) > 3:
                    last = line[2:].strip()[:60]
                    break
            chat_name = c.get("chat_name", c["title"])
            out += ["💬 Последний чат:",
                    f"   👤 {chat_name[:35]}",
                    f"   📅 {c.get('date','')}",
                    f"   💬 {last}", ""]

        await msg.edit_text("\n".join(out))

    except Exception as e:
        await msg.edit_text(f"❌ Ошибка переиндексации: {e}")


async def cmd_model(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Переключение LLM модели."""
    if not check_access(update): return
    uid       = update.effective_user.id
    model_key = get_model_key(uid)
    current   = AVAILABLE_MODELS[model_key]

    text = f"🤖 Текущая модель: {current['name']}\n\nВыберите модель:"
    kb   = []
    for key, cfg in AVAILABLE_MODELS.items():
        mark = "✅ " if key == model_key else ""
        kb.append([InlineKeyboardButton(
            f"{mark}{cfg['name']} ({cfg['provider']})",
            callback_data=f"set_model_{key}"
        )])
    await update.message.reply_text(text, reply_markup=InlineKeyboardMarkup(kb))


async def cmd_usage(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Статистика потраченных токенов."""
    if not check_access(update): return
    uid   = update.effective_user.id
    stats = get_token_stats(uid)

    if not stats:
        await update.message.reply_text("📊 Статистика пуста — ещё не было запросов.")
        return

    # Стоимость за 1M токенов (приблизительно)
    PRICING = {
        "haiku": {"in": 0.80,  "out": 4.00},   # Claude Haiku $/1M tokens
        "llama": {"in": 0.05,  "out": 0.08},    # Llama 3.1 8B via Groq $/1M tokens
    }

    text  = "📊 Статистика токенов\n\n"
    total_cost = 0.0

    for model_key, data in stats.items():
        cfg      = AVAILABLE_MODELS.get(model_key, {})
        name     = cfg.get("name", model_key)
        t_in     = data.get("in", 0)
        t_out    = data.get("out", 0)
        reqs     = data.get("requests", 0)
        pricing  = PRICING.get(model_key, {"in": 0, "out": 0})
        cost     = (t_in / 1_000_000 * pricing["in"] +
                    t_out / 1_000_000 * pricing["out"])
        total_cost += cost

        bar_in  = "█" * min(t_in  // 1000, 15)
        bar_out = "█" * min(t_out // 500,  15)

        text += (f"🤖 {name}\n"
                 f"   Запросов: {reqs}\n"
                 f"   ⬆️ Input:  {t_in:,} {bar_in}\n"
                 f"   ⬇️ Output: {t_out:,} {bar_out}\n"
                 f"   💰 ~${cost:.4f}\n\n")

    text += f"💰 Итого: ~${total_cost:.4f}\n"
    text += f"\n_Цены приблизительные. Актуальные — на сайтах провайдеров._"

    kb = [[InlineKeyboardButton("🔄 Сменить модель", callback_data="switch_model")]]
    await update.message.reply_text(text, reply_markup=InlineKeyboardMarkup(kb))


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not check_access(update): return
    s = vault_index.stats()
    uid       = update.effective_user.id
    model_cfg = get_active_model(uid)
    t = f"Vault Bot v3\n\nБаза: {s['total']} заметок\n"
    for tp, n in sorted(s["by_type"].items(), key=lambda x:-x[1]):
        e = {"email":"📧","messenger_chat":"💬","voice_transcript":"🎙️",
             "disk_file":"💾","contact":"👤"}.get(tp,"📄")
        t += f"{e} {tp}: {n}\n"
    t += f"\n🤖 Модель: {model_cfg['name']}\n"
    t += ("\nКоманды:\n"
          "/where — выбор папок поиска\n"
          "/search <запрос> — поиск (поддерживает даты)\n"
          "/person <имя> — всё по человеку\n"
          "/insights — проактивные инсайты\n"
          "/analytics — аналитика активности\n"
          "/summary — саммари источника\n"
          "/tasks — задачи с управлением\n"
          "/digest — дайджест недели\n"
          "/contacts — топ контактов\n"
          "/favorites — избранное\n"
          "/export — экспорт результатов\n"
          "/plaud — голосовые записи\n"
          "/refresh — переиндексировать vault\n"
          "/model — сменить LLM\n"
          "/disk — синхронизация Яндекс Диска\n"
          "/disk_search — поиск по файлам диска\n"
          "/usage — статистика токенов\n"
          "/clear — очистить диалог\n"
          "🎤 Голосовое сообщение → транскрипция + поиск\n")
    kb = [
        [InlineKeyboardButton("💡 Инсайты",        callback_data="insights"),
         InlineKeyboardButton("📊 Аналитика",       callback_data="analytics")],
        [InlineKeyboardButton("📧 Саммари почты",   callback_data="summary_email"),
         InlineKeyboardButton("💬 Саммари чатов",   callback_data="summary_chat")],
        [InlineKeyboardButton("📋 Задачи",           callback_data="tasks"),
         InlineKeyboardButton("🗓 Дайджест",         callback_data="digest")],
        [InlineKeyboardButton("👥 Контакты",         callback_data="contacts"),
         InlineKeyboardButton("⭐ Избранное",         callback_data="favorites")],
        [InlineKeyboardButton("🔍 Выбор папок",      callback_data="where"),
         InlineKeyboardButton("📤 Экспорт",          callback_data="export_menu")],
        [InlineKeyboardButton("🤖 Сменить модель",    callback_data="switch_model"),
         InlineKeyboardButton("📊 Токены",            callback_data="show_usage")],
        [InlineKeyboardButton("💾 Синхронизация Диска", callback_data="disk_sync_status")],
        [InlineKeyboardButton("🔄 Переиндексировать vault", callback_data="refresh_index")],
    ]
    await update.message.reply_text(t, reply_markup=InlineKeyboardMarkup(kb))


async def cmd_where(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not check_access(update): return
    f  = get_filter(update.effective_user.id)
    kb, status = build_folder_keyboard(f["folders"], f["types"])
    await update.message.reply_text(status, reply_markup=InlineKeyboardMarkup(kb))


async def cmd_search(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not check_access(update): return
    q = " ".join(context.args) if context.args else ""
    if not q:
        await update.message.reply_text(
            "Использование: /search <запрос>\n\n"
            "Примеры:\n"
            "/search kafka за прошлую неделю\n"
            "/search встреча с Иваном за март\n"
            "/search проект LTV за последние 30 дней\n\n"
            "Фильтры папок: /where"
        )
        return

    uid  = update.effective_user.id
    filt = get_filter(uid)
    msg  = await update.message.reply_text(f"🔍 Ищу: {q}...")

    try:
        date_from, date_to, cleaned = parse_time_expression(q)
        dt   = filt["types"][0] if len(filt["types"]) == 1 else None
        docs = vault_index.search(cleaned or q, top_k=7, doc_type=dt,
                                   folders=filt["folders"],
                                   date_from=date_from, date_to=date_to)
        if not docs:
            await msg.edit_text("🔍 Ничего не найдено. Попробуйте /where → Сбросить")
            return

        em   = {"email":"📧","messenger_chat":"💬","voice_transcript":"🎙️","disk_file":"💾"}
        text = f"🔍 {q}\n"
        if date_from:
            text += f"📅 {date_from.strftime('%d.%m')} — {(date_to or datetime.now()).strftime('%d.%m.%Y')}\n"
        text += "\n"

        for i, doc in enumerate(docs):
            snip  = doc["body"][:100].replace("\n"," ").strip()
            text += f"{em.get(doc['type'],'📄')} {doc['title']}\n"
            if doc.get("folder"): text += f"   📁 {doc['folder']}"
            if doc.get("date"):   text += f"  📅 {doc['date']}"
            text += f"\n   {snip}…\n\n"

        # Кнопки для первого результата
        if docs:
            kb = [[
                InlineKeyboardButton("⭐ В избранное", callback_data=f"fav_{docs[0]['id'][:20]}"),
                InlineKeyboardButton("📤 Экспорт",     callback_data=f"export_search_{q[:30]}"),
            ]]
            await msg.edit_text(text[:4000], reply_markup=InlineKeyboardMarkup(kb))
        else:
            await msg.edit_text(text[:4000])
    except Exception as e:
        await msg.edit_text(f"❌ {e}")


async def cmd_person(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not check_access(update): return
    name = " ".join(context.args) if context.args else ""
    if not name:
        await update.message.reply_text("Использование: /person <имя>\nНапример: /person Иванов Пётр")
        return

    uid  = update.effective_user.id
    filt = get_filter(uid)
    msg  = await update.message.reply_text(f"👤 Ищу всё по: {name}...")

    try:
        # Очищаем историю диалога чтобы не было влияния предыдущего контекста
        clear_dialog(uid)

        docs = vault_index.search_by_person(name, top_k=15)

        # Применяем фильтр по типу если выбран
        if filt["types"]:
            docs = [d for d in docs if d["type"] in filt["types"]]
        if filt["folders"]:
            fl = [f.lower() for f in filt["folders"]]
            docs = [d for d in docs
                    if any(f in d.get("folder","").lower() or
                           f in d.get("path","").lower() for f in fl)]

        if not docs:
            filter_hint = ""
            if filt["types"]:
                filter_hint = f"\nФильтр активен: {', '.join(filt['types'])} — попробуйте /where → Сбросить"
            await msg.edit_text(f"👤 Ничего не найдено по '{name}'.{filter_hint}")
            return

        # Статистика по источникам
        from collections import Counter
        by_type = Counter(d["type"] for d in docs)
        type_str = " | ".join(
            f"{'📧' if t=='email' else '💬' if t=='messenger_chat' else '🎙️' if t=='voice_transcript' else '📄'}{n}"
            for t, n in by_type.most_common()
        )

        result = claude_rag.person_report(name, uid=uid)

        # Добавляем подсказку если фильтр активен
        if filt["types"]:
            type_names = {"email":"📧 Почта","messenger_chat":"💬 Мессенджер",
                         "voice_transcript":"🎙️ Plaud","disk_file":"💾 Диск"}
            sources = ", ".join(type_names.get(t,t) for t in filt["types"])
            result  = f"[Поиск только в: {sources}]\n\n" + result

        await msg.edit_text(
            f"👤 {name}\nНайдено: {len(docs)} документов | {type_str}\n\n"
            f"{result}"[:4000]
        )
    except Exception as e:
        await msg.edit_text(f"❌ {e}")


async def cmd_insights(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not check_access(update): return
    msg = await update.message.reply_text("💡 Анализирую...")
    try:
        await msg.edit_text(claude_rag.proactive_insights())
    except Exception as e:
        await msg.edit_text(f"❌ {e}")


async def cmd_analytics(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not check_access(update): return
    try:
        await update.message.reply_text(claude_rag.analytics_report())
    except Exception as e:
        await update.message.reply_text(f"❌ {e}")


async def cmd_summary(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not check_access(update): return
    kb = [
        [InlineKeyboardButton("📧 Почта",      callback_data="summary_email")],
        [InlineKeyboardButton("💬 Мессенджер", callback_data="summary_chat")],
        [InlineKeyboardButton("🎙️ Голосовые",  callback_data="summary_voice")],
        [InlineKeyboardButton("💾 Диск",        callback_data="summary_disk")],
    ]
    await update.message.reply_text("Выберите источник:", reply_markup=InlineKeyboardMarkup(kb))


async def cmd_tasks(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not check_access(update): return
    uid   = update.effective_user.id
    saved = get_tasks(uid)

    if saved:
        # Показываем сохранённые задачи с управлением
        text = "📋 Ваши задачи:\n\n"
        kb   = []
        for i, task in enumerate(saved):
            mark = "✅" if task.get("done") else "☐"
            text += f"{mark} {task['text']}\n"
            kb.append([
                InlineKeyboardButton(
                    f"{'↩️ Отменить' if task.get('done') else '✅ Выполнено'}",
                    callback_data=f"task_toggle_{i}"),
                InlineKeyboardButton("🗑", callback_data=f"task_del_{i}")
            ])
        kb.append([InlineKeyboardButton("🔄 Найти новые задачи", callback_data="tasks_refresh")])
        await update.message.reply_text(text, reply_markup=InlineKeyboardMarkup(kb))
    else:
        msg = await update.message.reply_text("🔍 Ищу задачи в переписке...")
        try:
            result = claude_rag.extract_tasks(uid=update.effective_user.id)
            # Парсим задачи и сохраняем
            task_lines = re.findall(r"- \[ \] (.+)", result)
            if task_lines:
                tasks = [{"text": t, "done": False} for t in task_lines]
                save_tasks(uid, tasks)
            await msg.edit_text(result[:4000])
        except Exception as e:
            await msg.edit_text(f"❌ {e}")


async def cmd_digest(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not check_access(update): return
    msg = await update.message.reply_text("🗓 Генерирую дайджест...")
    try:
        result = claude_rag.weekly_digest()
        await msg.delete()
        for chunk in [result[i:i+4000] for i in range(0, len(result), 4000)]:
            await update.message.reply_text(chunk)
    except Exception as e:
        await update.message.reply_text(f"❌ {e}")


async def cmd_contacts(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not check_access(update): return
    contacts = vault_index.get_contacts(top_n=20)
    if not contacts:
        await update.message.reply_text("👥 Контакты не найдены.")
        return
    text = "👥 Топ контактов:\n\n"
    kb   = []
    for i, (name, email, cnt) in enumerate(contacts[:10], 1):
        bar   = "█" * min(cnt//2, 12)
        text += f"{i}. {name}\n   {bar} {cnt} писем\n\n"
        kb.append([InlineKeyboardButton(
            f"👤 {name[:25]}", callback_data=f"person_{name[:30]}")])
    await update.message.reply_text(text[:4000], reply_markup=InlineKeyboardMarkup(kb))


async def cmd_favorites(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not check_access(update): return
    uid  = update.effective_user.id
    favs = get_favorites(uid)
    if not favs:
        await update.message.reply_text("⭐ Избранное пусто.\n\nДобавляйте через /search → кнопка '⭐ В избранное'")
        return
    text = "⭐ Избранное:\n\n"
    kb   = []
    for i, fav in enumerate(favs):
        text += f"{i+1}. {fav['title']}\n   📁 {fav.get('folder','')}  📅 {fav.get('date','')}\n\n"
        kb.append([InlineKeyboardButton(f"🗑 Удалить: {fav['title'][:20]}",
                                        callback_data=f"fav_del_{i}")])
    await update.message.reply_text(text[:4000], reply_markup=InlineKeyboardMarkup(kb))


async def cmd_export(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not check_access(update): return
    kb = [
        [InlineKeyboardButton("📋 Экспорт задач",     callback_data="export_tasks")],
        [InlineKeyboardButton("👥 Экспорт контактов", callback_data="export_contacts")],
        [InlineKeyboardButton("⭐ Экспорт избранного", callback_data="export_favorites")],
        [InlineKeyboardButton("🗓 Экспорт дайджеста",  callback_data="export_digest")],
    ]
    await update.message.reply_text("📤 Что экспортировать?",
                                    reply_markup=InlineKeyboardMarkup(kb))


async def cmd_plaud(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not check_access(update): return
    args = context.args or []
    if not args:
        digest = Path(VAULT_PATH) / "04_Plaud_Transcripts" / "_digest.md"
        if digest.exists():
            content = digest.read_text(encoding="utf-8")
            content = re.sub(r"---.*?---", "", content, flags=re.DOTALL).strip()
            content = re.sub(r"\[\[([^\]|]+)\|([^\]]+)\]\]", r"\2", content)
            content = re.sub(r"\[\[([^\]]+)\]\]", r"\1", content)
            await update.message.reply_text(f"🎙️ Голосовые записи\n\n{content[:3800]}")
        else:
            await update.message.reply_text(
                "🎙️ Дайджест не создан. Запустите yandex_to_obsidian.py с ANTHROPIC_KEY.")
        return
    query = " ".join(args)
    msg   = await update.message.reply_text(f"🎙️ Ищу: {query}...")
    try:
        docs = vault_index.search(query, top_k=3, doc_type="voice_transcript")
        if not docs:
            await msg.edit_text("🎙️ Не найдено.")
            return
        doc = docs[0]
        if "О чём:" in doc["body"]:
            s = doc["body"].find("## 🤖 AI Выжимка")
            e = doc["body"].find("## 📝 Полная транскрипция")
            if s != -1 and e != -1:
                await msg.edit_text(f"🎙️ {doc['title']}\n\n{doc['body'][s:e].strip()[:3800]}")
                return
        await msg.edit_text(f"🤖 Генерирую выжимку...")
        resp = claude_rag.client.messages.create(
            model=claude_rag.model, max_tokens=600,
            messages=[{"role":"user","content":
                f"Выжимка:\n{doc['body'][:4000]}\n\n"
                "О чём:\nКлючевые моменты:\n- ...\nЗадачи:\n- [ ] ..."}]
        )
        await msg.edit_text(f"🎙️ {doc['title']}\n\n{resp.content[0].text[:3800]}")
    except Exception as e:
        await msg.edit_text(f"❌ {e}")


async def cmd_clear(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not check_access(update): return
    uid = update.effective_user.id
    clear_dialog(uid)
    # Сбрасываем и фильтры тоже если попросили
    args = context.args or []
    if "all" in args:
        set_filter(uid, "folders", [])
        set_filter(uid, "types",   [])
        await update.message.reply_text("✅ История диалога и фильтры очищены.")
    else:
        await update.message.reply_text(
            "✅ История диалога очищена.\n"
            "Подсказка: /clear all — очистить также фильтры поиска"
        )


async def cmd_stats(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not check_access(update): return
    s    = vault_index.stats()
    text = f"📊 Всего: {s['total']}\n\n"
    for t, n in sorted(s["by_type"].items(), key=lambda x:-x[1]):
        e   = {"email":"📧","messenger_chat":"💬","voice_transcript":"🎙️",
               "disk_file":"💾","contact":"👤"}.get(t,"📄")
        bar = "█" * min(n//10, 20)
        text += f"{e} {t}: {n} {bar}\n"
    await update.message.reply_text(text)


# ──────────────────────────────────────────────
#  СВОБОДНЫЙ ВОПРОС (с памятью диалога)
# ──────────────────────────────────────────────

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not check_access(update): return
    question = update.message.text.strip()
    if not question:
        return
    uid  = update.effective_user.id
    filt = get_filter(uid)
    msg  = await update.message.reply_text("🤔 Ищу в базе знаний...")
    try:
        dt     = filt["types"][0] if len(filt["types"]) == 1 else None
        answer = claude_rag.ask(question, user_id=uid,
                                doc_type=dt, folders=filt["folders"])
        chunks = [answer[i:i+4000] for i in range(0, len(answer), 4000)]
        await msg.edit_text(chunks[0])
        for chunk in chunks[1:]:
            await update.message.reply_text(chunk)
    except Exception as e:
        await msg.edit_text(f"❌ {e}")


# ──────────────────────────────────────────────
#  ГОЛОСОВЫЕ СООБЩЕНИЯ
# ──────────────────────────────────────────────

def grok_transcribe(audio_path: str) -> str:
    """Транскрибирует аудиофайл через Grok STT API."""
    if not GROK_KEY:
        raise ValueError("Укажите GROK_KEY в .env файле")

    audio_path = str(audio_path)
    with open(audio_path, "rb") as f:
        audio_bytes = f.read()

    ext = Path(audio_path).suffix.lower()
    log.info(f"STT: файл {audio_path} ({len(audio_bytes)//1024}КБ), ext={ext}")

    mime_map = {
        ".ogg":  "audio/ogg",
        ".mp3":  "audio/mpeg",
        ".wav":  "audio/wav",
        ".m4a":  "audio/mp4",
        ".flac": "audio/flac",
        ".webm": "audio/webm",
        ".opus": "audio/opus",
    }
    primary_mime = mime_map.get(ext, "audio/mpeg")  # default mp3
    # Для MP3 пробуем только mp3, для остальных — все варианты
    if ext == ".mp3":
        mime_attempts = ["audio/mpeg"]
    else:
        mime_attempts = [primary_mime] + [
            m for m in ["audio/mpeg", "audio/wav"]
            if m != primary_mime
        ]
    log.info(f"STT: пробую MIME: {mime_attempts}")

    last_error = None
    for mime in mime_attempts:
        try:
            fname = Path(audio_path).name
            # Для MP3 MIME меняем расширение в имени файла
            if mime == "audio/mpeg" and not fname.endswith(".mp3"):
                fname = fname.rsplit(".",1)[0] + ".mp3"

            payload = {
                "model":    "grok-stt",
                "language": GROK_LANGUAGE,
            }
            try:
                resp = requests.post(
                    GROK_STT_URL,
                    headers={"Authorization": f"Bearer {GROK_KEY}"},
                    files={"file": (fname, audio_bytes, mime)},
                    data=payload,
                    timeout=60
                )
            except requests.exceptions.SSLError:
                resp = requests.post(
                    GROK_STT_URL,
                    headers={"Authorization": f"Bearer {GROK_KEY}"},
                    files={"file": (fname, audio_bytes, mime)},
                    data=payload,
                    timeout=60, verify=False
                )
            if resp.status_code == 400:
                last_error = f"400 с mime={mime}"
                continue  # пробуем следующий MIME
            resp.raise_for_status()
            data = resp.json()
            if "text" in data:
                return data["text"].strip()
            elif "segments" in data:
                return " ".join(s.get("text","") for s in data["segments"]).strip()
            else:
                raise ValueError(f"Неожиданный ответ: {data}")
        except requests.HTTPError as e:
            last_error = str(e)
            if e.response is not None and e.response.status_code != 400:
                raise  # не 400 — не пробуем дальше
            continue

    raise ValueError(f"Grok STT не принял файл ({last_error}). "
                    f"Установите ffmpeg: brew install ffmpeg")


def grok_chat(messages: list, system: str = "") -> str:
    """
    Отправляет запрос к Grok Chat API.
    Совместим с OpenAI API форматом.
    """
    if not GROK_KEY:
        raise ValueError("Укажите GROK_KEY в .env файле")

    payload = {
        "model": GROK_CHAT_MODEL,
        "messages": ([{"role": "system", "content": system}] if system else []) + messages,
        "max_tokens": 800,
        "temperature": 0.7,
    }
    resp = requests.post(
        GROK_CHAT_URL,
        headers={
            "Authorization": f"Bearer {GROK_KEY}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=30
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


async def handle_voice(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Обрабатывает голосовые сообщения:
    1. Скачивает OGG из Telegram
    2. Транскрибирует через Grok STT API
    3. Ищет по vault через Claude RAG
    4. Отвечает пользователю
    """
    if not check_access(update): return

    msg = await update.message.reply_text("🎤 Получил голосовое...")
    tmp_path = None

    try:
        # Шаг 1: скачиваем файл
        voice    = update.message.voice
        duration = voice.duration
        file_obj = await context.bot.get_file(voice.file_id)
        tmp_path = f"/tmp/voice_{voice.file_id}.ogg"
        await file_obj.download_to_drive(tmp_path)
        size_kb  = Path(tmp_path).stat().st_size // 1024

        await msg.edit_text(
            f"🎤 Файл получен ({duration}с, {size_kb}КБ)\n"
            f"⚙️ Транскрибирую через Grok STT..."
        )

        # Шаг 2: транскрибируем через Grok STT
        if not GROK_KEY:
            await msg.edit_text(
                "⚠️ Grok STT не настроен.\n\n"
                "Добавьте ключ в скрипт:\n"
                "GROK_KEY = \"ваш ключ с console.x.ai\"")
            return

        # Конвертируем OGG → MP3 через ffmpeg
        mp3_path = tmp_path.replace(".ogg", ".mp3")
        transcribe_path = tmp_path  # fallback
        try:
            import subprocess, shutil
            # Ищем ffmpeg в стандартных путях macOS
            ffmpeg_bin = (shutil.which("ffmpeg") or
                         "/usr/local/bin/ffmpeg" if Path("/usr/local/bin/ffmpeg").exists()
                         else "/opt/homebrew/bin/ffmpeg")
            result = subprocess.run(
                [ffmpeg_bin, "-i", tmp_path, "-ar", "16000",
                 "-ac", "1", "-q:a", "2", mp3_path, "-y"],
                capture_output=True, timeout=30
            )
            if result.returncode == 0 and Path(mp3_path).exists():
                transcribe_path = mp3_path
                log.info(f"Voice: конвертирован в MP3 ({Path(mp3_path).stat().st_size//1024}КБ)")
                await msg.edit_text(
                    f"🎤 Файл получен ({duration}с)\n"
                    f"⚙️ Транскрибирую через Grok STT..."
                )
            else:
                log.warning(f"ffmpeg вернул код {result.returncode}: {result.stderr.decode()[:200]}")
        except Exception as ex:
            log.warning(f"ffmpeg ошибка: {ex}")

        text = grok_transcribe(transcribe_path)

        if not text:
            await msg.edit_text("🎤 Не удалось распознать речь. Попробуйте ещё раз.")
            return

        await msg.edit_text(
            f"🎤 Распознано (Grok STT):\n\n"
            f"_{text}_\n\n"
            f"🔍 Ищу в базе знаний..."
        )

        # Шаг 3: поиск по vault через Claude RAG
        uid  = update.effective_user.id
        filt = get_filter(uid)
        dt   = filt["types"][0] if len(filt["types"]) == 1 else None

        answer = claude_rag.ask(
            text, user_id=uid,
            doc_type=dt, folders=filt["folders"]
        )

        # Шаг 4: отправляем ответ с кнопками
        kb = [[
            InlineKeyboardButton("🔍 Поиск по тексту",
                                 callback_data=f"voice_search_{text[:40]}"),
            InlineKeyboardButton("⭐ В избранное",
                                 callback_data="noop"),
        ]]

        await msg.edit_text(
            f"🎤 «{text[:80]}{'…' if len(text)>80 else ''}»\n\n{answer[:3600]}",
            reply_markup=InlineKeyboardMarkup(kb)
        )

        log.info(f"Voice: {duration}с → {len(text)} символов → ответ {len(answer)} символов")

    except requests.HTTPError as e:
        status = e.response.status_code if e.response else "?"
        if status == 401:
            await msg.edit_text("❌ Grok STT: неверный API ключ. Проверьте GROK_KEY.")
        elif status == 429:
            await msg.edit_text("❌ Grok STT: превышен лимит запросов. Попробуйте позже.")
        else:
            await msg.edit_text(f"❌ Grok STT ошибка {status}: {e}")
    except Exception as e:
        await msg.edit_text(f"❌ Ошибка: {e}")
        log.error(f"Voice error: {e}")
    finally:
        # Всегда удаляем временный файл
        if tmp_path:
            Path(tmp_path).unlink(missing_ok=True)


# ──────────────────────────────────────────────
#  CALLBACK КНОПОК
# ──────────────────────────────────────────────

async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query   = update.callback_query
    await query.answer()
    data    = query.data
    user_id = query.from_user.id

    if data == "noop":
        return

    # Переиндексация vault
    if data == "refresh_index":
        global vault_index, claude_rag
        stats_before = vault_index.stats()
        await query.edit_message_text("🔄 Переиндексирую vault...")
        try:
            vault_index = VaultIndex(VAULT_PATH)
            claude_rag  = ClaudeRAG(ANTHROPIC_KEY, vault_index)
            stats_after = vault_index.stats()
            new_docs    = stats_after["total"] - stats_before["total"]
            sign        = ("+" + str(new_docs)) if new_docs >= 0 else str(new_docs)
            await query.edit_message_text(
                "✅ Готово!\n\n"
                f"Было: {stats_before['total']} → Стало: {stats_after['total']} ({sign})"
            )
        except Exception as e:
            await query.edit_message_text(f"❌ {e}")
        return

    # Яндекс Диск синхронизация
    if data == "disk_sync_status":
        status = _get_disk_status()
        kb = [
            [InlineKeyboardButton("🔄 Синхронизировать", callback_data="disk_sync_start")],
            [InlineKeyboardButton("🔄 Принудительно всё", callback_data="disk_sync_force")],
        ]
        await query.edit_message_text(
            f"💾 Яндекс Диск\n\n"
            f"Файлов в vault: {status['total_files']}\n"
            f"Последняя синхронизация: {status['last_sync']}",
            reply_markup=InlineKeyboardMarkup(kb)
        )
        return

    if data in ("disk_sync_start", "disk_sync_force"):
        force = data == "disk_sync_force"
        msg   = await query.edit_message_text(
            f"💾 {'Принудительная с' if force else 'С'}инхронизация запущена...\n\n"
            f"Это может занять несколько минут."
        )
        # Запускаем синхронизацию как background task
        import asyncio
        loop = asyncio.get_event_loop()
        loop.create_task(
            _run_disk_sync_async(
                context.bot, query.message.chat_id,
                msg.message_id, force=force
            )
        )
        return

    # Переключение модели
    if data == "switch_model":
        uid       = user_id
        model_key = get_model_key(uid)
        current   = AVAILABLE_MODELS[model_key]
        text      = f"🤖 Текущая модель: {current['name']}\n\nВыберите модель:"
        kb        = []
        for key, cfg in AVAILABLE_MODELS.items():
            mark = "✅ " if key == model_key else ""
            kb.append([InlineKeyboardButton(
                f"{mark}{cfg['name']} ({cfg['provider']})",
                callback_data=f"set_model_{key}"
            )])
        await query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(kb))
        return

    if data.startswith("set_model_"):
        key = data.replace("set_model_", "")
        if key in AVAILABLE_MODELS:
            set_active_model(user_id, key)
            cfg = AVAILABLE_MODELS[key]
            kb  = []
            for k, c in AVAILABLE_MODELS.items():
                mark = "✅ " if k == key else ""
                kb.append([InlineKeyboardButton(
                    f"{mark}{c['name']} ({c['provider']})",
                    callback_data=f"set_model_{k}"
                )])
            await query.edit_message_text(
                f"✅ Модель переключена на: {cfg['name']}\n"
                f"Провайдер: {cfg['provider']}\n\n"
                f"Все следующие запросы будут использовать {cfg['name']}.",
                reply_markup=InlineKeyboardMarkup(kb)
            )
        return

    # Статистика токенов
    if data == "show_usage":
        stats = get_token_stats(user_id)
        PRICING = {
            "haiku": {"in": 0.80,  "out": 4.00},
            "llama": {"in": 0.05,  "out": 0.08},
        }
        if not stats:
            await query.edit_message_text("📊 Статистика пуста.")
            return
        text = "📊 Статистика токенов\n\n"
        total_cost = 0.0
        for model_key, data_s in stats.items():
            cfg    = AVAILABLE_MODELS.get(model_key, {})
            name   = cfg.get("name", model_key)
            t_in   = data_s.get("in", 0)
            t_out  = data_s.get("out", 0)
            reqs   = data_s.get("requests", 0)
            p      = PRICING.get(model_key, {"in": 0, "out": 0})
            cost   = (t_in/1_000_000*p["in"] + t_out/1_000_000*p["out"])
            total_cost += cost
            text  += (f"🤖 {name}\n"
                      f"   Запросов: {reqs}\n"
                      f"   ⬆️  Input:  {t_in:,} токенов\n"
                      f"   ⬇️  Output: {t_out:,} токенов\n"
                      f"   💰 ~${cost:.4f}\n\n")
        text += f"💰 Итого: ~${total_cost:.4f}"
        kb = [[InlineKeyboardButton("🔄 Сменить модель", callback_data="switch_model")]]
        await query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(kb))
        return

    # Голосовой поиск — кнопка под голосовым ответом
    if data.startswith("voice_search_"):
        query = data.replace("voice_search_", "")
        await query.edit_message_text(f"🔍 Поиск: {query}...")
        try:
            docs = vault_index.search(query, top_k=5)
            em   = {"email":"📧","messenger_chat":"💬","voice_transcript":"🎙️","disk_file":"💾"}
            text = f"🔍 {query}\n\n"
            for doc in docs:
                snip  = doc["body"][:100].replace("\n"," ").strip()
                text += f"{em.get(doc['type'],'📄')} {doc['title']}\n"
                if doc.get("folder"): text += f"   📁 {doc['folder']}"
                if doc.get("date"):   text += f"  📅 {doc['date']}"
                text += f"\n   {snip}…\n\n"
            await query.edit_message_text(text[:4000])
        except Exception as e:
            await query.edit_message_text(f"❌ {e}")
        return

    # Меню из главного экрана
    if data == "where":
        f = get_filter(user_id)
        kb, status = build_folder_keyboard(f["folders"], f["types"])
        await query.edit_message_text(status, reply_markup=InlineKeyboardMarkup(kb))
        return

    if data == "insights":
        await query.edit_message_text("💡 Анализирую...")
        try:
            await query.edit_message_text(claude_rag.proactive_insights())
        except Exception as e:
            await query.edit_message_text(f"❌ {e}")
        return

    if data == "analytics":
        await query.edit_message_text("📊 Считаю...")
        try:
            await query.edit_message_text(claude_rag.analytics_report())
        except Exception as e:
            await query.edit_message_text(f"❌ {e}")
        return

    if data == "favorites":
        favs = get_favorites(user_id)
        if not favs:
            await query.edit_message_text("⭐ Избранное пусто.")
        else:
            text = "⭐ Избранное:\n\n"
            for i, fav in enumerate(favs):
                text += f"{i+1}. {fav['title']}\n   📅 {fav.get('saved_at','')}\n\n"
            await query.edit_message_text(text[:4000])
        return

    if data == "export_menu":
        kb = [
            [InlineKeyboardButton("📋 Задачи",     callback_data="export_tasks")],
            [InlineKeyboardButton("👥 Контакты",   callback_data="export_contacts")],
            [InlineKeyboardButton("⭐ Избранное",   callback_data="export_favorites")],
            [InlineKeyboardButton("🗓 Дайджест",    callback_data="export_digest")],
        ]
        await query.edit_message_text("📤 Что экспортировать?",
                                      reply_markup=InlineKeyboardMarkup(kb))
        return

    # Саммари
    if data.startswith("summary_"):
        dt = {"summary_email":"email","summary_chat":"messenger_chat",
              "summary_voice":"voice_transcript","summary_disk":"disk_file"}.get(data,"email")
        await query.edit_message_text("⏳ Генерирую саммари...")
        try:
            await query.edit_message_text(claude_rag.summarize(dt, uid=user_id)[:4000])
        except Exception as e:
            await query.edit_message_text(f"❌ {e}")
        return

    if data == "tasks" or data == "tasks_refresh":
        await query.edit_message_text("⏳ Ищу задачи...")
        try:
            result     = claude_rag.extract_tasks(uid=user_id)
            task_lines = re.findall(r"- \[ \] (.+)", result)
            if task_lines:
                tasks = [{"text": t, "done": False} for t in task_lines]
                save_tasks(user_id, tasks)
            await query.edit_message_text(result[:4000])
        except Exception as e:
            await query.edit_message_text(f"❌ {e}")
        return

    if data.startswith("task_toggle_"):
        idx   = int(data.replace("task_toggle_",""))
        tasks = get_tasks(user_id)
        if 0 <= idx < len(tasks):
            tasks[idx]["done"] = not tasks[idx]["done"]
            save_tasks(user_id, tasks)
        text = "📋 Задачи:\n\n"
        kb   = []
        for i, task in enumerate(tasks):
            mark = "✅" if task.get("done") else "☐"
            text += f"{mark} {task['text']}\n"
            kb.append([
                InlineKeyboardButton(
                    f"{'↩️ Отменить' if task.get('done') else '✅ Выполнено'}",
                    callback_data=f"task_toggle_{i}"),
                InlineKeyboardButton("🗑", callback_data=f"task_del_{i}")
            ])
        await query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(kb))
        return

    if data.startswith("task_del_"):
        idx   = int(data.replace("task_del_",""))
        tasks = get_tasks(user_id)
        if 0 <= idx < len(tasks):
            tasks.pop(idx)
            save_tasks(user_id, tasks)
        await query.answer("Задача удалена")
        return

    if data == "digest":
        await query.edit_message_text("⏳ Генерирую дайджест...")
        try:
            await query.edit_message_text(claude_rag.weekly_digest()[:4000])
        except Exception as e:
            await query.edit_message_text(f"❌ {e}")
        return

    if data == "contacts":
        contacts = vault_index.get_contacts(top_n=10)
        text = "👥 Топ контактов:\n\n"
        kb   = []
        for i, (name, email, cnt) in enumerate(contacts, 1):
            text += f"{i}. {name} — {cnt} писем\n"
            kb.append([InlineKeyboardButton(f"👤 {name[:25]}",
                                            callback_data=f"person_{name[:30]}")])
        await query.edit_message_text(text[:4000], reply_markup=InlineKeyboardMarkup(kb))
        return

    if data.startswith("person_"):
        name = data.replace("person_","")
        await query.edit_message_text(f"👤 Ищу всё по: {name}...")
        try:
            result = claude_rag.person_report(name, uid=user_id)
            await query.edit_message_text(result[:4000])
        except Exception as e:
            await query.edit_message_text(f"❌ {e}")
        return

    if data == "stats":
        s    = vault_index.stats()
        text = f"📊 Всего: {s['total']}\n"
        for t, n in sorted(s["by_type"].items(), key=lambda x:-x[1]):
            text += f"• {t}: {n}\n"
        await query.edit_message_text(text)
        return

    # Избранное
    if data.startswith("fav_") and not data.startswith("fav_del_"):
        doc_id = data.replace("fav_","")
        doc    = next((d for d in vault_index.docs
                       if d["id"].startswith(doc_id)), None)
        if doc:
            add_favorite(user_id, doc)
            await query.answer("⭐ Добавлено в избранное!")
        return

    if data.startswith("fav_del_"):
        idx  = int(data.replace("fav_del_",""))
        favs = get_favorites(user_id)
        if 0 <= idx < len(favs):
            STATE["favorites"][str(user_id)].pop(idx)
            save_state(STATE)
        await query.answer("Удалено из избранного")
        return

    # Экспорт
    if data.startswith("export_"):
        export_type = data.replace("export_","")
        await query.edit_message_text("⏳ Готовлю файл...")
        try:
            if export_type == "tasks":
                content = "# Задачи\n\n" + claude_rag.extract_tasks(uid=user_id)
            elif export_type == "contacts":
                contacts = vault_index.get_contacts(top_n=50)
                content  = "# Контакты\n\n"
                for n, e, c in contacts:
                    content += f"- {n} | {e} | {c} писем\n"
            elif export_type == "favorites":
                favs    = get_favorites(user_id)
                content = "# Избранное\n\n"
                for f in favs:
                    content += f"- {f['title']} | {f.get('folder','')} | {f.get('date','')}\n"
            elif export_type == "digest":
                content = claude_rag.weekly_digest()
            else:
                content = f"Неизвестный тип: {export_type}"

            tmp = Path(f"/tmp/vault_export_{export_type}.txt")
            tmp.write_text(content, encoding="utf-8")
            await context.bot.send_document(
                chat_id=query.message.chat_id,
                document=tmp.open("rb"),
                filename=f"vault_{export_type}_{datetime.now().strftime('%Y%m%d')}.txt",
                caption=f"📤 Экспорт: {export_type}"
            )
            tmp.unlink(missing_ok=True)
            await query.edit_message_text("✅ Файл отправлен!")
        except Exception as e:
            await query.edit_message_text(f"❌ {e}")
        return

    # Фильтры папок
    if data == "filter_reset":
        set_filter(user_id, "folders", [])
        set_filter(user_id, "types",   [])
        kb, status = build_folder_keyboard([], [])
        await query.edit_message_text("✅ Сброшено.\n\n"+status,
                                      reply_markup=InlineKeyboardMarkup(kb))
        return

    if data == "filter_all":
        all_f = vault_index.get_folders().get("📧 Почта", [])
        set_filter(user_id, "folders", all_f)
        set_filter(user_id, "types",   ["email"])
        kb, status = build_folder_keyboard(all_f, ["email"])
        await query.edit_message_text(status, reply_markup=InlineKeyboardMarkup(kb))
        return

    if data.startswith("fpage_"):
        page = int(data.replace("fpage_",""))
        f    = get_filter(user_id)
        kb, status = build_folder_keyboard(f["folders"], f["types"], page=page)
        await query.edit_message_text(status, reply_markup=InlineKeyboardMarkup(kb))
        return

    if data.startswith("filter_type_"):
        dtype = data.replace("filter_type_","")
        types = get_filter(user_id)["types"]
        types = [t for t in types if t != dtype] if dtype in types else types + [dtype]
        set_filter(user_id, "types", types)
        f = get_filter(user_id)
        kb, status = build_folder_keyboard(f["folders"], types)
        await query.edit_message_text(status, reply_markup=InlineKeyboardMarkup(kb))
        return

    if data.startswith("ff_"):
        folder  = data.replace("ff_","")
        folders = get_filter(user_id)["folders"]
        folders = [f for f in folders if f != folder] if folder in folders else folders+[folder]
        set_filter(user_id, "folders", folders)
        types   = get_filter(user_id)["types"]
        if "email" not in types and folders:
            types = types + ["email"]
            set_filter(user_id, "types", types)
        kb, status = build_folder_keyboard(folders, types)
        await query.edit_message_text(status, reply_markup=InlineKeyboardMarkup(kb))
        return


# ──────────────────────────────────────────────
#  ФОНОВЫЕ ЗАДАЧИ
# ──────────────────────────────────────────────

async def job_weekly_digest(context: ContextTypes.DEFAULT_TYPE):
    if not ALLOWED_USER_ID: return
    try:
        result = claude_rag.weekly_digest()
        await context.bot.send_message(chat_id=ALLOWED_USER_ID, text=result[:4000])
        log.info("✅ Дайджест отправлен")
    except Exception as e:
        log.error(f"Дайджест: {e}")

async def job_email_alerts(context: ContextTypes.DEFAULT_TYPE):
    if not ALLOWED_USER_ID or not ALERT_KEYWORDS: return
    try:
        alerts = claude_rag.check_alerts(ALERT_KEYWORDS)
        if not alerts: return
        text = "🔔 Важные письма:\n\n"
        for a in alerts[:5]:
            text += f"⚡ {a['keyword'].upper()}\nОт: {a['from']}\nТема: {a['subject']}\n\n"
        await context.bot.send_message(chat_id=ALLOWED_USER_ID, text=text)
    except Exception as e:
        log.error(f"Алерты: {e}")

async def job_proactive_insights(context: ContextTypes.DEFAULT_TYPE):
    """Раз в день присылает проактивные инсайты если они есть."""
    if not ALLOWED_USER_ID: return
    try:
        insights = claude_rag.proactive_insights()
        if "Всё спокойно" not in insights:
            await context.bot.send_message(chat_id=ALLOWED_USER_ID, text=insights)
    except Exception as e:
        log.error(f"Инсайты: {e}")


# ──────────────────────────────────────────────
#  ЗАПУСК
# ──────────────────────────────────────────────

def main():
    global vault_index, claude_rag

    print("╔══════════════════════════════════════════════╗")
    print("║  Vault Bot v3                                 ║")
    print("╚══════════════════════════════════════════════╝")

    if not TELEGRAM_TOKEN:
        print("❌ Укажите TELEGRAM_TOKEN!"); return
    if not ANTHROPIC_KEY:
        print("❌ Укажите ANTHROPIC_KEY!"); return

    vault_index = VaultIndex(VAULT_PATH)
    claude_rag  = ClaudeRAG(ANTHROPIC_KEY, vault_index)

    app = (
        Application.builder()
        .token(TELEGRAM_TOKEN)
        .connect_timeout(30).read_timeout(30)
        .write_timeout(30).pool_timeout(30)
        .build()
    )

    for cmd, handler in [
        ("start",     cmd_start),    ("help",      cmd_start),
        ("refresh",   cmd_refresh),  ("model",     cmd_model),    ("usage",     cmd_usage),
        ("disk",      cmd_disk_sync),
        ("disk_search", cmd_disk_search),
        ("where",     cmd_where),    ("search",    cmd_search),
        ("person",    cmd_person),   ("insights",  cmd_insights),
        ("analytics", cmd_analytics),("summary",   cmd_summary),
        ("tasks",     cmd_tasks),    ("digest",    cmd_digest),
        ("contacts",  cmd_contacts), ("favorites", cmd_favorites),
        ("export",    cmd_export),   ("plaud",     cmd_plaud),
        ("clear",     cmd_clear),    ("stats",     cmd_stats),
    ]:
        app.add_handler(CommandHandler(cmd, handler))

    app.add_handler(CallbackQueryHandler(handle_callback))
    app.add_handler(MessageHandler(filters.VOICE, handle_voice))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    async def error_handler(update, context):
        err = str(context.error)
        if any(x in err for x in ["ConnectError","NetworkError","TimedOut"]):
            log.warning(f"Сеть: {context.error}")
        else:
            log.error(f"Ошибка: {context.error}")
    app.add_error_handler(error_handler)

    jq = app.job_queue
    if jq:
        jq.run_repeating(job_email_alerts,      interval=3600,  first=60)
        jq.run_repeating(job_proactive_insights, interval=86400, first=3600)
        jq.run_daily(
            job_weekly_digest,
            time=datetime.now().replace(hour=DIGEST_HOUR, minute=0, second=0).time(),
            days=(DIGEST_WEEKDAY,)
        )

    print(f"\n✅ Запущен! Заметок: {len(vault_index.docs)}")
    print(f"   BM25: {'да' if HAS_BM25 else 'нет (pip install rank-bm25)'}")
    print(f"   Голосовые: {'да (pip install openai)' if True else 'нет'}")
    print(f"   Алерты каждый час по: {ALERT_KEYWORDS}")
    print(f"   Дайджест каждый пн {DIGEST_HOUR}:00 UTC")
    print(f"   Инсайты каждый день")
    print("   Ctrl+C — остановка\n")

    app.run_polling(drop_pending_updates=True,
                    allowed_updates=["message","callback_query"])


if __name__ == "__main__":
    main()
