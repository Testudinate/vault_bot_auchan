'use strict';
/**
 * bot.js — Telegram бот v2 (Node.js)
 *
 * Запуск: node bot.js
 */

// SSL фикс для macOS Python 3.9 / старых сертификатов
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.NODE_EXTRA_CA_CERTS = '';

const fs        = require('fs-extra');
const path      = require('path');
const https     = require('https');
const FormData  = require('form-data');
const axios     = require('axios');
const cron      = require('node-cron');
const winston   = require('winston');
const TelegramBot = require('node-telegram-bot-api');
const Anthropic   = require('@anthropic-ai/sdk');

const cfg     = require('./config');
const { getConfluence, getJIRA, createConfluencePage, parseWorklog } = require('./integrations');
const { VaultIndex, parseTimeExpression, embeddingSearch } = require('./indexer');
const { syncAll, syncDisk }              = require('./syncer');

// ──────────────────────────────────────────────
//  ЛОГИРОВАНИЕ
// ──────────────────────────────────────────────

const log = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) =>
      `${timestamp} [${level.toUpperCase()}] ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'vault_bot.log', maxsize: 10*1024*1024, maxFiles: 3 }),
  ],
});

// ──────────────────────────────────────────────
//  СОСТОЯНИЕ
// ──────────────────────────────────────────────

const STATE_FILE = cfg.STATE_FILE;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (_) { return {}; }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

const STATE = loadState();
STATE.filters      = STATE.filters      || {};
STATE.dialogs      = STATE.dialogs      || {};
STATE.favorites    = STATE.favorites    || {};
STATE.tasks        = STATE.tasks        || {};
STATE.activeModel  = STATE.activeModel  || {};
STATE.tokenStats   = STATE.tokenStats   || {};

function getFilter(uid)  { return STATE.filters[uid]     || { folders: [], types: [] }; }
function setFilter(uid, key, val) {
  STATE.filters[uid] = STATE.filters[uid] || { folders: [], types: [] };
  STATE.filters[uid][key] = val;
  saveState(STATE);
}
function getDialog(uid)  { return STATE.dialogs[uid]     || []; }
function addToDialog(uid, role, content) {
  STATE.dialogs[uid] = STATE.dialogs[uid] || [];
  STATE.dialogs[uid].push({ role, content: content.slice(0, 2000) });
  STATE.dialogs[uid] = STATE.dialogs[uid].slice(-10);
  saveState(STATE);
}
function clearDialog(uid) { STATE.dialogs[uid] = []; saveState(STATE); }
function getFavorites(uid) { return STATE.favorites[uid] || []; }
function addFavorite(uid, doc) {
  STATE.favorites[uid] = STATE.favorites[uid] || [];
  const entry = { title: doc.title, path: doc.path, date: doc.date, savedAt: new Date().toISOString().slice(0,16) };
  if (!STATE.favorites[uid].some(f => f.path === entry.path))
    STATE.favorites[uid].push(entry);
  saveState(STATE);
}
function getTasks(uid) { return STATE.tasks[uid] || []; }
function saveTasks(uid, tasks) { STATE.tasks[uid] = tasks; saveState(STATE); }
function getModelKey(uid) { return STATE.activeModel[uid] || cfg.DEFAULT_MODEL; }
function setModelKey(uid, key) { STATE.activeModel[uid] = key; saveState(STATE); }
function addTokens(uid, modelKey, tokIn, tokOut) {
  STATE.tokenStats[uid] = STATE.tokenStats[uid] || {};
  STATE.tokenStats[uid][modelKey] = STATE.tokenStats[uid][modelKey] || { in: 0, out: 0, requests: 0 };
  STATE.tokenStats[uid][modelKey].in       += tokIn;
  STATE.tokenStats[uid][modelKey].out      += tokOut;
  STATE.tokenStats[uid][modelKey].requests += 1;
  saveState(STATE);
}

// ──────────────────────────────────────────────
//  ГЛОБАЛЬНЫЕ ОБЪЕКТЫ
// ──────────────────────────────────────────────

let vaultIndex = new VaultIndex(cfg.VAULT_PATH);
const anthropic = new Anthropic({ apiKey: cfg.ANTHROPIC_KEY });

function checkAccess(uid) {
  return cfg.ALLOWED_USER_ID === 0 || uid === cfg.ALLOWED_USER_ID;
}

// ──────────────────────────────────────────────
//  LLM — УНИВЕРСАЛЬНЫЙ ВЫЗОВ
// ──────────────────────────────────────────────


// Auchan LLM с retry логикой (аналог Python скрипта)
async function callAuchan(messages, { maxTokens = 150, temperature = 0.7, maxRetries = 3, retryDelay = 2000 } = {}) {
  if (!cfg.AUCHAN_BEARER) throw new Error('AUCHAN_BEARER не задан в .env');

  const auchanAgent = new (require('https').Agent)({ rejectUnauthorized: false });
  const payload = {
    messages,
    max_tokens:  maxTokens,
    temperature,
    stream:      false,
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log.info(`Auchan: попытка ${attempt}/${maxRetries}...`);
      const { data } = await axios.post(cfg.AUCHAN_LLM_URL, payload, {
        headers: {
          'X-Gravitee-Api-Key': cfg.AUCHAN_API_KEY,
          'Authorization':      `Bearer ${cfg.AUCHAN_BEARER}`,
          'Content-Type':       'application/json',
        },
        httpsAgent: auchanAgent,
        timeout:    120000,  // 120с read timeout как в Python
      });

      // Успех
      const text = data.choices?.[0]?.message?.content ||
                   data.content || data.message || data.response ||
                   (typeof data === 'string' ? data : JSON.stringify(data).slice(0, 500));
      log.info(`Auchan: ✅ успех (попытка ${attempt})`);
      return { text, usage: data.usage || {} };

    } catch (e) {
      const status = e.response?.status;
      const body   = e.response?.data;

      // 504 Gateway Timeout — повторяем
      if (status === 504) {
        log.warn(`Auchan: 504 Gateway Timeout, повтор через ${retryDelay/1000}с...`);
        await new Promise(r => setTimeout(r, retryDelay));
        continue;
      }

      // 5xx ошибки сервера — повторяем
      if (status >= 500) {
        log.warn(`Auchan: ошибка сервера ${status}, повтор через ${retryDelay/1000}с...`);
        await new Promise(r => setTimeout(r, retryDelay));
        continue;
      }

      // Таймаут — повторяем
      if (e.code === 'ECONNABORTED' || e.message.includes('timeout')) {
        log.warn(`Auchan: таймаут запроса, повтор через ${retryDelay/1000}с...`);
        await new Promise(r => setTimeout(r, retryDelay));
        continue;
      }

      // Клиентские ошибки 4xx — не повторяем
      if (status >= 400 && status < 500) {
        const desc = body?.error?.message || body?.message || e.message;
        throw new Error(`Auchan API ошибка ${status}: ${desc}`);
      }

      // Сетевые ошибки — повторяем
      if (['ECONNRESET','ENOTFOUND','EHOSTUNREACH','ETIMEDOUT'].some(c => e.code === c)) {
        log.warn(`Auchan: сетевая ошибка ${e.code}, повтор...`);
        await new Promise(r => setTimeout(r, retryDelay));
        continue;
      }

      throw e;
    }
  }
  throw new Error('Auchan LLM: исчерпаны все попытки');
}

async function callLLM(messages, { system = '', maxTokens = 800, uid = 0 } = {}) {
  const modelKey = getModelKey(uid);
  const modelCfg = cfg.AVAILABLE_MODELS[modelKey] || cfg.AVAILABLE_MODELS[cfg.DEFAULT_MODEL];

  let text = '', tokIn = 0, tokOut = 0;

  if (modelCfg.provider === 'anthropic') {
    const resp = await anthropic.messages.create({
      model:      modelCfg.model,
      max_tokens: maxTokens,
      system,
      messages,
    });
    text   = resp.content[0].text;
    tokIn  = resp.usage.input_tokens;
    tokOut = resp.usage.output_tokens;

  } else if (modelCfg.provider === 'groq') {
    if (!cfg.GROQ_KEY) throw new Error('Укажите GROQ_KEY в .env');
    const groqMessages = system
      ? [{ role: 'system', content: system }, ...messages]
      : messages;
    const { data } = await axios.post(cfg.GROQ_CHAT_URL, {
      model:      modelCfg.model,
      messages:   groqMessages,
      max_tokens: maxTokens,
    }, { headers: { Authorization: `Bearer ${cfg.GROQ_KEY}` } });
    text   = data.choices[0].message.content;
    tokIn  = data.usage?.prompt_tokens     || 0;
    tokOut = data.usage?.completion_tokens || 0;

  } else if (modelCfg.provider === 'auchan') {
    if (!cfg.AUCHAN_BEARER) throw new Error('Укажите AUCHAN_BEARER в .env');
    const auchanMsgs = system
      ? [{ role: 'system', content: system }, ...messages]
      : messages;
    const agent = new (require('https').Agent)({ rejectUnauthorized: false });
    const { data } = await axios.post(cfg.AUCHAN_LLM_URL, {
      messages: auchanMsgs,
    }, {
       headers: {
         'X-Gravitee-Api-Key': cfg.AUCHAN_API_KEY,
         'Authorization':      `Bearer ${cfg.AUCHAN_BEARER}`,
         'Content-Type':       'application/json',
       },
      httpsAgent: agent,
      timeout:    30000,
    });
    text   = data.choices?.[0]?.message?.content ||
             data.content || data.message || data.response ||
             JSON.stringify(data).slice(0, 500);
    tokIn  = data.usage?.prompt_tokens     || 0;
    tokOut = data.usage?.completion_tokens || 0;
  }

  addTokens(uid, modelKey, tokIn, tokOut);
  log.info(`LLM [${modelKey}] in=${tokIn} out=${tokOut}`);
  return text;
}

// ──────────────────────────────────────────────
//  RAG
// ──────────────────────────────────────────────

function formatContext(docs, maxChars = 4000) {
  let out = '', total = 0;
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    const chunk = `[${i+1}] ${d.title} (${d.type}, ${d.date || ''})\nОт: ${d.from || ''}\nПапка: ${d.folder || ''}\n${(d.body || '').slice(0, 500)}\n`;
    if (total + chunk.length > maxChars) break;
    out += chunk + '\n---\n';
    total += chunk.length;
  }
  return out || 'Документы не найдены.';
}


// Определение языка сообщения
function detectLanguage(text) {
  const cyrillicCount = (text.match(/[а-яёА-ЯЁ]/g) || []).length;
  const latinCount    = (text.match(/[a-zA-Z]/g) || []).length;
  const total         = cyrillicCount + latinCount;
  if (total === 0) return 'ru';
  const cyrillicRatio = cyrillicCount / total;
  if (cyrillicRatio > 0.5) return 'ru';
  if (cyrillicRatio < 0.2) return 'en';
  return 'mixed'; // смешанный — отвечаем на русском
}

// Системный промпт с учётом языка
function getSystemPrompt(lang) {
  if (lang === 'en') {
    return 'You are a personal AI assistant. Answer in English, concisely and specifically. ' +
           'Use information from the provided documents from the knowledge base.';
  }
  return 'Ты личный ИИ-ассистент. Отвечай на русском, конкретно и кратко. ' +
         'Используй информацию из предоставленных документов базы знаний.';
}

async function ragAsk(question, { uid = 0, docType = null, folders = null } = {}) {
  const { dateFrom, dateTo, cleaned } = parseTimeExpression(question);

  // Переформулировка
  let queries = [cleaned];
  try {
    const r = await callLLM(
      [{ role: 'user', content: `2 альтернативных формулировки (по строке):\n${cleaned}` }],
      { maxTokens: 100, uid }
    );
    queries = [cleaned, ...r.trim().split('\n').filter(Boolean).slice(0, 2)];
  } catch (_) {}

  // Объединяем результаты
  const allDocs = [], seen = new Set();
  for (const q of queries) {
    // Используем гибридный поиск (BM25 + Chroma embeddings + RRF)
    const results = await vaultIndex.searchHybrid(q, { topK: 4, docType, folders, dateFrom, dateTo });
    for (const doc of results) {
      if (!seen.has(doc.id)) { seen.add(doc.id); allDocs.push(doc); }
    }
  }

  const context  = formatContext(allDocs.slice(0, 6));
  const history  = getDialog(uid);
  const dateNote = dateFrom ? `\n[Период: ${dateFrom.toLocaleDateString('ru')} — ${(dateTo||new Date()).toLocaleDateString('ru')}]` : '';

  const answer = await callLLM(
    [...history, { role: 'user', content: `Вопрос: ${question}${dateNote}\n\nДокументы:\n${context}` }],
    {
      system:    getSystemPrompt(detectLanguage(question)),
      maxTokens: 800,
      uid,
    }
  );

  addToDialog(uid, 'user', question);
  addToDialog(uid, 'assistant', answer);
  return answer;
}

async function extractTasks(uid = 0) {
  const docs = ['email','messenger_chat','voice_transcript']
    .flatMap(t => vaultIndex.getRecent(t, 30));
  if (!docs.length) return 'Документов не найдено.';
  return callLLM(
    [{ role: 'user', content:
      `Задачи, дедлайны, договорённости:\n${formatContext(docs.slice(0,12))}\n\n` +
      '📋 ЗАДАЧИ:\n- [ ] задача | источник | срок\n⏰ ДЕДЛАЙНЫ:\n- дедлайн | дата\n🤝 ДОГОВОРЁННОСТИ:\n- с кем | о чём' }],
    { maxTokens: 1000, uid }
  );
}

async function summarize(docType, uid = 0) {
  const docs = vaultIndex.getRecent(docType, 7);
  if (!docs.length) return 'Нет документов за последние 7 дней.';
  return callLLM(
    [{ role: 'user', content:
      `Саммари за неделю:\n${formatContext(docs.slice(0,10))}\n\n1. Главные темы\n2. Решения\n3. Задачи\n4. Контакты` }],
    { maxTokens: 800, uid }
  );
}

async function proactiveInsights(uid = 0) {
  const insights = [];
  const contacts = vaultIndex.getTopContacts(10);
  const recent3  = vaultIndex.getRecent(null, 3);
  const recentFrom = new Set(recent3.map(d => (d.from||'').toLowerCase()));

  // Давно не общались
  const silent = [];
  for (const { name, email, count } of contacts) {
    if (count < 3 || recentFrom.has(email.toLowerCase())) continue;
    const docs = vaultIndex.searchByPerson(name);
    if (!docs.length) continue;
    const lastDate = docs[0].date;
    if (!lastDate) continue;
    const daysAgo = Math.floor((Date.now() - new Date(lastDate)) / 86400000);
    if (daysAgo > 14) silent.push(`• ${name} — ${daysAgo} дней назад`);
  }
  if (silent.length) insights.push(`😶 Давно не общались:\n${silent.slice(0,5).join('\n')}`);

  // Горячие темы
  const week = vaultIndex.getRecent(null, 7);
  const topics = {};
  for (const doc of week) {
    for (const w of (doc.subject||'').toLowerCase().match(/[а-яa-z]{5,}/g) || [])
      topics[w] = (topics[w]||0) + 1;
  }
  const hot = Object.entries(topics).filter(([,c]) => c >= 3).sort((a,b)=>b[1]-a[1]).slice(0,5);
  if (hot.length) insights.push(`🔥 Горячие темы:\n• ${hot.map(([w]) => w).join('\n• ')}`);

  if (!insights.length) return '✅ Всё спокойно. Новых инсайтов нет.';
  return '💡 Проактивные инсайты:\n\n' + insights.join('\n\n');
}

async function weeklyDigest(uid = 0) {
  const sections = [];
  for (const [dtype, label] of [['email','📧 Почта'],['messenger_chat','💬 Мессенджер'],['voice_transcript','🎙️ Голосовые']]) {
    const docs = vaultIndex.getRecent(dtype, 7);
    if (!docs.length) continue;
    const text = await callLLM(
      [{ role: 'user', content: `3-5 пунктов о главном из ${label}:\n${formatContext(docs.slice(0,8), 1500)}` }],
      { maxTokens: 300 }
    );
    sections.push(`${label}\n${text}`);
  }
  sections.push(`📋 Задачи\n${await extractTasks()}`);
  sections.push(await proactiveInsights());
  return `🗓 Дайджест (${new Date().toLocaleDateString('ru')})\n\n${sections.join('\n\n')}`;
}

// ──────────────────────────────────────────────
//  GROK STT
// ──────────────────────────────────────────────

async function grokSTT(audioPath) {
  if (!cfg.GROK_KEY) throw new Error('Укажите GROK_KEY в .env');

  const agent = new https.Agent({ rejectUnauthorized: false });

  // Пробуем разные MIME типы если 400
  const mimeAttempts = ['audio/mpeg', 'audio/ogg', 'audio/wav'];
  let lastError = null;

  for (const mime of mimeAttempts) {
    try {
      const form = new FormData();
      form.append('file', fs.createReadStream(audioPath), {
        filename:    path.basename(audioPath).replace(/\.[^.]+$/, '.mp3'),
        contentType: mime,
      });
      form.append('model',    'grok-stt');
      form.append('language', cfg.GROK_LANGUAGE);

      const resp = await axios.post(cfg.GROK_STT_URL, form, {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${cfg.GROK_KEY}` },
        timeout: 60000,
        httpsAgent: agent,
      });

      const text = resp.data.text || resp.data.segments?.map(s => s.text).join(' ') || '';
      log.info(`STT: успех с mime=${mime}, текст: ${text.slice(0,50)}`);
      return text;

    } catch (e) {
      lastError = e;
      const status = e.response?.status;
      log.warn(`STT: ошибка ${status} с mime=${mime}`);
      if (status !== 400) throw e;  // не 400 — не пробуем дальше
    }
  }

  throw new Error(`Grok STT не принял файл: ${lastError?.response?.data?.error || lastError?.message}`);
}

