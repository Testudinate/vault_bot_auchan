"""
config.py — загружает все настройки из .env файла.
Используется всеми скриптами проекта.

Порядок поиска .env:
  1. Папка запуска скрипта
  2. Родительская папка
  3. Домашняя директория ~/
"""

import os
from pathlib import Path


def _find_env_file():
    """Ищет .env файл в нескольких местах."""
    candidates = [
        Path(".env"),
        Path(__file__).parent / ".env",
        Path(__file__).parent.parent / ".env",
        Path.home() / ".env",
        Path.home() / ".vault" / ".env",
    ]
    for p in candidates:
        if p.exists():
            return p
    return None


def _load_dotenv(path: Path):
    """Парсит .env файл и загружает переменные в os.environ."""
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            key   = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:  # не перезаписываем системные
                os.environ[key] = value


# Загружаем .env при импорте модуля
_env_path = _find_env_file()
if _env_path:
    _load_dotenv(_env_path)
    print(f"✅ Конфиг загружен: {_env_path.resolve()}")
else:
    print("⚠️  Файл .env не найден — используются значения по умолчанию")
    print("   Создайте .env из шаблона: cp .env.template .env")


def get(key: str, default: str = "") -> str:
    """Возвращает значение переменной из окружения."""
    return os.environ.get(key, default)


def get_int(key: str, default: int = 0) -> int:
    try:
        return int(os.environ.get(key, default))
    except (ValueError, TypeError):
        return default


def get_list(key: str, default: list = None, sep: str = ",") -> list:
    """Возвращает список из строки разделённой sep."""
    val = os.environ.get(key, "")
    if not val:
        return default or []
    return [v.strip() for v in val.split(sep) if v.strip()]


# ── Все настройки проекта ──────────────────────────────────────

# Telegram
TELEGRAM_TOKEN  = get("TELEGRAM_TOKEN",  "")
ALLOWED_USER_ID = get_int("ALLOWED_USER_ID", 0)
MY_EMAIL        = get("MY_EMAIL",        "")

# LLM API
ANTHROPIC_KEY   = get("ANTHROPIC_KEY",   "")
GROK_KEY        = get("GROK_KEY",        "")
GROQ_KEY        = get("GROQ_KEY",        "")

# Grok настройки
GROK_STT_URL    = "https://api.x.ai/v1/stt"
GROK_CHAT_URL   = "https://api.x.ai/v1/chat/completions"
GROK_CHAT_MODEL = get("GROK_CHAT_MODEL", "grok-3-turbo")
GROK_LANGUAGE   = get("GROK_LANGUAGE",   "ru")

# Groq настройки
GROQ_CHAT_URL   = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL      = get("GROQ_MODEL",      "llama-3.1-8b-instant")

# Модели
DEFAULT_MODEL   = get("DEFAULT_MODEL",   "haiku")
AVAILABLE_MODELS = {
    "haiku": {"name": "Claude Haiku",         "provider": "anthropic", "model": "claude-haiku-4-5-20251001"},
    "llama": {"name": "Llama 3.1 8B Instant", "provider": "groq",      "model": GROQ_MODEL},
}

# Яндекс
YANDEX_LOGIN            = get("YANDEX_LOGIN",            "your_login@yandex.ru")
YANDEX_PASSWORD         = get("YANDEX_PASSWORD",         "")
YANDEX_DISK_TOKEN       = get("YANDEX_DISK_TOKEN",       "")
YANDEX_BOT_TOKEN        = get("YANDEX_BOT_TOKEN",        "")

# JupyterHub
JH_TOKEN        = get("JH_TOKEN",        "")
JH_URL          = get("JH_URL",          "")
MY_KERNEL_ID    = get("MY_KERNEL_ID",    "")

# Пути
VAULT_PATH              = get("VAULT_PATH",              "./ObsidianVault")
PLAUD_TXT_FOLDER        = get("PLAUD_TXT_FOLDER",        "./plaud_transcripts")
YANDEX_MESSENGER_EXPORT = get("YANDEX_MESSENGER_EXPORT", "./messenger_export")
YANDEX_DISK_FOLDER      = get("YANDEX_DISK_FOLDER",      "./yandex_disk_files")
LOCAL_AI_FOLDER         = get("LOCAL_AI_FOLDER",         "./")

# Настройки бота
ALERT_KEYWORDS  = get_list("ALERT_KEYWORDS",
                            default=["urgent","срочно","invoice","счёт","deadline","дедлайн"])
DIGEST_WEEKDAY  = get_int("DIGEST_WEEKDAY", 0)
DIGEST_HOUR     = get_int("DIGEST_HOUR",    7)
SYNC_EVERY_HOURS = get_int("SYNC_EVERY_HOURS", 1)

# Настройки диска
DISK_ROOT_FOLDER = get("DISK_ROOT_FOLDER", "/")
MAX_FILE_SIZE_MB = get_int("MAX_FILE_SIZE_MB", 10)
