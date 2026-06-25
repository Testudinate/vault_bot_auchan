'use strict';
/**
 * config.js — загружает .env и экспортирует все настройки
 * Все остальные модули делают: const cfg = require('./config')
 */

const path = require('path');
const fs   = require('fs');

// Ищем .env в нескольких местах
const envCandidates = [
  path.join(process.cwd(), '.env'),
  path.join(__dirname, '.env'),
  path.join(__dirname, '..', '.env'),
  path.join(process.env.HOME || '', '.env'),
];

let envLoaded = false;
for (const p of envCandidates) {
  if (fs.existsSync(p)) {
    require('dotenv').config({ path: p });
    console.log(`✅ Конфиг загружен: ${p}`);
    envLoaded = true;
    break;
  }
}
if (!envLoaded) {
  console.warn('⚠️  .env не найден — используйте cp .env.template .env');
}

const get     = (k, def = '')  => process.env[k] || def;
const getInt  = (k, def = 0)   => parseInt(process.env[k] || def, 10);
const getList = (k, def = [])  =>
  process.env[k] ? process.env[k].split(',').map(s => s.trim()) : def;

module.exports = {
  // ── Telegram ──────────────────────────────
  TELEGRAM_TOKEN:   get('TELEGRAM_TOKEN'),
  ALLOWED_USER_ID:  getInt('ALLOWED_USER_ID', 0),
  MY_EMAIL:         get('MY_EMAIL', ''),
  MY_NAME:          get('MY_NAME', ''),

  // ── LLM ───────────────────────────────────
  ANTHROPIC_KEY:    get('ANTHROPIC_KEY'),
  GROK_KEY:         get('GROK_KEY'),
  GROQ_KEY:         get('GROQ_KEY'),

  // ── Grok STT ──────────────────────────────
  GROK_STT_URL:     'https://api.x.ai/v1/stt',
  GROK_CHAT_URL:    'https://api.x.ai/v1/chat/completions',
  GROK_CHAT_MODEL:  get('GROK_CHAT_MODEL', 'grok-3-turbo'),
  GROK_LANGUAGE:    get('GROK_LANGUAGE', 'ru'),

  // ── Groq ──────────────────────────────────
  GROQ_CHAT_URL:    'https://api.groq.com/openai/v1/chat/completions',
  GROQ_MODEL:       get('GROQ_MODEL', 'llama-3.1-8b-instant'),

  // ── Auchan корпоративный LLM ────────────────
  AUCHAN_LLM_URL: get('AUCHAN_LLM_URL', 'https://api-uat.ru.auchan.com/rus/llm/v1'),
  AUCHAN_API_KEY: get('AUCHAN_API_KEY', ''),
  AUCHAN_BEARER:  get('AUCHAN_BEARER',  ''),

  // ── Auchan Qwen эмбеддинги и реранк ──────────
  // Эндпоинт для эмбеддингов (если Ашан даёт /embeddings)
  AUCHAN_EMBEDDING_URL:   get('AUCHAN_EMBEDDING_URL',   ''),
  AUCHAN_EMBEDDING_MODEL: get('AUCHAN_EMBEDDING_MODEL', 'qwen3-embedding'),
  // Эндпоинт для реранка (если Ашан даёт /rerank)
  AUCHAN_RERANK_URL:      get('AUCHAN_RERANK_URL',      ''),
  AUCHAN_RERANK_MODEL:    get('AUCHAN_RERANK_MODEL',    'qwen3-reranker'),

  // ── Модели ────────────────────────────────
  DEFAULT_MODEL:    get('DEFAULT_MODEL', 'haiku'),
  AVAILABLE_MODELS: {
    haiku:  { name: 'Claude Haiku',         provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    llama:  { name: 'Llama 3.1 8B Instant', provider: 'groq',      model: get('GROQ_MODEL', 'llama-3.1-8b-instant') },
    auchan: { name: 'Auchan LLM (Corp)',     provider: 'auchan',    model: 'auchan-llm' },
  },

  // ── Яндекс ────────────────────────────────
  YANDEX_LOGIN:     get('YANDEX_LOGIN'),
  YANDEX_PASSWORD:  get('YANDEX_PASSWORD'),
  YANDEX_DISK_TOKEN: get('YANDEX_DISK_TOKEN'),
  YANDEX_BOT_TOKEN: get('YANDEX_BOT_TOKEN'),

  // ── Пути ──────────────────────────────────
  VAULT_PATH:       get('VAULT_PATH', './ObsidianVault'),
  PLAUD_FOLDER:     get('PLAUD_TXT_FOLDER', './plaud_transcripts'),
  MESSENGER_EXPORT: get('YANDEX_MESSENGER_EXPORT', './messenger_export'),
  DISK_FOLDER:      get('YANDEX_DISK_FOLDER', './yandex_disk_files'),

  // ── Настройки бота ────────────────────────
  ALERT_KEYWORDS:   getList('ALERT_KEYWORDS', ['urgent','срочно','invoice','счёт','deadline','дедлайн']),
  DIGEST_WEEKDAY:   getInt('DIGEST_WEEKDAY', 1),   // 1=понедельник (cron)
  DIGEST_HOUR:      getInt('DIGEST_HOUR', 7),
  SYNC_EVERY_HOURS: getInt('SYNC_EVERY_HOURS', 1),

  // ── Яндекс Диск API ───────────────────────
  DISK_API:         'https://cloud-api.yandex.net/v1/disk',
  DISK_ROOT:        get('DISK_ROOT_FOLDER', '/'),
  MAX_FILE_MB:      getInt('MAX_FILE_SIZE_MB', 10),

  // ── Confluence ───────────────────────────────────
  CONFLUENCE_URL:      get('CONFLUENCE_URL',      'https://doc.ru.auchan.com'),
  CONFLUENCE_USER:     get('CONFLUENCE_USER',     ''),
  CONFLUENCE_PASSWORD: get('CONFLUENCE_PASSWORD',  ''),
  CONFLUENCE_SPACE:    get('CONFLUENCE_SPACE',    'BD'),

  // ── JIRA ──────────────────────────────────────────
  JIRA_URL:         get('JIRA_URL',         'https://task.ru.auchan.com'),
  JIRA_USER:        get('JIRA_USER',        ''),
  JIRA_PASSWORD:    get('JIRA_PASSWORD',    ''),
  JIRA_PROJECT:     get('JIRA_PROJECT',     'BITASK'),

  // ── Состояние ─────────────────────────────
  STATE_FILE:       get('STATE_FILE', '.vault_state.json'),
};