async function convertToMp3(inputPath) {
  const { execFile } = require('child_process');
  const outputPath   = inputPath.replace(/\.[^.]+$/, '.mp3');
  const ffmpeg       = ['/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', 'ffmpeg']
    .find(p => { try { require('fs').accessSync(p); return true; } catch (_) { return false; } });

  return new Promise((resolve) => {
    execFile(ffmpeg || 'ffmpeg', ['-i', inputPath, '-ar', '16000', '-ac', '1', '-q:a', '2', outputPath, '-y'],
      (err) => resolve(err ? inputPath : outputPath));
  });
}

// ──────────────────────────────────────────────
//  КЛАВИАТУРА ПАПОК
// ──────────────────────────────────────────────

function buildFolderKeyboard(activeFolders, activeTypes, page = 0) {
  const PAGE   = 8;
  const TYPES  = { '📧 Почта': 'email', '💬 Мессенджер': 'messenger_chat', '🎙️ Plaud': 'voice_transcript', '💾 Диск': 'disk_file' };
  const keyboard = [];

  // Источники (по 2 в ряд)
  const typeRows = Object.entries(TYPES);
  for (let i = 0; i < typeRows.length; i += 2) {
    keyboard.push(typeRows.slice(i, i+2).map(([label, dtype]) => ({
      text:          `${activeTypes.includes(dtype) ? '✅' : '☐'} ${label}`,
      callback_data: `filter_type_${dtype}`,
    })));
  }

  keyboard.push([{ text: '── Папки почты ──', callback_data: 'noop' }]);

  const allFolders = vaultIndex.getFolders()['📧 Почта'] || [];
  const total      = Math.max(1, Math.ceil(allFolders.length / PAGE));
  const pg         = Math.max(0, Math.min(page, total - 1));
  const pageItems  = allFolders.slice(pg * PAGE, (pg + 1) * PAGE);

  for (let i = 0; i < pageItems.length; i += 2) {
    keyboard.push(pageItems.slice(i, i+2).map(f => ({
      text:          `${activeFolders.includes(f) ? '✅' : '☐'} ${f.slice(0,16)}${f.length>16?'…':''}`,
      callback_data: `ff_${f.slice(0,35)}`,
    })));
  }

  const nav = [];
  if (pg > 0)       nav.push({ text: '◀', callback_data: `fpage_${pg-1}` });
  nav.push({ text: `${pg+1}/${total}`, callback_data: 'noop' });
  if (pg < total-1) nav.push({ text: '▶', callback_data: `fpage_${pg+1}` });
  if (nav.length)   keyboard.push(nav);

  keyboard.push([
    { text: '✅ Все папки', callback_data: 'filter_all'   },
    { text: '🔄 Сбросить',  callback_data: 'filter_reset' },
  ]);

  const inv = Object.fromEntries(Object.entries(TYPES).map(([k,v]) => [v,k]));
  let status = '🔍 Где искать?\n\n';
  if (!activeFolders.length && !activeTypes.length) {
    status += 'Везде\n';
  } else {
    if (activeTypes.length)  status += 'Источники: ' + activeTypes.map(t => inv[t]||t).join(', ') + '\n';
    if (activeFolders.length) {
      const shown = activeFolders.slice(0,4).join(', ');
      const extra = activeFolders.length > 4 ? ` +${activeFolders.length-4}` : '';
      status += `Папки (${activeFolders.length}): ${shown}${extra}\n`;
    }
  }
  status += '\nНажмите папку чтобы включить/выключить:';

  return { keyboard, status };
}

// ──────────────────────────────────────────────
//  БОТ
// ──────────────────────────────────────────────

// Кастомный https агент с TLSv1.2 (совместимость с macOS)
const botHttpsAgent = new (require('https').Agent)({
  rejectUnauthorized: false,
  keepAlive:          false,
  timeout:            30000,
  secureProtocol:     'TLSv1_2_method',
});

const bot = new TelegramBot(cfg.TELEGRAM_TOKEN, {
  polling: {
    interval:  3000,
    autoStart: true,
    params:    { timeout: 10 },
  },
  request: {
    agentClass:   require('https').Agent,
    agentOptions: {
      rejectUnauthorized: false,
      keepAlive:          false,
      secureProtocol:     'TLSv1_2_method',
    },
    agent: botHttpsAgent,
  },
});

// Хелпер отправки
const send  = (cid, text, opts = {}) => bot.sendMessage(cid, text, opts);
const reply = (msg, text, opts = {}) => bot.sendMessage(msg.chat.id, text, opts);
const edit  = async (cid, mid, text, opts = {}) => {
  try {
    return await bot.editMessageText(text, { chat_id: cid, message_id: mid, ...opts });
  } catch (e) {
    if (e.message?.includes('message is not modified')) return; // игнорируем
    throw e;
  }
};

function inlineKb(rows) {
  return { reply_markup: { inline_keyboard: rows } };
}

// ══════════════════════════════════════════════
//  🔐 ИБ МОДУЛЬ — Information Security
// ══════════════════════════════════════════════

// Ключевые слова для ИБ мониторинга
const SECURITY_KEYWORDS = [
  // Инциденты
  'инцидент','incident','взлом','breach','утечка','leak','атака','attack',
  'уязвимость','vulnerability','exploit','malware','фишинг','phishing',
  // Доступы
  'доступ','access','пароль','password','токен','token','ключ','secret',
  'авторизация','authorization','аутентификация','authentication',
  '2fa','mfa','vpn','firewall','брандмауэр',
  // Персональные данные
  'персданные','персональные данные','gdpr','152-фз','конфиденциально',
  'confidential','секретно','classified',
  // Технические
  'sql injection','xss','csrf','ddos','rootkit','ransomware','троян',
];

// PII паттерны
const PII_PATTERNS = [
  { name: 'Банковская карта',  re: /\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}/g },
  { name: 'Телефон РФ',       re: /(\+7|8)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/g },
  { name: 'Email',            re: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g },
  { name: 'СНИЛС',            re: /\d{3}\-\d{3}\-\d{3}\s?\d{2}/g },
  { name: 'ИНН',              re: /\d{10,12}/g },
  { name: 'Паспорт РФ',       re: /\d{4}\s?\d{6}/g },
  { name: 'IP адрес',         re: /(?:\d{1,3}\.){3}\d{1,3}/g },
];

// Уровни конфиденциальности
const CONFIDENTIALITY_LEVELS = {
  SECRET:       { label: '🔴 СЕКРЕТНО',       score: 4 },
  CONFIDENTIAL: { label: '🟠 КОНФИДЕНЦИАЛЬНО', score: 3 },
  INTERNAL:     { label: '🟡 ВНУТРЕННЕЕ',      score: 2 },
  PUBLIC:       { label: '🟢 ОТКРЫТОЕ',        score: 1 },
};

// Аудит лог запросов
const AUDIT_FILE = './vault_audit.log';
function auditLog(uid, action, detail = '') {
  const line = JSON.stringify({
    ts:     new Date().toISOString(),
    uid,
    action,
    detail: detail.slice(0, 200),
  }) + '\n';
  try { require('fs').appendFileSync(AUDIT_FILE, line); } catch (_) {}
}

