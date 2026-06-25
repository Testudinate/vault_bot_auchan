# 🤖 Vault Bot — Инструкция по запуску

## Что делает бот

| Команда | Функция |
|---|---|
| Любой текст | RAG-поиск по vault + ответ Claude |
| `/summary` | Саммари почты / чатов / записей |
| `/tasks` | Задачи и дедлайны из переписки |
| `/search запрос` | Прямой поиск по базе |
| `/stats` | Статистика vault |

---

## Установка

### 1. Зависимости

```bash
# Минимальный вариант (текстовый поиск)
pip install python-telegram-bot anthropic

# Полный вариант (семантический поиск — рекомендуется)
pip install python-telegram-bot anthropic chromadb sentence-transformers
```

### 2. Получить токены

**Telegram токен:**
1. Напишите @BotFather → /newbot
2. Назовите бота → скопируйте токен

**Anthropic API key:**
1. console.anthropic.com → API Keys → Create Key

**Ваш Telegram ID (для защиты):**
1. Напишите @userinfobot → скопируйте ваш ID

### 3. Настроить скрипт

Откройте `vault_bot.py` и измените 4 строки:

```python
TELEGRAM_TOKEN  = "1234567890:AAF..."   # токен от @BotFather
ANTHROPIC_KEY   = "sk-ant-..."           # ключ Anthropic
VAULT_PATH      = "./ObsidianVault"      # путь к vault
ALLOWED_USER_ID = 123456789              # ваш Telegram ID
```

### 4. Запуск

```bash
python vault_bot.py
```

При первом запуске с векторным поиском (~2 мин) строится индекс.
Последующие запуски быстрые — индекс сохраняется в `.vault_index/`.

---

## Запуск в фоне (Linux/Mac)

```bash
# Через screen
screen -S vaultbot
python vault_bot.py
# Ctrl+A, D — отключиться (бот продолжает работать)

# Или через nohup
nohup python vault_bot.py > bot.log 2>&1 &
```

## Обновление vault

После добавления новых заметок перезапустите бота —
индекс перестроится автоматически.