// Классификатор конфиденциальности документа
async function classifyDoc(doc, uid = 0) {
  const text = `${doc.title} ${doc.body?.slice(0, 1000) || ''}`;

  // Быстрая эвристика по ключевым словам
  const textLower = text.toLowerCase();
  let score = 0;
  if (/секретно|top secret|строго конфиденциально/i.test(textLower))  score = 4;
  else if (/конфиденциально|confidential|не для распространения/i.test(textLower)) score = 3;
  else if (/внутреннее|internal|только для сотрудников/i.test(textLower)) score = 2;
  else score = 1;

  // Повышаем если есть PII
  for (const { re } of PII_PATTERNS) {
    if (re.test(text)) { score = Math.min(score + 1, 4); break; }
  }

  const level = Object.entries(CONFIDENTIALITY_LEVELS)
    .find(([, v]) => v.score === score);
  return level ? level[1].label : '🟢 ОТКРЫТОЕ';
}

// Поиск PII в документах
function findPII(text) {
  const found = [];
  for (const { name, re } of PII_PATTERNS) {
    re.lastIndex = 0;
    const matches = text.match(re);
    if (matches) {
      // Маскируем найденное
      const masked = matches.slice(0, 3).map(m =>
        m.slice(0, 4) + '*'.repeat(Math.max(0, m.length - 6)) + m.slice(-2)
      );
      found.push({ type: name, count: matches.length, examples: masked });
    }
  }
  return found;
}

// ИБ дайджест
async function securityDigest(uid = 0) {
  const lines = ['🔐 ИБ Дайджест\n'];

  // 1. Письма с ИБ ключевыми словами за последние 7 дней
  const recentEmails = vaultIndex.getRecent('email', 7);
  const secEmails = recentEmails.filter(d => {
    const text = `${d.subject || ''} ${d.body?.slice(0, 500) || ''}`.toLowerCase();
    return SECURITY_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
  });

  if (secEmails.length) {
    lines.push(`📧 Письма с ИБ тематикой (${secEmails.length}):`);
    for (const d of secEmails.slice(0, 5)) {
      lines.push(`   • ${d.date}  ${(d.subject || '').slice(0, 50)}`);
      lines.push(`     От: ${(d.from || '').slice(0, 40)}`);
    }
    lines.push('');
  } else {
    lines.push('📧 Писем с ИБ тематикой за неделю нет\n');

  }

  // 2. Документы с PII на диске
  const diskDocs = vaultIndex.docs
    .filter(d => d.type === 'disk_file')
    .slice(0, 50); // первые 50 для скорости

  const piiDocs = [];
  for (const d of diskDocs) {
    const found = findPII(d.body || '');
    if (found.length) piiDocs.push({ doc: d, pii: found });
  }

  if (piiDocs.length) {
    lines.push(`⚠️  Документы с персданными (${piiDocs.length}):`);
    for (const { doc, pii } of piiDocs.slice(0, 5)) {
      lines.push(`   📄 ${(doc.title || '').slice(0, 45)}`);
      lines.push(`      ${pii.map(p => `${p.type}: ${p.count} шт`).join(', ')}`);
    }
    lines.push('');
  }

  // 3. Топ контактов за неделю
  const senders = new Map();
  for (const d of recentEmails) {
    if (!d.from) continue;
    const m     = d.from.match(/<(.+?)>/);
    const email = m ? m[1] : d.from;
    senders.set(email, (senders.get(email) || 0) + 1);
  }
  if (senders.size) {
    lines.push('👤 Активные отправители (7 дней):');
    [...senders.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .forEach(([email, cnt]) => lines.push(`   ${email.slice(0, 40)}  —  ${cnt} писем`));
    lines.push('');
  }

  // 4. Статистика доступов из аудит лога
  try {
    const fs       = require('fs');
    const auditRaw = fs.existsSync(AUDIT_FILE)
      ? fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean)

      : [];
    const last24   = auditRaw
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(e => e && new Date(e.ts) > new Date(Date.now() - 86400000));
    if (last24.length) {
      const actions = {};
      for (const e of last24) actions[e.action] = (actions[e.action] || 0) + 1;
      lines.push(`📋 Активность за 24ч (${last24.length} запросов):`);
      Object.entries(actions).sort((a,b) => b[1]-a[1]).slice(0,5)
        .forEach(([a, n]) => lines.push(`   ${a}: ${n}`));
    }
  } catch (_) {}

  return lines.join('\n');

}

// Сканирование PII в документах
async function scanPII(uid = 0) {
  const results = [];
  const docs = vaultIndex.docs.filter(d =>
    ['disk_file','email'].includes(d.type)
  );

  for (const d of docs) {
    const found = findPII(d.body || '');
    if (found.length) results.push({ doc: d, pii: found });
  }

  if (!results.length) return '✅ PII не обнаружено в проиндексированных документах.';

  const lines = [`⚠️  Найдено PII в ${results.length} документах:
`];
  for (const { doc, pii } of results.slice(0, 15)) {
    const level = await classifyDoc(doc, uid);
    lines.push(`${level}`);
    lines.push(`📄 ${(doc.title || '').slice(0, 50)}`);
    lines.push(`   Тип: ${doc.type}  📅 ${doc.date}`);
    for (const p of pii)
      lines.push(`   • ${p.type}: ${p.count} шт — ${p.examples.join(', ')}`);
    lines.push('');
  }

  if (results.length > 15)
    lines.push(`...и ещё ${results.length - 15} документов`);

  return lines.join('\n');

}

// Детектор аномалий — проверка попыток доступа
async function checkAnomalies() {
  if (!cfg.ALLOWED_USER_ID) return;
  try {
    const fs       = require('fs');
    const auditRaw = fs.existsSync(AUDIT_FILE)
      ? fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean)

      : [];
    const recent = auditRaw
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(e => e && new Date(e.ts) > new Date(Date.now() - 3600000));

    // Чужие uid
    const foreignUids = [...new Set(
      recent
        .filter(e => e.uid !== cfg.ALLOWED_USER_ID && e.uid !== 0)
        .map(e => e.uid)
    )];

    if (foreignUids.length) {
      const alert = `🚨 АНОМАЛИЯ!

Попытка доступа от неизвестных пользователей:
${foreignUids.map(u => `• uid: ${u}`).join('\n')}


Проверьте аудит лог: ${AUDIT_FILE}`;
      await send(cfg.ALLOWED_USER_ID, alert);
      log.warn(`Security: foreign access attempt from ${foreignUids.join(', ')}`);
    }
  } catch (_) {}
}

// ══════════════════════════════════════════════
//  🔑 ПРОВЕРКА ТОКЕНОВ
// ══════════════════════════════════════════════

async function checkAllTokens(botInstance) {
  const results = [];
  const ax = require('axios');
  const agent = new (require('https').Agent)({ rejectUnauthorized: false });

  const check = async (name, emoji, fn) => {
    const start = Date.now();
    try {
      const info = await fn();
      results.push({ name, emoji, ok: true, info, ms: Date.now() - start });
    } catch (e) {
      const msg = e.response?.data?.description ||
                  e.response?.data?.error?.message ||
                  e.response?.data?.message ||
                  e.message || 'Ошибка';
      results.push({ name, emoji, ok: false, info: msg.slice(0, 100), ms: Date.now() - start });
    }
  };

  // ── 1. Telegram — отправить тестовое сообщение ──
  await check('Telegram Bot', '🤖', async () => {
    const { data } = await ax.get(
      `https://api.telegram.org/bot${cfg.TELEGRAM_TOKEN}/getMe`,
      { httpsAgent: agent, timeout: 10000 }
    );
    const me = data.result;
    // Отправляем тестовое сообщение самому себе
    if (cfg.ALLOWED_USER_ID) {
      await ax.post(
        `https://api.telegram.org/bot${cfg.TELEGRAM_TOKEN}/sendMessage`,
        { chat_id: cfg.ALLOWED_USER_ID, text: '🔑 Тест токена Telegram: OK ✅' },
        { httpsAgent: agent, timeout: 10000 }
      );
    }
    return `@${me.username} (id: ${me.id}) — тест отправлен`;
  });

  // ── 2. Anthropic Claude — тестовый запрос ──
  await check('Anthropic Claude', '🧠', async () => {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: cfg.ANTHROPIC_KEY });
    const resp   = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'Ответь одним словом: работает' }],
    });
    const answer = resp.content[0].text.trim();
    return `claude-haiku ✅ | Ответ: "${answer}" | in=${resp.usage.input_tokens}`;
  });

  // ── 3. Grok xAI — тестовый chat запрос ──
  await check('Grok xAI (STT)', '⚡', async () => {
    if (!cfg.GROK_KEY) throw new Error('GROK_KEY не задан в .env');
    const { data } = await ax.post('https://api.x.ai/v1/chat/completions', {
      model:     'grok-3-turbo',
      messages:  [{ role: 'user', content: 'ping' }],
      max_tokens: 5,
    }, {
      headers: { Authorization: `Bearer ${cfg.GROK_KEY}`, 'Content-Type': 'application/json' },
      httpsAgent: agent, timeout: 15000,
    });
    const answer = data.choices?.[0]?.message?.content || '?';
    return `grok-3-turbo ✅ | Ответ: "${answer.slice(0,30)}"`;
  });

  // ── 4. Groq Llama — тестовый запрос ──
  await check('Groq (Llama)', '🦙', async () => {
    if (!cfg.GROQ_KEY) throw new Error('GROQ_KEY не задан в .env');
    const { data } = await ax.post(cfg.GROQ_CHAT_URL, {
      model:     'llama-3.1-8b-instant',
      messages:  [{ role: 'user', content: 'ping' }],
      max_tokens: 5,
    }, {
      headers: { Authorization: `Bearer ${cfg.GROQ_KEY}` },
      httpsAgent: agent, timeout: 15000,
    });
    const answer = data.choices?.[0]?.message?.content || '?';
    return `llama-3.1-8b ✅ | Ответ: "${answer.slice(0,30)}" | ${data.data?.length||'?'} моделей`;
  });

  // ── 5. Auchan LLM — тестовый запрос с retry ──
  await check('Auchan LLM (Corp)', '🏢', async () => {
    if (!cfg.AUCHAN_BEARER) throw new Error('AUCHAN_BEARER не задан в .env');
    const result = await callAuchan(
      [{ role: 'user', content: 'Что ты умеешь? (ответь кратко, 1-2 предложения)' }],
      { maxTokens: 150, temperature: 0.7, maxRetries: 3, retryDelay: 2000 }
    );
    return `Auchan LLM ✅ | Ответ: "${result.text.slice(0, 80)}"`;
  });

  // ── 6. Яндекс Диск ──
  await check('Яндекс Диск', '💾', async () => {
    if (!cfg.YANDEX_DISK_TOKEN) throw new Error('YANDEX_DISK_TOKEN не задан в .env');
    const { data } = await ax.get('https://cloud-api.yandex.net/v1/disk/', {
      headers: { Authorization: `OAuth ${cfg.YANDEX_DISK_TOKEN}` },
      httpsAgent: agent, timeout: 10000,
    });
    const used  = Math.round(data.used_space / 1024 / 1024);
    const total = Math.round(data.total_space / 1024 / 1024);
    return `${data.user?.login} | ${used}МБ / ${total}МБ`;
  });

  // ── 7. Яндекс Мессенджер — getUpdates тест ──
  await check('Яндекс Мессенджер', '💬', async () => {
    if (!cfg.YANDEX_BOT_TOKEN) throw new Error('YANDEX_BOT_TOKEN не задан в .env');
    const { data } = await ax.get(
      'https://botapi.messenger.yandex.net/bot/v1/messages/getUpdates/', {
      headers: { Authorization: `OAuth ${cfg.YANDEX_BOT_TOKEN}` },
      params:  { limit: 1, offset: 0 },
      httpsAgent: agent, timeout: 10000,
    });
    const updates = data.updates || [];
    // Показываем последнее сообщение если есть
    const lastMsg = updates.length
      ? (updates[0].message?.text || updates[0].message?.body || '(медиа)').slice(0,40)
      : 'нет новых';
    return `✅ Токен валиден | Последнее: "${lastMsg}"`;
  });

  // ── 8. JupyterHub ──
  await check('JupyterHub', '📓', async () => {
    if (!cfg.JH_TOKEN || cfg.JH_TOKEN === 'YOUR_JUPYTER_TOKEN')
      throw new Error('JH_TOKEN не задан в .env');
    if (!cfg.JH_URL) throw new Error('JH_URL не задан в .env');
    // Пробуем разные endpoints
    for (const ep of ['kernels', 'contents', 'status']) {
      try {
        const { data } = await ax.get(`${cfg.JH_URL}/api/${ep}`, {
          headers: { Authorization: `Token ${cfg.JH_TOKEN}` },
          httpsAgent: agent, timeout: 10000,
        });
        if (ep === 'kernels' && Array.isArray(data))
          return `✅ Активных ядер: ${data.length} | kernel: ${data[0]?.name || '—'}`;
        return `✅ endpoint /${ep} доступен`;
      } catch (_) {}
    }
    throw new Error('Все endpoints недоступны — проверьте токен');
  });

  // ── 9. Яндекс Почта IMAP ──
  await check('Яндекс Почта IMAP', '📧', async () => {
    if (!cfg.YANDEX_LOGIN || !cfg.YANDEX_PASSWORD)
      throw new Error('YANDEX_LOGIN/PASSWORD не заданы в .env');
    const { ImapFlow } = require('imapflow');
    const client = new ImapFlow({
      host: 'imap.yandex.ru', port: 993, secure: true,
      auth: { user: cfg.YANDEX_LOGIN, pass: cfg.YANDEX_PASSWORD },
      logger: false,
    });
    await client.connect();
    const status = await client.status('INBOX', { messages: true, unseen: true });
    await client.logout();
    return `${cfg.YANDEX_LOGIN} | Всего: ${status.messages} | Непрочитано: ${status.unseen}`;
  });

  return results;
}


function formatTokenResults(results) {
  const lines = ['🔑 Статус токенов и доступов\n'];

  let ok = 0, fail = 0;

  for (const r of results) {
    const status = r.ok ? '✅' : '❌';
    const ms     = r.ms < 1000 ? `${r.ms}мс` : `${(r.ms/1000).toFixed(1)}с`;
    lines.push(`${status} ${r.emoji} ${r.name}`);
    lines.push(`   ${r.info}  (${ms})`);
    if (r.ok) ok++; else fail++;
  }

  lines.push('');
  lines.push(`Итого: ✅ ${ok} работают  ❌ ${fail} проблем`);
  if (fail > 0) lines.push('\nПроблемные токены — обновите в .env файле');
  return lines.join('\n');
}

// ── /last — последние события ──
async function getLastEvents() {
  const out = [];

  // 1. Последние 5 файлов на диске
  const diskDocs = vaultIndex.docs
    .filter(d => d.type === 'disk_file' && d.date)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 5);
  if (diskDocs.length) {
    out.push('💾 Последние файлы на диске:');
    for (const d of diskDocs)
      out.push(`   📄 ${d.title?.slice(0,45) || '—'}  📅 ${d.date}`);
    out.push('');
  }

  // 2. Последние 5 писем
  const emails = vaultIndex.docs
    .filter(d => d.type === 'email' && d.date)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 5);
  if (emails.length) {
    out.push('📧 Последние письма:');
    for (const d of emails) {
      const from = (d.from || '').replace(/<.+?>/, '').trim().slice(0, 25);
      out.push(`   ${from}  —  ${(d.subject || d.title || '').slice(0, 35)}  📅 ${d.date}`);
    }
    out.push('');
  }

  // 3+4. Последние сообщения в Яндекс Мессенджере (личные + группы)
  const chats = vaultIndex.docs
    .filter(d => d.type === 'messenger_chat')
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const personal = chats.filter(d => !d.path.toLowerCase().includes('групп') &&
                                     !d.path.toLowerCase().includes('group'));
  const groups   = chats.filter(d =>  d.path.toLowerCase().includes('групп') ||
                                      d.path.toLowerCase().includes('group'));

  // Функция извлечения последних N сообщений из тела чата
  function extractLastMessages(body, n = 5) {
    const msgBlocks = [];
    const bodyLines = (body || '').split('\n');
    let currentSender = '', currentTime = '', currentText = [];

    for (const line of bodyLines) {
      // Строка с отправителем и временем: **Имя** `2026-04-25 02:18`
      const headerMatch = line.match(/\*\*(.+?)\*\*\s+`([^`]+)`/);
      if (headerMatch) {
        // Сохраняем предыдущий блок
        if (currentText.length > 0) {
          msgBlocks.push({
            sender: currentSender,
            time:   currentTime,
            text:   currentText.join(' ').replace(/^>\s*/, '').trim(),
          });
        }
        currentSender = headerMatch[1];
        currentTime   = headerMatch[2];
        currentText   = [];
      } else if (line.startsWith('> ')) {
        currentText.push(line.slice(2));
      }
    }
    // Последний блок
    if (currentText.length > 0) {
      msgBlocks.push({
        sender: currentSender,
        time:   currentTime,
        text:   currentText.join(' ').trim(),
      });
    }
    return msgBlocks.slice(-n);
  }

  if (personal.length) {
    out.push('💬 Последние сообщения боту (Мессенджер):');
    for (const d of personal.slice(0, 3)) {
      const msgs = extractLastMessages(d.body, 5);
      // Берём дату последнего сообщения если date пустая
      const lastMsgDate = msgs.length ? msgs[msgs.length-1].time.slice(0,10) : d.date;
      const displayDate = lastMsgDate || d.date || '—';
      out.push(`\n📱 ${(d.chatName || d.title || '').slice(0,35)}  📅 ${displayDate}`);
      if (msgs.length) {
        for (const m of msgs)
          out.push(`   [${m.time}] ${m.sender.slice(0,20)}: ${m.text.slice(0, 120)}`);
      } else {
        out.push('   (нет сообщений)');
      }
    }
    out.push('');
  }

  if (groups.length) {
    out.push('👥 Последние сообщения в группах:');
    for (const d of groups.slice(0, 3)) {
      const msgs = extractLastMessages(d.body, 5);
      const lastMsgDate = msgs.length ? msgs[msgs.length-1].time.slice(0,10) : d.date;
      const displayDate = lastMsgDate || d.date || '—';
      out.push(`\n📱 ${(d.chatName || d.title || '').slice(0,35)}  📅 ${displayDate}`);
      if (msgs.length) {
        for (const m of msgs)
          out.push(`   [${m.time}] ${m.sender.slice(0,20)}: ${m.text.slice(0, 120)}`);
      } else {
        out.push('   (нет сообщений)');
      }
    }
    out.push('');
  }

  // 5. Последняя расшифровка Plaud
  const plauds = vaultIndex.docs
    .filter(d => d.type === 'voice_transcript' && d.date)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 1);
  if (plauds.length) {
    const p = plauds[0];
    // Берём первые строки AI выжимки
    const body  = p.body || '';
    const start = body.indexOf('## 🤖 AI Выжимка');
    const end   = body.indexOf('## 📝 Полная');
    const summary = start >= 0 && end > start
      ? body.slice(start + 18, end).trim().slice(0, 200)
      : body.slice(0, 200);
    out.push('🎙️ Последняя запись Plaud:');
    out.push(`   📅 ${p.date}  ${(p.title || '').slice(0, 40)}`);
    out.push(`   ${summary.split('\n')[0]?.slice(0, 80) || '—'}`);
    out.push('');
  }

  // 6. Последние 5 контактов кто писал на email
  const recentSenders = vaultIndex.docs
    .filter(d => d.type === 'email' && d.from && d.date)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 20);

  const seenSenders = new Set();
  const topSenders  = [];
  for (const d of recentSenders) {
    const m    = d.from.match(/<(.+?)>/);
    const email = m ? m[1] : d.from;
    const name  = d.from.replace(/<.+?>/, '').trim().replace(/"/g,'') || email;
    if (!seenSenders.has(email)) {
      seenSenders.add(email);
      topSenders.push({ name: name.slice(0,30), email: email.slice(0,35), date: d.date });
    }
    if (topSenders.length >= 5) break;
  }

  if (topSenders.length) {
    out.push('👤 Последние контакты (email):');
    for (const s of topSenders)
      out.push(`   ${s.name}  📅 ${s.date}`);
  }

  return out.join('\n');
}

// ── /start ──
bot.onText(/\/start|\/help/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  const s   = vaultIndex.stats();
  const mdl = cfg.AVAILABLE_MODELS[getModelKey(msg.from.id)]?.name || 'Claude Haiku';

  let text = `Vault Bot v2 (Node.js)\n\nБаза: ${s.total} заметок\n`;
  for (const [t, n] of Object.entries(s.by_type).sort((a,b) => b[1]-a[1])) {
    const e = { email:'📧', messenger_chat:'💬', voice_transcript:'🎙️', disk_file:'💾', contact:'👤' }[t] || '📄';
    text += `${e} ${t}: ${n}\n`;
  }
  text += `\n🤖 Модель: ${mdl}\n\n`;
  text += 'Команды:\n/where — выбор папок\n/search — поиск\n/person — поиск по человеку\n' +
          '/insights — инсайты\n/analytics — аналитика\n/tasks — задачи\n' +
          '/digest — дайджест\n/contacts — контакты\n/favorites — избранное\n' +
          '/last — последние события\n/checktoken — проверить все токены\n/security — ИБ дайджест\n/pii — сканирование PII\n/classify <запрос> — классификация\n/audit — лог доступов\n/refresh — переиндексировать\n/sync — синхронизация\n' +
          '/model — сменить LLM\n/usage — токены\n/clear — очистить диалог\n' +
          '🎤 Голосовое → транскрипция + поиск';

  await reply(msg, text, inlineKb([
    [{ text: '💡 Инсайты',        callback_data: 'insights'     }, { text: '📊 Аналитика',  callback_data: 'analytics'   }],
    [{ text: '📧 Саммари почты',  callback_data: 'sum_email'    }, { text: '💬 Чаты',       callback_data: 'sum_chat'    }],
    [{ text: '📋 Задачи',         callback_data: 'tasks'        }, { text: '🗓 Дайджест',   callback_data: 'digest'      }],
    [{ text: '👥 Контакты',       callback_data: 'contacts'     }, { text: '⭐ Избранное',  callback_data: 'favorites'   }],
    [{ text: '🔍 Папки',          callback_data: 'where'        }, { text: '🔄 Переиндекс', callback_data: 'refresh'     }],
    [{ text: '🕐 Последние',       callback_data: 'last_events'  }],
    [{ text: '🔐 ИБ Дайджест',      callback_data: 'security'     }, { text: '🔍 Скан PII', callback_data: 'pii_scan' }],
    [{ text: '💾 Синхронизация',  callback_data: 'sync_menu'   }, { text: '🤖 Модель',     callback_data: 'switch_model'}],
    [{ text: '📊 Токены',         callback_data: 'show_usage'   }],
    [{ text: '🔑 Проверить токены', callback_data: 'checktoken'   }],
  ]));
});

// ── /security ──
bot.onText(/\/security/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  auditLog(msg.from.id, '/security');
  const sent = await reply(msg, '🔐 Формирую ИБ дайджест...');
  try {
    const text = await securityDigest(msg.from.id);
    await edit(msg.chat.id, sent.message_id, text.slice(0, 4000));
  } catch (e) {
    await edit(msg.chat.id, sent.message_id, `❌ ${e.message}`);
  }
});

// ── /pii ──
bot.onText(/\/pii/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  auditLog(msg.from.id, '/pii');
  const sent = await reply(msg, '🔍 Сканирую документы на PII...');
  try {
    const text = await scanPII(msg.from.id);
    for (let i = 0; i < text.length; i += 4000)
      i === 0
        ? await edit(msg.chat.id, sent.message_id, text.slice(0, 4000))
        : await reply(msg, text.slice(i, i + 4000));
  } catch (e) {
    await edit(msg.chat.id, sent.message_id, `❌ ${e.message}`);
  }
});

// ── /classify ──
bot.onText(/\/classify (.+)/, async (msg, match) => {
  if (!checkAccess(msg.from.id)) return;
  const query = match[1];
  auditLog(msg.from.id, '/classify', query);
  const sent  = await reply(msg, `🔍 Классифицирую: ${query}...`);
  try {
    const docs = vaultIndex.search(query, { topK: 5 });
    if (!docs.length) { await edit(msg.chat.id, sent.message_id, '🔍 Документы не найдены.'); return; }
    const lines = [`🔐 Классификация документов по запросу: ${query}\n`];
    for (const doc of docs) {
      const level = await classifyDoc(doc, msg.from.id);
      const pii   = findPII(doc.body || '');
      lines.push(`${level}`);
      lines.push(`📄 ${(doc.title || '').slice(0, 50)}`);
      lines.push(`   Тип: ${doc.type}  📅 ${doc.date}`);
      if (pii.length)
        lines.push(`   ⚠️  PII: ${pii.map(p => p.type).join(', ')}`);
      lines.push('');
    }
    await edit(msg.chat.id, sent.message_id, lines.join('\n').slice(0, 4000));
  } catch (e) {
    await edit(msg.chat.id, sent.message_id, `❌ ${e.message}`);
  }
});

// ── /audit ──
bot.onText(/\/audit/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  auditLog(msg.from.id, '/audit');
  try {
    const fs  = require('fs');
    if (!fs.existsSync(AUDIT_FILE)) { await reply(msg, '📋 Аудит лог пуст.'); return; }
    const raw  = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean);
    const last = raw.slice(-30).reverse()
      .map(l => { try { const e = JSON.parse(l); return `${e.ts.slice(0,16)} [${e.uid}] ${e.action} ${e.detail}`; } catch (_) { return l; } })
      .join('\n');
    await reply(msg, `📋 Последние 30 событий:\n\n${last}`.slice(0, 4000));
  } catch (e) {
    await reply(msg, `❌ ${e.message}`);
  }
});

// ── /confluence ──
bot.onText(/\/confluence (.+)/, async (msg, match) => {
  if (!checkAccess(msg.from.id)) return;
  const args = match[1].trim();
  const sent = await reply(msg, '📝 Confluence...');
  try {
    const confluence = getConfluence();

    if (args.startsWith('create ')) {
      // /confluence create Название страницы
      const title = args.slice(7).trim();
      const page  = await createConfluencePage(title, '', vaultIndex);
      await edit(msg.chat.id, sent.message_id,
        `✅ Страница создана!

📄 ${page.title}
🔗 ${page.url}`);

    } else if (args.startsWith('search ')) {
      // /confluence search запрос
      const query   = args.slice(7).trim();
      const pages   = await confluence.searchPages(query);
      if (!pages.length) { await edit(msg.chat.id, sent.message_id, '🔍 Ничего не найдено'); return; }
      let text = `🔍 Confluence: ${query}\n\n`;
      for (const p of pages.slice(0,5))
        text += `📄 ${p.title}\n   📅 ${p.updated}\n   🔗 ${p.url}\n\n`;
      await edit(msg.chat.id, sent.message_id, text);

    } else {
      // /confluence Название — создать страницу
      const page = await createConfluencePage(args, '', vaultIndex);
      await edit(msg.chat.id, sent.message_id,
        `✅ Страница создана!\n\n📄 ${page.title}\n🔗 ${page.url}`);
    }
  } catch (e) {
    await edit(msg.chat.id, sent.message_id, `❌ Confluence: ${e.message}`);
  }
});

// ── /jira ──
bot.onText(/\/jira(.*)/, async (msg, match) => {
  if (!checkAccess(msg.from.id)) return;
  const args = (match[1] || '').trim();
  const sent = await reply(msg, '🎯 JIRA...');
  try {
    const jira = getJIRA();

    if (!args || args === 'my') {
      // /jira — мои задачи
      const issues = await jira.getMyIssues();
      if (!issues.length) { await edit(msg.chat.id, sent.message_id, '✅ Нет активных задач'); return; }
      let text = '🎯 Мои задачи JIRA:\n\n';
      for (const i of issues)
        text += `${i.key} — ${i.summary.slice(0,50)}\n   ${i.status} | ${i.priority}\n\n`;
      await edit(msg.chat.id, sent.message_id, text.slice(0,4000));

    } else if (args.startsWith('log ')) {
      // /jira log 2ч BD-123 встреча с командой
      const parsed = parseWorklog(args.slice(4));
      if (!parsed.hours || !parsed.issueKey)
        { await edit(msg.chat.id, sent.message_id, '❌ Формат: /jira log 2ч BD-123 комментарий'); return; }
      const result = await jira.logWork(parsed.issueKey, parsed.hours, parsed.comment, parsed.date);
      await edit(msg.chat.id, sent.message_id,
        `✅ Время списано!\n\n🎯 ${result.issueKey}\n⏱ ${result.timeSpent}\n💬 ${result.comment}\n📅 ${result.date}`);

    } else if (args.match(/^[A-Z]+-\d+$/i)) {
      // /jira BD-123 — информация о задаче
      const issue = await jira.getIssue(args.toUpperCase());
      await edit(msg.chat.id, sent.message_id,
        `🎯 ${issue.key}: ${issue.summary}\n\nСтатус: ${issue.status}\nИсполнитель: ${issue.assignee}\nПриоритет: ${issue.priority}\nСписано: ${issue.timeSpent}\nОсталось: ${issue.timeLeft}\n\n🔗 ${issue.url}`);

    } else if (args.startsWith('worklogs')) {
      // /jira worklogs — мои логи за неделю
      const logs = await jira.getMyWorklogs(7);
      if (!logs.length) { await edit(msg.chat.id, sent.message_id, '📋 Нет логов за 7 дней'); return; }
      let text = '⏱ Мои логи за 7 дней:\n\n';
      let total = 0;
      for (const l of logs) {
        text += `${l.key} — ${l.summary.slice(0,40)}\n   ⏱ ${l.loggedHours}ч\n\n`;
        total += l.loggedHours;
      }
      text += `Итого: ${Math.round(total * 10)/10}ч`;
      await edit(msg.chat.id, sent.message_id, text.slice(0,4000));

    } else {
      // /jira search запрос
      const issues = await jira.searchIssues(`project = "${cfg.JIRA_PROJECT}" AND text ~ "${args}" ORDER BY updated DESC`, 10);
      if (!issues.length) { await edit(msg.chat.id, sent.message_id, `🔍 Не найдено: ${args}`); return; }
      let text = `🔍 JIRA: ${args}\n\n`;
      for (const i of issues)
        text += `${i.key} — ${i.summary.slice(0,50)}\n   ${i.status}\n\n`;
      await edit(msg.chat.id, sent.message_id, text.slice(0,4000));
    }
  } catch (e) {
    await edit(msg.chat.id, sent.message_id, `❌ JIRA: ${e.message}`);
  }
});

// ── /checktoken ──
bot.onText(/\/checktoken/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  auditLog(msg.from.id, '/checktoken');
  const sent = await reply(msg, '🔑 Проверяю все токены...\n\nЭто займёт 10-30 секунд');
  try {
    const results = await checkAllTokens(bot);
    const text    = formatTokenResults(results);
    await edit(msg.chat.id, sent.message_id, text.slice(0, 4000));
  } catch (e) {
    await edit(msg.chat.id, sent.message_id, `❌ ${e.message}`);
  }
});

// ── /last ──
bot.onText(/\/last/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  const sent = await reply(msg, '🔄 Собираю последние события...');
  try {
    const text = await getLastEvents();
    await edit(msg.chat.id, sent.message_id, text || 'Данных пока нет.');
  } catch (e) {
    await edit(msg.chat.id, sent.message_id, `❌ ${e.message}`);
  }
});

// ── /where ──
bot.onText(/\/where/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  const f  = getFilter(msg.from.id);
  const { keyboard, status } = buildFolderKeyboard(f.folders, f.types);
  await reply(msg, status, { reply_markup: { inline_keyboard: keyboard } });
});

// ── /search ──
bot.onText(/\/search (.+)/, async (msg, match) => {
  if (!checkAccess(msg.from.id)) return;
  const query = match[1];
  const uid   = msg.from.id;
  const filt  = getFilter(uid);
  const sent  = await reply(msg, `🔍 Ищу: ${query}...`);
  try {
    const { dateFrom, dateTo, cleaned } = parseTimeExpression(query);
    const dt   = filt.types.length === 1 ? filt.types[0] : null;
    const docs = await vaultIndex.searchHybrid(cleaned || query, { topK: 7, docType: dt, folders: filt.folders, dateFrom, dateTo });

    if (!docs.length) {
      await edit(msg.chat.id, sent.message_id, '🔍 Ничего не найдено. Попробуйте /where → Сбросить');
      return;
    }

    const em = { email:'📧', messenger_chat:'💬', voice_transcript:'🎙️', disk_file:'💾' };
    let text = `🔍 ${query}\n`;
    if (dateFrom) text += `📅 ${dateFrom.toLocaleDateString('ru')} — ${(dateTo||new Date()).toLocaleDateString('ru')}\n`;
    text += '\n';
    for (const doc of docs) {
      const snip = (doc.body||'').slice(0,100).replace(/\n/g,' ').trim();
      text += `${em[doc.type]||'📄'} ${doc.title}\n`;
      if (doc.folder) text += `   📁 ${doc.folder}`;
      if (doc.date)   text += `  📅 ${doc.date}`;
      text += `\n   ${snip}…\n\n`;
    }

    await edit(msg.chat.id, sent.message_id, text.slice(0, 4000), inlineKb([
      [{ text: '⭐ В избранное', callback_data: `fav_${docs[0].id.slice(0,20)}` }],
    ]));
  } catch (e) {
    await edit(msg.chat.id, sent.message_id, `❌ ${e.message}`);
  }
});

// ── /person ──
bot.onText(/\/person (.+)/, async (msg, match) => {
  if (!checkAccess(msg.from.id)) return;
  const name = match[1];
  const sent = await reply(msg, `👤 Ищу всё по: ${name}...`);
  try {
    const docs = vaultIndex.searchByPerson(name);
    if (!docs.length) { await edit(msg.chat.id, sent.message_id, `Ничего не найдено по '${name}'`); return; }
    const ctx = formatContext(docs.slice(0, 10));
    const answer = await callLLM(
      [{ role: 'user', content: `Сводка по '${name}':\n${ctx}\n\n1. Кто это\n2. История общения\n3. Открытые задачи\n4. Последний контакт` }],
      { maxTokens: 800, uid: msg.from.id }
    );
    await edit(msg.chat.id, sent.message_id, `👤 ${name}\nДокументов: ${docs.length}\n\n${answer}`.slice(0,4000));
  } catch (e) {
    await edit(msg.chat.id, sent.message_id, `❌ ${e.message}`);
  }
});

// ── /insights ──
bot.onText(/\/insights/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  const sent = await reply(msg, '💡 Анализирую...');
  try {
    await edit(msg.chat.id, sent.message_id, await proactiveInsights(msg.from.id));
  } catch (e) {
    await edit(msg.chat.id, sent.message_id, `❌ ${e.message}`);
  }
});

// ── /analytics ──
bot.onText(/\/analytics/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  const s   = vaultIndex.getActivityStats();
  let text  = '📊 Аналитика vault\n\n📅 По месяцам:\n';
  const max = Math.max(...Object.values(s.byMonth), 1);
  for (const [m, n] of Object.entries(s.byMonth).slice(-6))
    text += `${m}  ${'█'.repeat(Math.round(n/max*15))} ${n}\n`;
  text += '\n📁 Топ папок:\n';
  const maxF = Math.max(...Object.values(s.byFolder), 1);
  for (const [f, n] of Object.entries(s.byFolder).slice(0,7))
    text += `${f.slice(0,20).padEnd(20)} ${'█'.repeat(Math.round(n/maxF*12))} ${n}\n`;
  text += '\n🔤 Топ тем:\n' + Object.entries(s.topTopics).slice(0,10).map(([w,c]) => `${w}(${c})`).join(', ');
  await reply(msg, text.slice(0,4000));
});

// ── /tasks ──
bot.onText(/\/tasks/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  const uid   = msg.from.id;
  const saved = getTasks(uid);

  if (saved.length) {
    let text = '📋 Ваши задачи:\n\n';
    const kb  = [];
    for (let i = 0; i < saved.length; i++) {
      const t = saved[i];
      text += `${t.done ? '✅' : '☐'} ${t.text}\n`;
      kb.push([
        { text: t.done ? '↩️ Отменить' : '✅ Выполнено', callback_data: `task_toggle_${i}` },
        { text: '🗑', callback_data: `task_del_${i}` },
      ]);
    }
    kb.push([{ text: '🔄 Найти новые', callback_data: 'tasks_refresh' }]);
    await reply(msg, text, { reply_markup: { inline_keyboard: kb } });
    return;
  }

  const sent = await reply(msg, '🔍 Ищу задачи...');
  try {
    const result = await extractTasks(uid);
    const lines  = (result.match(/- \[ \] (.+)/g) || []).map(l => l.replace('- [ ] ', ''));
    if (lines.length) saveTasks(uid, lines.map(t => ({ text: t, done: false })));
    await edit(msg.chat.id, sent.message_id, result.slice(0, 4000));
  } catch (e) {
    await edit(msg.chat.id, sent.message_id, `❌ ${e.message}`);
  }
});

// ── /digest ──
bot.onText(/\/digest/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  const sent = await reply(msg, '🗓 Генерирую дайджест...');
  try {
    const result = await weeklyDigest(msg.from.id);
    await bot.deleteMessage(msg.chat.id, sent.message_id);
    for (let i = 0; i < result.length; i += 4000)
      await reply(msg, result.slice(i, i + 4000));
  } catch (e) {
    await edit(msg.chat.id, sent.message_id, `❌ ${e.message}`);
  }
});

// ── /contacts ──
bot.onText(/\/contacts/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  const contacts = vaultIndex.getTopContacts(20);
  if (!contacts.length) { await reply(msg, '👥 Контакты не найдены.'); return; }
  let text = '👥 Топ контактов:\n\n';
  const kb = [];
  for (let i = 0; i < Math.min(contacts.length, 10); i++) {
    const { name, email, count } = contacts[i];
    text += `${i+1}. ${name}\n   ${'█'.repeat(Math.min(Math.floor(count/2),12))} ${count} писем\n\n`;
    kb.push([{ text: `👤 ${name.slice(0,25)}`, callback_data: `person_${name.slice(0,30)}` }]);
  }
  await reply(msg, text.slice(0,4000), { reply_markup: { inline_keyboard: kb } });
});

// ── /favorites ──
bot.onText(/\/favorites/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  const favs = getFavorites(msg.from.id);
  if (!favs.length) { await reply(msg, '⭐ Избранное пусто.\n\nДобавляйте через /search → ⭐'); return; }
  let text = '⭐ Избранное:\n\n';
  const kb = [];
  for (let i = 0; i < favs.length; i++) {
    const f = favs[i];
    text += `${i+1}. ${f.title}\n   📅 ${f.savedAt}\n\n`;
    kb.push([{ text: `🗑 ${f.title.slice(0,20)}`, callback_data: `fav_del_${i}` }]);
  }
  await reply(msg, text.slice(0,4000), { reply_markup: { inline_keyboard: kb } });
});

// ── /refresh ──
bot.onText(/\/refresh/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  const before = vaultIndex.stats();
  const sent   = await reply(msg, `🔄 Переиндексирую... Сейчас: ${before.total} заметок`);
  try {
    vaultIndex = new VaultIndex(cfg.VAULT_PATH);
    const after  = vaultIndex.stats();
    const diff   = after.total - before.total;

    const out = [
      '✅ Индекс обновлён!',
      `Было: ${before.total} → Стало: ${after.total} (${diff >= 0 ? '+' : ''}${diff})`,
      '',
    ];

    // Последнее письмо
    const emails = vaultIndex.getRecent('email', 365).slice(0, 1);
    if (emails.length) {
      out.push('📧 Последнее письмо:');
      out.push(`   ${emails[0].date}  ${emails[0].subject?.slice(0,50) || emails[0].title}`);
      out.push(`   От: ${(emails[0].from||'').slice(0,40)}`);
      out.push('');
    }

    // Последний файл диска
    const disks = vaultIndex.getRecent('disk_file', 365).slice(0, 1);
    if (disks.length) {
      out.push('💾 Последний файл с диска:');
      out.push(`   ${disks[0].date}  ${disks[0].title?.slice(0,50)}`);
      out.push(`   📂 ${disks[0].folder?.slice(0,40)}`);
      out.push('');
    }

    // Топ контактов
    const contacts = vaultIndex.getTopContacts(3);
    if (contacts.length) {
      out.push('👥 Топ контактов:');
      for (const { name, count } of contacts) out.push(`   ${name.slice(0,30)} — ${count} писем`);
      out.push('');
    }

    // Последняя Plaud запись
    const plauds = vaultIndex.getRecent('voice_transcript', 365).slice(0, 1);
    if (plauds.length) {
      out.push('🎙️ Последняя запись Plaud:');
      out.push(`   ${plauds[0].date}  ${plauds[0].title?.slice(0,60)}`);
      out.push('');
    }

    // Последний чат
    const chats = vaultIndex.getRecent('messenger_chat', 365).slice(0, 1);
    if (chats.length) {
      const c    = chats[0];
      const last = (c.body||'').split('\n').reverse().find(l => l.startsWith('> '))?.slice(2) || '';
      out.push('💬 Последний чат:');
      out.push(`   ${(c.chatName||c.title||'').slice(0,35)}`);
      out.push(`   ${c.date}  ${last.slice(0,60)}`);
    }

    await edit(msg.chat.id, sent.message_id, out.join('\n'));
  } catch (e) {
    await edit(msg.chat.id, sent.message_id, `❌ Ошибка: ${e.message}`);
  }
});

// ── /sync ──
bot.onText(/\/sync/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  await reply(msg, '🔄 Выберите источник синхронизации:', inlineKb([
    [{ text: '📧 Только почта',       callback_data: 'sync_email'     }],
    [{ text: '💾 Только диск',         callback_data: 'sync_disk'      }],
    [{ text: '💬 Только мессенджер',   callback_data: 'sync_messenger' }],
    [{ text: '🎙️ Только Plaud',        callback_data: 'sync_plaud'     }],
    [{ text: '🔄 Всё (новые)',         callback_data: 'sync_start'     },
     { text: '🔄 Всё (принудит.)',     callback_data: 'sync_force'     }],
  ]));
});

// ── /model ──
bot.onText(/\/model/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  const cur = getModelKey(msg.from.id);
  const kb  = Object.entries(cfg.AVAILABLE_MODELS).map(([k, m]) => ([{
    text: `${k === cur ? '✅ ' : ''}${m.name} (${m.provider})`,
    callback_data: `set_model_${k}`,
  }]));
  await reply(msg, `🤖 Текущая: ${cfg.AVAILABLE_MODELS[cur]?.name}\n\nВыберите модель:`,
    { reply_markup: { inline_keyboard: kb } });
});

// ── /usage ──
bot.onText(/\/usage/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  const PRICING = { haiku: { in: 0.8, out: 4.0 }, llama: { in: 0.05, out: 0.08 } };
  const stats   = STATE.tokenStats[msg.from.id] || {};
  if (!Object.keys(stats).length) { await reply(msg, '📊 Статистика пуста.'); return; }
  let text = '📊 Статистика токенов\n\n', total = 0;
  for (const [k, d] of Object.entries(stats)) {
    const p    = PRICING[k] || { in: 0, out: 0 };
    const cost = (d.in / 1e6 * p.in) + (d.out / 1e6 * p.out);
    total += cost;
    text  += `🤖 ${cfg.AVAILABLE_MODELS[k]?.name || k}\n`;
    text  += `   Запросов: ${d.requests}\n`;
    text  += `   ⬆️  Input:  ${d.in.toLocaleString()}\n`;
    text  += `   ⬇️  Output: ${d.out.toLocaleString()}\n`;
    text  += `   💰 ~$${cost.toFixed(4)}\n\n`;
  }
  text += `💰 Итого: ~$${total.toFixed(4)}`;
  await reply(msg, text, inlineKb([[{ text: '🔄 Сменить модель', callback_data: 'switch_model' }]]));
});

// ── /clear ──
bot.onText(/\/clear/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  clearDialog(msg.from.id);
  await reply(msg, '✅ История диалога очищена.');
});

// ── /stats ──
bot.onText(/\/stats/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  const s = vaultIndex.stats();
  let text = `📊 Всего: ${s.total}\n\n`;
  for (const [t, n] of Object.entries(s.by_type).sort((a,b) => b[1]-a[1])) {
    const e = { email:'📧', messenger_chat:'💬', voice_transcript:'🎙️', disk_file:'💾', contact:'👤' }[t] || '📄';
    text += `${e} ${t}: ${n} ${'█'.repeat(Math.min(Math.floor(n/10),20))}\n`;
  }
  await reply(msg, text);
});

// ── Голосовые сообщения ──
bot.on('voice', async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  const sent = await reply(msg, '🎤 Получил голосовое...');
  let tmpOgg = null, tmpMp3 = null;
  try {
    const file    = await bot.getFile(msg.voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${cfg.TELEGRAM_TOKEN}/${file.file_path}`;
    tmpOgg        = path.join(require('os').tmpdir(), `voice_${msg.voice.file_id}.ogg`);

    const { data } = await axios.get(fileUrl, { responseType: 'stream' });
    await new Promise((res, rej) => {
      const ws = fs.createWriteStream(tmpOgg);
      data.pipe(ws);
      ws.on('finish', res); ws.on('error', rej);
    });

    await edit(msg.chat.id, sent.message_id, '🎤 Конвертирую и транскрибирую...');
    tmpMp3 = await convertToMp3(tmpOgg);

    const text = await grokSTT(tmpMp3);
    if (!text) { await edit(msg.chat.id, sent.message_id, '🎤 Не удалось распознать речь.'); return; }

    await edit(msg.chat.id, sent.message_id, `🎤 Распознано:\n\n${text}\n\n🔍 Ищу в базе...`);

    const filt = getFilter(msg.from.id);
    const dt   = filt.types.length === 1 ? filt.types[0] : null;
    const answer = await ragAsk(text, { uid: msg.from.id, docType: dt, folders: filt.folders });
    await edit(msg.chat.id, sent.message_id, `🎤 «${text.slice(0,60)}»\n\n${answer}`.slice(0,4000));
  } catch (e) {
    log.error(`Voice error: ${e.message}`);
    await edit(msg.chat.id, sent.message_id, `❌ Ошибка: ${e.message}`);
  } finally {
    for (const f of [tmpOgg, tmpMp3]) {
      try { if (f && fs.existsSync(f)) fs.removeSync(f); } catch (_) {}
    }
  }
});

// ── Свободный текст (RAG) ──
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  if (!checkAccess(msg.from.id)) return;

  const filt = getFilter(msg.from.id);
  const dt   = filt.types.length === 1 ? filt.types[0] : null;
  auditLog(msg.from.id, 'ask', msg.text);
  const sent = await reply(msg, '🤔 Ищу в базе знаний...');
  try {
    const answer = await ragAsk(msg.text, { uid: msg.from.id, docType: dt, folders: filt.folders });
    const chunks = [];
    for (let i = 0; i < answer.length; i += 4000) chunks.push(answer.slice(i, i+4000));
    await edit(msg.chat.id, sent.message_id, chunks[0]);
    for (const chunk of chunks.slice(1)) await reply(msg, chunk);
  } catch (e) {
    await edit(msg.chat.id, sent.message_id, `❌ ${e.message}`);
  }
});

// ── Callback кнопок ──
bot.on('callback_query', async (query) => {
  const data = query.data;
  const uid  = query.from.id;
  const cid  = query.message.chat.id;
  const mid  = query.message.message_id;
  await bot.answerCallbackQuery(query.id);

  if (data === 'noop') return;

  if (data === 'checktoken') {
    auditLog(uid, 'checktoken_cb');
    await edit(cid, mid, '🔑 Проверяю все токены...\n\nЭто займёт 10-30 секунд');
    try {
      const results = await checkAllTokens(bot);
      await edit(cid, mid, formatTokenResults(results).slice(0, 4000));
    } catch (e) { await edit(cid, mid, `❌ ${e.message}`); }
    return;
  }

  if (data === 'security') {
    auditLog(uid, 'security_cb');
    await edit(cid, mid, '🔐 Формирую ИБ дайджест...');
    try {
      await edit(cid, mid, (await securityDigest(uid)).slice(0, 4000));
    } catch (e) { await edit(cid, mid, `❌ ${e.message}`); }
    return;
  }

  if (data === 'pii_scan') {
    auditLog(uid, 'pii_scan');
    await edit(cid, mid, '🔍 Сканирую на PII...');
    try {
      const text = await scanPII(uid);
      await edit(cid, mid, text.slice(0, 4000));
    } catch (e) { await edit(cid, mid, `❌ ${e.message}`); }
    return;
  }

  if (data === 'last_events') {
    await edit(cid, mid, '🔄 Собираю последние события...');
    try {
      const text = await getLastEvents();
      await edit(cid, mid, text || 'Данных пока нет.');
    } catch (e) {
      await edit(cid, mid, `❌ ${e.message}`);
    }
    return;
  }

  // ─ Саммари ─
  if (data.startsWith('sum_')) {
    const dt = { sum_email: 'email', sum_chat: 'messenger_chat', sum_voice: 'voice_transcript', sum_disk: 'disk_file' }[data] || 'email';
    await edit(cid, mid, '⏳ Генерирую саммари...');
    try { await edit(cid, mid, (await summarize(dt, uid)).slice(0,4000)); }
    catch (e) { await edit(cid, mid, `❌ ${e.message}`); }
    return;
  }

  // ─ Задачи ─
  if (data === 'tasks' || data === 'tasks_refresh') {
    await edit(cid, mid, '⏳ Ищу задачи...');
    try {
      const result = await extractTasks(uid);
      const lines  = (result.match(/- \[ \] (.+)/g) || []).map(l => l.replace('- [ ] ', ''));
      if (lines.length) saveTasks(uid, lines.map(t => ({ text: t, done: false })));
      await edit(cid, mid, result.slice(0,4000));
    } catch (e) { await edit(cid, mid, `❌ ${e.message}`); }
    return;
  }

  if (data.startsWith('task_toggle_')) {
    const idx   = parseInt(data.replace('task_toggle_',''));
    const tasks = getTasks(uid);
    if (tasks[idx]) { tasks[idx].done = !tasks[idx].done; saveTasks(uid, tasks); }
    let text = '📋 Задачи:\n\n';
    const kb = [];
    for (let i = 0; i < tasks.length; i++) {
      text += `${tasks[i].done ? '✅' : '☐'} ${tasks[i].text}\n`;
      kb.push([{ text: tasks[i].done ? '↩️' : '✅', callback_data: `task_toggle_${i}` },
               { text: '🗑', callback_data: `task_del_${i}` }]);
    }
    await edit(cid, mid, text, { reply_markup: { inline_keyboard: kb } });
    return;
  }

  if (data.startsWith('task_del_')) {
    const idx   = parseInt(data.replace('task_del_',''));
    const tasks = getTasks(uid);
    tasks.splice(idx, 1);
    saveTasks(uid, tasks);
    await bot.answerCallbackQuery(query.id, { text: 'Удалено' });
    return;
  }

  // ─ Дайджест ─
  if (data === 'digest') {
    await edit(cid, mid, '⏳ Генерирую дайджест...');
    try { await edit(cid, mid, (await weeklyDigest(uid)).slice(0,4000)); }
    catch (e) { await edit(cid, mid, `❌ ${e.message}`); }
    return;
  }

  // ─ Инсайты ─
  if (data === 'insights') {
    await edit(cid, mid, '💡 Анализирую...');
    try { await edit(cid, mid, await proactiveInsights(uid)); }
    catch (e) { await edit(cid, mid, `❌ ${e.message}`); }
    return;
  }

  // ─ Аналитика ─
  if (data === 'analytics') {
    const s = vaultIndex.getActivityStats();
    let text = '📊 Аналитика\n\n';
    const max = Math.max(...Object.values(s.byMonth), 1);
    for (const [m, n] of Object.entries(s.byMonth).slice(-6))
      text += `${m} ${'█'.repeat(Math.round(n/max*12))} ${n}\n`;
    await edit(cid, mid, text.slice(0,4000));
    return;
  }

  // ─ Контакты ─
  if (data === 'contacts') {
    const contacts = vaultIndex.getTopContacts(10);
    let text = '👥 Топ контактов:\n\n';
    const kb = [];
    for (let i = 0; i < contacts.length; i++) {
      text += `${i+1}. ${contacts[i].name} — ${contacts[i].count} писем\n`;
      kb.push([{ text: `👤 ${contacts[i].name.slice(0,25)}`, callback_data: `person_${contacts[i].name.slice(0,30)}` }]);
    }
    await edit(cid, mid, text.slice(0,4000), { reply_markup: { inline_keyboard: kb } });
    return;
  }

  // ─ Person ─
  if (data.startsWith('person_')) {
    const name = data.replace('person_','');
    await edit(cid, mid, `👤 Ищу: ${name}...`);
    try {
      const docs = vaultIndex.searchByPerson(name);
      const answer = await callLLM(
        [{ role: 'user', content: `Сводка по '${name}':\n${formatContext(docs.slice(0,10))}\n\n1. Кто\n2. История\n3. Задачи\n4. Последний контакт` }],
        { maxTokens: 600, uid }
      );
      await edit(cid, mid, `👤 ${name}\n\n${answer}`.slice(0,4000));
    } catch (e) { await edit(cid, mid, `❌ ${e.message}`); }
    return;
  }

  // ─ Избранное ─
  if (data === 'favorites') {
    const favs = getFavorites(uid);
    if (!favs.length) { await edit(cid, mid, '⭐ Избранное пусто.'); return; }
    let text = '⭐ Избранное:\n\n';
    for (let i = 0; i < favs.length; i++) text += `${i+1}. ${favs[i].title}\n`;
    await edit(cid, mid, text.slice(0,4000));
    return;
  }

  if (data.startsWith('fav_') && !data.startsWith('fav_del_')) {
    const docId = data.replace('fav_','');
    const doc   = vaultIndex.docs.find(d => d.id.startsWith(docId));
    if (doc) { addFavorite(uid, doc); await bot.answerCallbackQuery(query.id, { text: '⭐ Добавлено!' }); }
    return;
  }

  if (data.startsWith('fav_del_')) {
    const idx = parseInt(data.replace('fav_del_',''));
    if (STATE.favorites[uid]) { STATE.favorites[uid].splice(idx, 1); saveState(STATE); }
    await bot.answerCallbackQuery(query.id, { text: 'Удалено' });
    return;
  }

  // ─ Синхронизация ─
  if (data === 'sync_menu') {
    await edit(cid, mid,
      '🔄 Выберите источник синхронизации:\n\nМожно запустить всё или только нужное:',
      { reply_markup: { inline_keyboard: [
        [{ text: '📧 Только почта',         callback_data: 'sync_email'     }],
        [{ text: '💾 Только диск',           callback_data: 'sync_disk'      }],
        [{ text: '💬 Только мессенджер',     callback_data: 'sync_messenger' }],
        [{ text: '🎙️ Только Plaud',          callback_data: 'sync_plaud'     }],
        [{ text: '🔄 Всё (новые)',           callback_data: 'sync_start'     },
         { text: '🔄 Всё (принудительно)',   callback_data: 'sync_force'     }],
      ]}}
    );
    return;
  }

  // Синхронизация отдельных источников
  if (data === 'sync_email') {
    await edit(cid, mid, '📧 Синхронизирую почту...');
    try {
      const { syncEmail } = require('./syncer');
      let count = 0;
      const r = await syncEmail(cfg.VAULT_PATH, {
        onProgress: async (n, subject) => {
          count = n;
          if (n % 5 === 0)
            await edit(cid, mid, `📧 Почта: +${n} писем\n   └ ${(subject||'').slice(0,40)}`);
        }
      });
      vaultIndex = new VaultIndex(cfg.VAULT_PATH);
      await edit(cid, mid, `📧 Почта готова!\n\n✅ Новых: ${r.new}\nОшибок: ${r.errors}\nВсего заметок: ${vaultIndex.stats().total}`);
    } catch (e) { await edit(cid, mid, `❌ Почта: ${e.message}`); }
    return;
  }

  if (data === 'sync_disk') {
    await edit(cid, mid, '💾 Синхронизирую Яндекс Диск...');
    try {
      const { syncDisk } = require('./syncer');
      const r = await syncDisk(cfg.VAULT_PATH, {
        force: false,
        onProgress: async (cur, total, name) => {
          if (cur % 10 === 0 || cur === 1)
            await edit(cid, mid, `💾 Диск: ${cur}/${total}\n   └ ${(name||'').slice(0,35)}`);
        }
      });
      vaultIndex = new VaultIndex(cfg.VAULT_PATH);
      await edit(cid, mid,
        `💾 Диск готов!\n\n✅ Новых: ${r.new}\nОбновлено: ${r.updated}\nПропущено: ${r.skipped}\nОшибок: ${r.errors}\nВсего заметок: ${vaultIndex.stats().total}`
      );
    } catch (e) { await edit(cid, mid, `❌ Диск: ${e.message}`); }
    return;
  }

  if (data === 'sync_messenger') {
    await edit(cid, mid, '💬 Синхронизирую Яндекс Мессенджер...');
    try {
      const { syncMessenger } = require('./syncer');
      const r = await syncMessenger(cfg.VAULT_PATH);
      vaultIndex = new VaultIndex(cfg.VAULT_PATH);
      await edit(cid, mid, `💬 Мессенджер готов!\n\n✅ Новых сообщений: ${r.new}\nВсего заметок: ${vaultIndex.stats().total}`);
    } catch (e) { await edit(cid, mid, `❌ Мессенджер: ${e.message}`); }
    return;
  }

  if (data === 'sync_plaud') {
    await edit(cid, mid, '🎙️ Обрабатываю Plaud записи...');
    try {
      const { syncPlaud } = require('./syncer');
      const r = await syncPlaud(cfg.VAULT_PATH, cfg.ANTHROPIC_KEY);
      vaultIndex = new VaultIndex(cfg.VAULT_PATH);
      await edit(cid, mid, `🎙️ Plaud готов!\n\n✅ Обработано: ${r.processed} записей\nВсего заметок: ${vaultIndex.stats().total}`);
    } catch (e) { await edit(cid, mid, `❌ Plaud: ${e.message}`); }
    return;
  }

  if (data === 'sync_start' || data === 'sync_force') {
    const force = data === 'sync_force';

    await bot.editMessageText(
      '🔄 Синхронизация запущена...\n\n' +
      '📧 Почта: подключаюсь...\n' +
      '💾 Диск: ожидание...\n' +
      '💬 Мессенджер: ожидание...\n' +
      '🎙️ Plaud: ожидание...',
      { chat_id: cid, message_id: mid }
    );

    let lastUpd = 0;
    const upd = async (text) => {
      const now = Date.now();
      if (now - lastUpd < 3000) return;
      lastUpd = now;
      try {
        await bot.editMessageText(text, { chat_id: cid, message_id: mid });
        log.info('Sync: ' + text.replace(/\n/g, ' | ').slice(0, 80));
      } catch (_) {}
    };

    const status = { email: '⏳', disk: '⏳', messenger: '⏳', plaud: '⏳' };
    const emailR = { new: 0, errors: 0 };
    const diskR  = { new: 0, updated: 0, skipped: 0, errors: 0 };
    const msgR   = { new: 0 };
    const plaudR = { processed: 0 };

    const buildMsg = () =>
      '🔄 Синхронизация...\n\n' +
      `📧 Почта: ${status.email}\n` +
      `💾 Диск: ${status.disk}\n` +
      `💬 Мессенджер: ${status.messenger}\n` +
      `🎙️ Plaud: ${status.plaud}`;

    try {
      // ── Почта ──
      log.info('Sync: email starting...');
      status.email = 'синхронизирую...';
      await upd(buildMsg());
      try {
        const { syncEmail } = require('./syncer');
        const r = await syncEmail(cfg.VAULT_PATH, {
          onProgress: async (n, subject) => {
            status.email = `+${n} писем | ${(subject||'').slice(0,30)}`;
            await upd(buildMsg());
          }
        });
        Object.assign(emailR, r);
        status.email = `✅ +${r.new} новых`;
      } catch (e) {
        status.email = `❌ ${e.message.slice(0,40)}`;
        log.error('Sync email: ' + e.message);
      }
      await upd(buildMsg());

      // ── Диск ──
      log.info('Sync: disk starting...');
      status.disk = 'сканирую...';
      await upd(buildMsg());
      try {
        const { syncDisk } = require('./syncer');
        const r = await syncDisk(cfg.VAULT_PATH, {
          force: force,
          onProgress: async (cur, total, name) => {
            status.disk = `${cur}/${total} | ${(name||'').slice(0,25)}`;
            await upd(buildMsg());
          }
        });
        Object.assign(diskR, r);
        status.disk = `✅ +${r.new} новых, пропущено ${r.skipped}`;
      } catch (e) {
        status.disk = `❌ ${e.message.slice(0,40)}`;
        log.error('Sync disk: ' + e.message);
      }
      await upd(buildMsg());

      // ── Мессенджер ──
      log.info('Sync: messenger starting...');
      status.messenger = 'синхронизирую...';
      await upd(buildMsg());
      try {
        const { syncMessenger } = require('./syncer');
        const r = await syncMessenger(cfg.VAULT_PATH);
        Object.assign(msgR, r);
        status.messenger = `✅ +${r.new} новых`;
      } catch (e) {
        status.messenger = `❌ ${e.message.slice(0,40)}`;
        log.error('Sync messenger: ' + e.message);
      }

      // ── Plaud ──
      log.info('Sync: Plaud starting...');
      status.plaud = 'обрабатываю...';
      await upd(buildMsg());
      try {
        const { syncPlaud } = require('./syncer');
        const r = await syncPlaud(cfg.VAULT_PATH, cfg.ANTHROPIC_KEY);
        Object.assign(plaudR, r);
        status.plaud = `✅ +${r.processed} записей`;
      } catch (e) {
        status.plaud = `❌ ${e.message.slice(0,40)}`;
        log.error('Sync Plaud: ' + e.message);
      }

      // ── Переиндексация ──
      log.info('Sync: reindexing vault...');
      await bot.editMessageText(buildMsg() + '\n\n🔄 Переиндексирую vault...',
        { chat_id: cid, message_id: mid });
      vaultIndex = new VaultIndex(cfg.VAULT_PATH);
      const stats = vaultIndex.stats();
      log.info(`Sync complete: ${stats.total} docs`);

      await bot.editMessageText(
        '✅ Синхронизация завершена!\n\n' +
        `📧 Почта:      ${status.email}\n` +
        `💾 Диск:       ${status.disk}\n` +
        `💬 Мессенджер: ${status.messenger}\n` +
        `🎙️ Plaud:      ${status.plaud}\n\n` +
        `📝 Всего в vault: ${stats.total} заметок`,
        { chat_id: cid, message_id: mid }
      );

    } catch (e) {
      log.error('Sync fatal: ' + e.message);
      await bot.editMessageText(`❌ Ошибка:\n${e.message}`,
        { chat_id: cid, message_id: mid });
    }
    return;
  }

  // ─ Переиндексация ─
  if (data === 'refresh') {
    const before = vaultIndex.stats();
    await edit(cid, mid, '🔄 Переиндексирую...');
    try {
      vaultIndex = new VaultIndex(cfg.VAULT_PATH);
      const after = vaultIndex.stats();
      const diff  = after.total - before.total;
      await edit(cid, mid, `✅ Готово!\nБыло: ${before.total} → Стало: ${after.total} (${diff>=0?'+':''}${diff})`);
    } catch (e) { await edit(cid, mid, `❌ ${e.message}`); }
    return;
  }

  // ─ Модель ─
  if (data === 'switch_model') {
    const cur = getModelKey(uid);
    const kb  = Object.entries(cfg.AVAILABLE_MODELS).map(([k, m]) => ([{
      text: `${k === cur ? '✅ ' : ''}${m.name}`,
      callback_data: `set_model_${k}`,
    }]));
    await edit(cid, mid, `🤖 Текущая: ${cfg.AVAILABLE_MODELS[cur]?.name}`, { reply_markup: { inline_keyboard: kb } });
    return;
  }

  if (data.startsWith('set_model_')) {
    const key = data.replace('set_model_','');
    if (cfg.AVAILABLE_MODELS[key]) {
      setModelKey(uid, key);
      const kb = Object.entries(cfg.AVAILABLE_MODELS).map(([k, m]) => ([{
        text: `${k === key ? '✅ ' : ''}${m.name}`,
        callback_data: `set_model_${k}`,
      }]));
      await edit(cid, mid, `✅ Модель: ${cfg.AVAILABLE_MODELS[key].name}`, { reply_markup: { inline_keyboard: kb } });
    }
    return;
  }

  // ─ Токены ─
  if (data === 'show_usage') {
    const PRICING = { haiku: { in: 0.8, out: 4.0 }, llama: { in: 0.05, out: 0.08 } };
    const stats   = STATE.tokenStats[uid] || {};
    if (!Object.keys(stats).length) { await edit(cid, mid, '📊 Статистика пуста.'); return; }
    let text = '📊 Токены\n\n', total = 0;
    for (const [k, d] of Object.entries(stats)) {
      const p = PRICING[k] || { in: 0, out: 0 };
      const c = (d.in/1e6*p.in) + (d.out/1e6*p.out);
      total  += c;
      text   += `${cfg.AVAILABLE_MODELS[k]?.name||k}: in=${d.in.toLocaleString()} out=${d.out.toLocaleString()} ~$${c.toFixed(4)}\n`;
    }
    text += `\n💰 Итого: ~$${total.toFixed(4)}`;
    await edit(cid, mid, text, inlineKb([[{ text: '🔄 Сменить модель', callback_data: 'switch_model' }]]));
    return;
  }

  // ─ Папки ─
  if (data === 'where') {
    const f = getFilter(uid);
    const { keyboard, status } = buildFolderKeyboard(f.folders, f.types);
    await edit(cid, mid, status, { reply_markup: { inline_keyboard: keyboard } });
    return;
  }

  if (data === 'filter_reset') {
    setFilter(uid, 'folders', []); setFilter(uid, 'types', []);
    const { keyboard, status } = buildFolderKeyboard([], []);
    await edit(cid, mid, '✅ Сброшено.\n\n' + status, { reply_markup: { inline_keyboard: keyboard } });
    return;
  }

  if (data === 'filter_all') {
    const all = vaultIndex.getFolders()['📧 Почта'] || [];
    setFilter(uid, 'folders', all); setFilter(uid, 'types', ['email']);
    const { keyboard, status } = buildFolderKeyboard(all, ['email']);
    await edit(cid, mid, status, { reply_markup: { inline_keyboard: keyboard } });
    return;
  }

  if (data.startsWith('fpage_')) {
    const page = parseInt(data.replace('fpage_',''));
    const f    = getFilter(uid);
    const { keyboard, status } = buildFolderKeyboard(f.folders, f.types, page);
    await edit(cid, mid, status, { reply_markup: { inline_keyboard: keyboard } });
    return;
  }

  if (data.startsWith('filter_type_')) {
    const dtype = data.replace('filter_type_','');
    let types   = getFilter(uid).types;
    types = types.includes(dtype) ? types.filter(t => t !== dtype) : [...types, dtype];
    setFilter(uid, 'types', types);
    const f = getFilter(uid);
    const { keyboard, status } = buildFolderKeyboard(f.folders, types);
    await edit(cid, mid, status, { reply_markup: { inline_keyboard: keyboard } });
    return;
  }

  if (data.startsWith('ff_')) {
    const folder  = data.replace('ff_','');
    let folders   = getFilter(uid).folders;
    folders = folders.includes(folder) ? folders.filter(f => f !== folder) : [...folders, folder];
    setFilter(uid, 'folders', folders);
    let types = getFilter(uid).types;
    if (!types.includes('email') && folders.length) { types = [...types, 'email']; setFilter(uid, 'types', types); }
    const { keyboard, status } = buildFolderKeyboard(folders, types);
    await edit(cid, mid, status, { reply_markup: { inline_keyboard: keyboard } });
    return;
  }
});

// ──────────────────────────────────────────────
//  ФОНОВЫЕ ЗАДАЧИ (cron)
// ──────────────────────────────────────────────

// Детектор аномалий каждые 15 минут
cron.schedule('*/15 * * * *', async () => {
  await checkAnomalies();
});

// Автосинхронизация каждый час
cron.schedule('0 * * * *', async () => {
  log.info('🔄 Автосинхронизация...');
  try {
    const { syncEmail, syncMessenger, syncPlaud } = require('./syncer');

    // Почта
    try {
      const r = await syncEmail(cfg.VAULT_PATH, {});
      if (r.new > 0) {
        log.info(`📧 Почта: +${r.new} новых писем`);
        vaultIndex = new VaultIndex(cfg.VAULT_PATH);
        // Уведомляем пользователя
        if (cfg.ALLOWED_USER_ID && r.new > 0)
          await send(cfg.ALLOWED_USER_ID, `📧 Получено новых писем: ${r.new}\nНапишите /last чтобы увидеть`);
      }
    } catch (e) { log.error(`Автосинх почта: ${e.message}`); }

    // Мессенджер
    try {
      const r = await syncMessenger(cfg.VAULT_PATH);
      if (r.new > 0) {
        log.info(`💬 Мессенджер: +${r.new} новых сообщений`);
        vaultIndex = new VaultIndex(cfg.VAULT_PATH);
      }
    } catch (e) { log.error(`Автосинх мессенджер: ${e.message}`); }

    // Plaud
    try {
      const r = await syncPlaud(cfg.VAULT_PATH, cfg.ANTHROPIC_KEY);
      if (r.processed > 0) {
        log.info(`🎙️ Plaud: +${r.processed} новых записей`);
        vaultIndex = new VaultIndex(cfg.VAULT_PATH);
      }
    } catch (e) { log.error(`Автосинх Plaud: ${e.message}`); }

    log.info(`✅ Автосинхронизация завершена. Заметок: ${vaultIndex.stats().total}`);
  } catch (e) { log.error(`Автосинхронизация: ${e.message}`); }
});

// Автосинх диска раз в 6 часов (диск большой)
cron.schedule('0 */6 * * *', async () => {
  log.info('💾 Автосинхронизация диска...');
  try {
    const { syncDisk } = require('./syncer');
    const r = await syncDisk(cfg.VAULT_PATH, { force: false });
    if (r.new > 0 || r.updated > 0) {
      vaultIndex = new VaultIndex(cfg.VAULT_PATH);
      log.info(`💾 Диск: +${r.new} новых, ${r.updated} обновлено`);
    }
  } catch (e) { log.error(`Автосинх диск: ${e.message}`); }
});

// Алерты каждый час
cron.schedule('0 * * * *', async () => {
  if (!cfg.ALLOWED_USER_ID || !cfg.ALERT_KEYWORDS.length) return;
  const cutoff = new Date(); cutoff.setHours(cutoff.getHours() - 1);
  const alerts = vaultIndex.docs.filter(d => {
    if (d.type !== 'email' || !d.dateObj || d.dateObj < cutoff) return false;
    const text = `${d.subject||''} ${d.body||''}`.toLowerCase();
    return cfg.ALERT_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
  });
  if (!alerts.length) return;
  let text = '🔔 Важные письма:\n\n';
  for (const a of alerts.slice(0,5)) text += `⚡ ${a.subject}\nОт: ${a.from}\n\n`;
  try { await send(cfg.ALLOWED_USER_ID, text); } catch (_) {}
});

// Дайджест по понедельникам
cron.schedule(`0 ${cfg.DIGEST_HOUR} * * ${cfg.DIGEST_WEEKDAY}`, async () => {
  if (!cfg.ALLOWED_USER_ID) return;
  try {
    const digest = await weeklyDigest();
    await send(cfg.ALLOWED_USER_ID, digest.slice(0,4000));
  } catch (_) {}
});

// Инсайты каждый день
cron.schedule('0 9 * * *', async () => {
  if (!cfg.ALLOWED_USER_ID) return;
  try {
    const insights = await proactiveInsights();
    if (!insights.includes('спокойно'))
      await send(cfg.ALLOWED_USER_ID, insights);
  } catch (_) {}
});

// ──────────────────────────────────────────────
//  ЗАПУСК
// ──────────────────────────────────────────────

// ── CLI режим для тестирования ──
if (process.argv.includes('--cli')) {
  (async () => {
    const readline = require('readline');
    console.log('💬 CLI режим Telegram бота');
    console.log('⏳ Жду загрузки эмбеддингов...');
    await new Promise(r => setTimeout(r, 8000));
    console.log(`✅ Vault: ${vaultIndex.stats().total} заметок`);
    console.log('Введите вопрос (exit для выхода)\n');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const TEST_UID = cfg.ALLOWED_USER_ID || 0;

    const ask = () => rl.question('Вы: ', async (text) => {
      text = (text || '').trim();
      if (text === 'exit') { rl.close(); process.exit(0); }
      if (!text) { ask(); return; }
      try {
        const filt   = getFilter(TEST_UID);
        const dt     = filt.types.length === 1 ? filt.types[0] : null;
        const answer = await ragAsk(text, { uid: TEST_UID, docType: dt, folders: filt.folders });
        console.log('\n🤖 Бот: ' + answer + '\n');
      } catch (e) {
        console.error('❌ Ошибка:', e.message);
      }
      ask();
    });
    ask();
  })();
} else {

if (!cfg.TELEGRAM_TOKEN) { log.error('❌ TELEGRAM_TOKEN не задан в .env'); process.exit(1); }
if (!cfg.ANTHROPIC_KEY)  { log.error('❌ ANTHROPIC_KEY не задан в .env');  process.exit(1); }

log.info(`✅ Vault Bot v2 (Node.js) запущен!`);
log.info(`   Заметок: ${vaultIndex.stats().total}`);
log.info(`   Модель по умолчанию: ${cfg.AVAILABLE_MODELS[cfg.DEFAULT_MODEL]?.name}`);
log.info(`   Ctrl+C — остановка`);

bot.on('polling_error', (err) => {
  log.error(`Polling error: ${err.message}`);
  if (err.message.includes('ENOTFOUND') || 
      err.message.includes('EHOSTUNREACH') ||
      err.message.includes('ECONNRESET') ||
      err.message.includes('EFATAL')) {
    log.info('Сеть недоступна, повтор через 10с...');
    setTimeout(() => {
      try { bot.startPolling(); } catch (_) {}
    }, 10000);
  }
});

process.on('unhandledRejection', (err) => {
  log.error(`Unhandled: ${err.message}`);
  if (err.message.includes('ENOTFOUND') || 
      err.message.includes('EHOSTUNREACH') ||
      err.message.includes('EFATAL')) {
    log.info('Сетевая ошибка проигнорирована, продолжаем...');
  }
});

} // end of else (CLI mode check)
