'use strict';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const fs        = require('fs-extra');
const path      = require('path');
const axios     = require('axios');
const XLSX      = require('xlsx');
const cfg       = require('./config');
const Anthropic = require('@anthropic-ai/sdk');
const { VaultIndex, parseTimeExpression, watchVault } = require('./indexer');
const { getConfluence, getJIRA, createConfluencePage, parseWorklog } = require('./integrations');
const guardrails = require('./guardrails');

const POLL_INTERVAL = 2000;
const BASE_URL      = 'https://botapi.messenger.yandex.net/bot/v1';
const STATE_FILE    = '.messenger_bot_state.json';

const agent = new (require('https').Agent)({
  rejectUnauthorized: false,
  keepAlive:          false,
  secureProtocol:     'TLSv1_2_method',
});

const ax = axios.create({
  baseURL:    BASE_URL,
  headers:    { Authorization: 'OAuth ' + cfg.YANDEX_BOT_TOKEN },
  httpsAgent: agent,
  timeout:    20000,
});

const anthropic = new Anthropic({ apiKey: cfg.ANTHROPIC_KEY });

// ── ЦИФРОВОЙ ДВОЙНИК — константы ──
const MY_LOGINS = [
  's.klevtsov',
  'stanislav.klevtsov',
  'stanislav klevtsov',
  'stanislav_klevtsov',
  'klevtsov stanislav',
  'станислав клевцов',
  'клевцов станислав',
  'клевцов',
  'klevtsov',
  'станислав',    // только если в контексте обращения
];

const DIGITAL_TWIN_PROMPT = `Ты цифровой помощник Станислава Клевцова (s.klevtsov@auchan.ru), ведущего Data Scientist команды BigData в Auchan Россия.

Твоя задача: отвечать на вопросы коллег когда они тегают или упоминают Станислава в рабочих чатах.

ДОСТУПНАЯ БАЗА ЗНАНИЙ (только публичные материалы):
{context}

ПРАВИЛА ОТВЕТА:
1. Начинай с "Станислав сейчас недоступен, но могу помочь:"
2. Отвечай ТОЛЬКО на основе предоставленных документов выше
3. Указывай источник: "(источник: название документа, дата)"
4. Если нет информации — скажи честно и предложи написать Станиславу напрямую
5. Если вопрос касается личного/приватного — вежливо откажи
6. Отвечай на языке вопроса (русский/английский)
7. Максимум 5-7 предложений, конкретно и по делу
8. НЕ придумывай — только факты из базы знаний
9. НЕ давай обещаний от имени Станислава

ЗАПРЕЩЕНО: раскрывать личную переписку, зарплаты, конфликты, персональные данные.

Чат: {chat_name}
Спрашивает: {sender} ({login})
Предыдущий контекст чата:
{chat_context}

Вопрос/упоминание: {message}`;

// История чата для контекста (последние 5 сообщений)
const CHAT_HISTORY = new Map();
function addChatHistory(chatId, sender, text) {
  if (!CHAT_HISTORY.has(chatId)) CHAT_HISTORY.set(chatId, []);
  const hist = CHAT_HISTORY.get(chatId);
  hist.push(sender + ': ' + text.slice(0, 100));
  if (hist.length > 5) hist.shift();
}
function getChatContext(chatId) {
  return (CHAT_HISTORY.get(chatId) || []).join('\n');

}

// Детектор упоминания
function isMentioned(text) {
  const lower = text.toLowerCase().trim();

  // Прямое обращение к боту
  if (/^bigdata\b/i.test(lower)) return true;

  // Упоминание по имени/логину (все варианты)
  for (const m of MY_LOGINS) {
    if (lower.includes(m.toLowerCase())) return true;
  }

  // Яндекс-формат упоминания: @login или имя с заглавной в начале
  if (/@s[\.\-_]?klevtsov/i.test(text)) return true;
  if (/stanislav/i.test(text) && /klevtsov/i.test(text)) return true;

  return false;
}

// Тест при запуске
const TEST_PHRASES = [
  '@s.klevtsov привет',
  'Stanislav KLEVTSOV какая версия',
  'станислав клевцов помоги',
  'клевцов есть вопрос',
  'Bigdata что нового',
  's.klevtsov@auchan.ru',
];
console.log('🔍 Тест детектора упоминаний:');
for (const p of TEST_PHRASES)
  console.log('  ' + (isMentioned(p) ? '✅' : '❌') + ' ' + p.slice(0,40));

// Поиск для цифрового двойника — исключаем только явно приватное
async function searchPublicDocs(query) {
  let docs = [];
  try {
    docs = await vaultIndex.searchHybrid(query, { topK: 7 });
  } catch (_) {
    docs = vaultIndex.search(query, { topK: 7 });
  }
  // Фильтруем только явно приватное (письма, личные чаты)
  return docs.filter(function(d) {
    const v = d.visibility || '';
    const t = d.type || '';
    // Явно приватное — пропускаем
    if (v === 'private') return false;
    // Личные письма без разметки — пропускаем
    if (!v && t === 'email') return false;
    // Голосовые без разметки — пропускаем
    if (!v && (t === 'voice_transcript' || t === 'plaud_digest')) return false;
    // Всё остальное — показываем
    return true;
  });
}

// Ответ цифрового двойника
async function digitalTwinResponse(update) {
  const chatId  = update.chat && update.chat.id;
  const text    = (update.text || '').trim();
  const sender  = (update.from && (update.from.display_name || update.from.login)) || 'Коллега';
  const chatCtx = getChatContext(chatId);

  if (!text || !chatId) return;
  console.log('[digital-twin] ' + sender + ': ' + text.slice(0,80));

  // Guardrail — проверка входящего запроса
  const guard = guardrails.checkInput(text);
  if (guard.block) {
    console.log('[digital-twin] Заблокировано guardrails: ' + guard.reason);
    await sendMessage(chatId, guard.message);
    return;
  }

  try {
    // Очищаем от упоминания имени
    const cleanQuery = text
      .replace(/s\.klevtsov/gi, '')
      .replace(/stanislav klevtsov/gi, '')
      .replace(/станислав клевцов/gi, '')
      .replace(/клевцов/gi, '')
      .replace(/bigdata/gi, '')
      .trim() || text;

    // Ищем в базе знаний (файлы диска, технические документы)
    let docs = [];
    try {
      docs = await vaultIndex.searchHybrid(cleanQuery, { topK: 7 });
    } catch (_) {
      docs = vaultIndex.search(cleanQuery, { topK: 7 });
    }
    // Фильтр: показываем public, team, и файлы без метки (disk_file)
    // Скрываем только явно private и письма/голосовые без метки
    docs = docs.filter(function(d) {
      const v = d.visibility || '';
      const t = d.type || '';
      // Явно private — скрываем
      if (v === 'private') return false;
      // public или team — всегда показываем
      if (v === 'public' || v === 'team') return true;
      // Нет метки: письма и голосовые скрываем, файлы диска показываем
      if (!v && t === 'email') return false;
      if (!v && (t === 'voice_transcript' || t === 'plaud_digest')) return false;
      // Файлы диска и прочее без метки — показываем
      return true;
    });
    console.log('[digital-twin] После фильтра visibility: ' + docs.length + ' документов');
    console.log('[digital-twin] Найдено: ' + docs.length + ' документов');

    // Контекст из базы
    const context = docs.length > 0
      ? docs.map(function(d,i){
          var body = d.relevantChunk || (d.body||'').slice(0,400);
          return '['+(i+1)+'] '+(d.title||'')+' ('+(d.type||'')+', '+(d.date||'')+')\n'+body;
        }).join('\n\n---\n\n')
      : '';







    const baseSystem = 'Ты цифровой ИИ-помощник Станислава Клевцова, Data Scientist команды BigData в Auchan. ' +
      'Отвечай на вопросы коллег на основе базы знаний. ' +
      'Если есть информация — дай конкретный ответ. Отвечай на языке вопроса. Максимум 6 предложений.';
    const system = guardrails.getGuardrailSystem(baseSystem);

    const userContent = 'Вопрос от ' + sender + ': ' + text +
      (context ? '\n\nИз базы знаний:\n' + context : '\n\n(В базе знаний релевантных документов не найдено)') +
      (chatCtx ? '\n\nКонтекст чата:\n' + chatCtx : '');









    const answer = await callLLM(
      [{ role: 'user', content: userContent }],
      { system: system, maxTokens: 400 }
    );

    // Guardrail — проверка исходящего ответа
    let safeAnswer = guardrails.checkOutput(answer, docs.length > 0);
    if (guardrails.looksLikeHallucination(safeAnswer, docs.length)) {
      safeAnswer = 'В базе знаний нет точной информации по этому вопросу. Рекомендую обратиться к Станиславу напрямую.';
      console.log('[digital-twin] Возможная галлюцинация — заменено на честный ответ');
    }
    // Дисклеймер для осторожных тем
    if (guard.note) safeAnswer += '\n\nℹ️ ' + guard.note;

    // Источники для прослеживаемости
    if (docs.length > 0) safeAnswer += formatSources(docs);

    await sendMessage(chatId, safeAnswer);
    console.log('[digital-twin] Отправлено: ' + safeAnswer.slice(0,60));

  } catch (e) {
    const status = e.response && e.response.status;
    if (status === 403) {
      console.log('[digital-twin] 403 — нет прав писать в чат: ' + chatId);
      console.log('[digital-twin] Добавьте в .env: FORBIDDEN_CHAT_IDS=' + chatId);
      FORBIDDEN_CHATS.add(chatId);
    } else {
      console.error('[digital-twin] Ошибка:', e.message);
    }
  }
}

// ══════════════════════════════════════════════
//  📋 ПОИСК ПО REQUEST FORM (РФ) ФАЙЛАМ
// ══════════════════════════════════════════════
const RF_TESTING_PATH = process.env.RF_TESTING_PATH || '/00_Project_IS/TESTing.xlsx';
const RF_STATE     = new Map();  // chatId -> {ip, docText, tokens, is}
const RF_DOC_CACHE = new Map();  // link -> docText

const rfAgent = new (require('https').Agent)({ rejectUnauthorized: false, keepAlive: false });
const rfDiskAx = axios.create({
  baseURL: 'https://cloud-api.yandex.net/v1/disk',
  headers: { Authorization: 'OAuth ' + cfg.YANDEX_DISK_TOKEN },
  httpsAgent: rfAgent,
  timeout: 30000,
});

async function rfDownload(linkOrPath) {
  const s = (linkOrPath || '').trim();
  if (!s) throw new Error('пустая ссылка');
  let dlUrl;
  if (s.includes('disk.yandex.ru') || s.includes('yadi.sk')) {
    const m = s.match(/\/client\/disk(\/.+?)(?:\?|$)/);
    if (m) {
      const { data } = await rfDiskAx.get('/resources/download', { params: { path: decodeURIComponent(m[1]) } });
      dlUrl = data.href;
    } else {
      const { data } = await rfDiskAx.get('/public/resources/download', { params: { public_key: s } });
      dlUrl = data.href;
    }
  } else {
    const { data } = await rfDiskAx.get('/resources/download', { params: { path: s.startsWith('/') ? s : '/' + s } });
    dlUrl = data.href;
  }
  const { data: buf } = await axios.get(dlUrl, { responseType: 'arraybuffer', httpsAgent: rfAgent, timeout: 60000, maxRedirects: 5 });
  return Buffer.from(buf);
}

function rfEstimateTokens(text) {
  if (!text) return 0;
  const chars = text.length;
  const cyr = (text.match(/[а-яёА-ЯЁ]/g) || []).length;
  const lat = (text.match(/[a-zA-Z]/g) || []).length;
  const cyrRatio = chars > 0 ? cyr / (cyr + lat + 1) : 0;
  return Math.ceil(chars / (2.5 + (1 - cyrRatio) * 1.5));
}

function rfBuildFullText(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  let text = '';
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
    text += '## Лист: ' + name + '\n' + rows.map(r => r.join(' | ')).join('\n') + '\n\n';
  }
  return text;
}

async function rfGetFileList() {
  const buf = await rfDownload(RF_TESTING_PATH);
  const wb  = XLSX.read(buf, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  const COL = { ip: 1, is: 3, link: 7 };
  const files = [];
  const seen = new Set();
  for (let r = 1; r < rows.length; r++) {
    const ip = String(rows[r][COL.ip]||'').trim();
    const is = String(rows[r][COL.is]||'').trim();
    const link = String(rows[r][COL.link]||'').trim();
    if (!link || seen.has(link)) continue;
    seen.add(link);
    files.push({ ip, is, link });
  }
  return files;
}

function rfChunkText(text, maxChars = 40000, overlap = 2000) {
  if (text.length <= maxChars) return [text];
  const chunks = [];
  for (let i = 0; i < text.length; i += maxChars - overlap) {
    chunks.push(text.slice(i, i + maxChars));
    if (i + maxChars >= text.length) break;
  }
  return chunks;
}

function rfScoreChunk(chunk, question) {
  const words = question.toLowerCase().match(/[а-яёa-z0-9]{3,}/g) || [];
  const lower = chunk.toLowerCase();
  let score = 0;
  for (const w of words) score += lower.split(w).length - 1;
  return score;
}

async function rfAskLLM(docText, question, chatId) {
  const SAFE_CHARS = 40000;
  const system = 'Ты помощник для анализа Request Form на ИС. Отвечай ТОЛЬКО по документу, конкретно, на русском. Если данных нет — скажи об этом.';
  if (docText.length <= SAFE_CHARS) {
    return callLLM([{ role: 'user', content: 'ДОКУМЕНТ:\n' + docText + '\n\nВОПРОС: ' + question }],
      { system, maxTokens: 800, chatId });
  }
  const chunks = rfChunkText(docText, SAFE_CHARS);
  const scored = chunks.map(function(c,i){ return { chunk:c, score:rfScoreChunk(c,question), idx:i }; })
    .sort(function(a,b){ return b.score-a.score; });
  const selected = scored.filter(function(s){ return s.score>0; }).slice(0,2);
  const use = selected.length ? selected : [scored[0]];
  const partial = [];
  for (const s of use) {
    try {
      const ans = await callLLM([{ role:'user', content:'ДОКУМЕНТ (фрагмент):\n'+s.chunk+'\n\nВОПРОС: '+question+'\nЕсли нет ответа — "нет данных".' }],
        { system, maxTokens: 400, chatId });
      if (ans && !/^нет данных/i.test(ans.trim())) partial.push(ans);
    } catch (_) {}
  }
  if (!partial.length) return 'В документе не найдено информации по этому вопросу.';
  if (partial.length === 1) return partial[0];
  return callLLM([{ role:'user', content:'Объедини ответы из частей документа в один на вопрос "'+question+'":\n\n'+partial.join('\n\n---\n\n') }],
    { maxTokens: 600, chatId });
}

// ── STATE ──
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (_) { return { offset: 0, dialogs: {}, models: {} }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

const STATE = loadState();
STATE.dialogs = STATE.dialogs || {};
STATE.models  = STATE.models  || {};

const USER_LOGIN_MAP = {};

function getDialog(chatId)  { return STATE.dialogs[chatId] || []; }
function addToDialog(chatId, role, content) {
  STATE.dialogs[chatId] = STATE.dialogs[chatId] || [];
  STATE.dialogs[chatId].push({ role, content: content.slice(0, 2000) });
  STATE.dialogs[chatId] = STATE.dialogs[chatId].slice(-8);
  saveState(STATE);
}
function clearDialog(chatId) { STATE.dialogs[chatId] = []; saveState(STATE); }
function getModel(chatId)    { return (STATE.models || {})[chatId] || 'haiku'; }
function setModel(chatId, m) { STATE.models = STATE.models || {}; STATE.models[chatId] = m; saveState(STATE); }

// ── MODELS ──
const MODELS = {
  haiku:  { name: 'Claude Haiku',        provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  llama:  { name: 'Llama 3.1 8B (Groq)', provider: 'groq',      model: 'llama-3.1-8b-instant' },
  auchan: { name: 'Auchan LLM (Corp)',    provider: 'auchan',    model: 'auchan-llm' },
};

// ── AUCHAN RETRY ──
async function callAuchan(messages, opts) {
  const maxRetries  = (opts && opts.maxRetries)  || 3;
  const retryDelay  = (opts && opts.retryDelay)  || 2000;
  const maxTokens   = (opts && opts.maxTokens)   || 150;
  const temperature = (opts && opts.temperature) || 0.7;

  if (!cfg.AUCHAN_BEARER) throw new Error('AUCHAN_BEARER не задан в .env');
  const auchanAgent = new (require('https').Agent)({ rejectUnauthorized: false });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { data } = await axios.post(cfg.AUCHAN_LLM_URL,
        { messages, max_tokens: maxTokens, temperature, stream: false },
        {
          headers: {
            'X-Gravitee-Api-Key': cfg.AUCHAN_API_KEY,
            'Authorization':      'Bearer ' + cfg.AUCHAN_BEARER,
            'Content-Type':       'application/json',
          },
          httpsAgent: auchanAgent,
          timeout:    120000,
        }
      );
      const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content)
        || data.content || data.message || data.response
        || (typeof data === 'string' ? data : JSON.stringify(data).slice(0, 500));
      return { text, usage: data.usage || {} };
    } catch (e) {
      const status = e.response && e.response.status;
      if (status === 504 || status >= 500 ||
          e.code === 'ECONNABORTED' || (e.message && e.message.includes('timeout'))) {
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, retryDelay));
          continue;
        }
      }
      if (status >= 400 && status < 500) {
        const desc = (e.response && e.response.data && (e.response.data.error || e.response.data.message)) || e.message;
        throw new Error('Auchan ' + status + ': ' + desc);
      }
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, retryDelay));
        continue;
      }
      throw e;
    }
  }
  throw new Error('Auchan LLM: исчерпаны все попытки');
}

// ── LLM ──
async function callLLM(messages, opts) {
  const system    = (opts && opts.system)    || '';
  const maxTokens = (opts && opts.maxTokens) || 800;
  const chatId    = (opts && opts.chatId)    || null;
  const modelKey  = chatId ? getModel(chatId) : 'haiku';
  const mdl       = MODELS[modelKey] || MODELS.haiku;

  if (mdl.provider === 'anthropic') {
    const resp = await anthropic.messages.create({
      model: mdl.model, max_tokens: maxTokens, system, messages,
    });
    return resp.content[0].text;

  } else if (mdl.provider === 'groq') {
    if (!cfg.GROQ_KEY) throw new Error('GROQ_KEY не задан в .env');
    const msgs = system ? [{ role: 'system', content: system }].concat(messages) : messages;
    const { data } = await axios.post(cfg.GROQ_CHAT_URL,
      { model: mdl.model, messages: msgs, max_tokens: maxTokens },
      { headers: { Authorization: 'Bearer ' + cfg.GROQ_KEY }, httpsAgent: agent }
    );
    return data.choices[0].message.content;

  } else if (mdl.provider === 'auchan') {
    const msgs   = system ? [{ role: 'system', content: system }].concat(messages) : messages;
    const result = await callAuchan(msgs, { maxTokens });
    return result.text;
  }
  throw new Error('Неизвестная модель: ' + modelKey);
}

// ── LANGUAGE DETECTION ──
function detectLanguage(text) {
  const cyr   = (text.match(/[а-яёА-ЯЁ]/g) || []).length;
  const lat   = (text.match(/[a-zA-Z]/g)    || []).length;
  const total = cyr + lat;
  if (total === 0) return 'ru';
  return (cyr / total) > 0.3 ? 'ru' : 'en';
}

function getSystemPrompt(lang) {
  if (lang === 'en')
    return 'You are a personal AI assistant. Answer in English, concisely. Use information from the provided documents.';
  return 'Ты личный ИИ-ассистент. Отвечай на русском, конкретно и кратко. Используй информацию из документов базы знаний.';
}

// ── RAG ──
function formatContext(docs, maxChars) {
  maxChars = maxChars || 3000;
  let out = '', total = 0;
  for (let i = 0; i < docs.length; i++) {
    const d     = docs[i];
    const chunk = '[' + (i+1) + '] ' + d.title + ' (' + d.type + ', ' + (d.date||'') + ')\n' +
                  (d.body || '').slice(0, 400) + '\n';
    if (total + chunk.length > maxChars) break;
    out   += chunk + '\n---\n';
    total += chunk.length;
  }
  return out || 'Документы не найдены.';
}

async function ragAnswer(question, chatId) {
  const { dateFrom, dateTo, cleaned } = parseTimeExpression(question);
  const history = getDialog(chatId);
  let docs = [];
  try {
    docs = await vaultIndex.searchHybrid(cleaned || question, { topK: 5, dateFrom, dateTo });
  } catch (_) {
    docs = vaultIndex.search(cleaned || question, { topK: 5, dateFrom, dateTo });
  }
  const context = formatContext(docs);
  const lang    = detectLanguage(question);
  const answer  = await callLLM(
    history.concat([{ role: 'user', content: 'Вопрос: ' + question + '\n\nДокументы:\n' + context }]),
    { system: getSystemPrompt(lang), maxTokens: 600, chatId }
  );
  addToDialog(chatId, 'user', question);
  addToDialog(chatId, 'assistant', answer);
  // Прослеживаемость — источники
  return answer + formatSources(docs);
}

// Форматирование источников
function formatSources(docs) {
  if (!docs || !docs.length) return '';
  const icons = { email:'📧', messenger_chat:'💬', voice_transcript:'🎙️', disk_file:'💾', contact:'👤' };
  const lines = ['\n\n📎 Источники:'];
  for (let i = 0; i < Math.min(docs.length, 5); i++) {
    const d = docs[i];
    const icon = icons[d.type] || '📄';
    const date = d.date ? ' (' + d.date + ')' : '';
    const loc  = (d.folder || d.path || '').slice(0, 40);
    lines.push('[' + (i+1) + '] ' + icon + ' ' + (d.title||'').slice(0,50) + date + (loc ? ' — ' + loc : ''));
  }
  return lines.join('\n');
}

// ── MENU ──
function mainMenuText() {
  const lines = [
    '',
    'Команды:',
    '/search <запрос>   — поиск в базе знаний',
    '/last              — последние события',
    '/digest            — дайджест недели',
    '/tasks             — задачи и дедлайны',
    '/insights          — проактивные инсайты',
    '/contacts          — топ контактов',
    '/analytics         — аналитика активности',
    '/stats             — статистика vault',
    '/security          — ИБ дайджест',
    '/pii               — сканирование персданных',
    '/classify <запрос> — классификация документов',
    '/person Имя        — всё по человеку',
    '/where             — папки для поиска',
    '/model             — выбор LLM модели',
    '/checktoken        — статус токенов',
    '/risk              — дашборд рисков ИБ',
    '/graph             — граф внешних коммуникаций',
    '/anomaly           — аномалии активности',
    '/patterns          — паттерны коммуникации',
    '/sentiment         — тональность переписки',
    '/processes         — классификация по процессам',
    '/duplicates        — дубликаты документов',
    '/rf                — поиск по Request Form файлам',
    '/fillrf            — заполнить TESTing.xlsx по rf_list (с прогрессом)',
    '/embcheck          — проверка embedding/rerank',
    '/heatmap           — тепловая карта активности',
    '/trend             — тренд ИБ инцидентов',
    '/depts             — риски по отделам',
    '/ibreport          — полный ИБ отчёт',
    '/audit             — лог доступов',
    '/jira              — задачи JIRA',
    '/confluence        — страницы Confluence',
    '/sync              — синхронизация данных',
    '/refresh           — переиндексация vault',
    '/clear             — очистить историю',
    '',
    'Или напишите вопрос (рус / English)',
  ];
  return lines.join('\n');
}

// ── SEND MESSAGE ──
// Чаты где нет прав — не спамим
// Можно задать заранее в .env: FORBIDDEN_CHAT_IDS=id1,id2,id3
const FORBIDDEN_CHATS = new Set(
  (process.env.FORBIDDEN_CHAT_IDS || '').split(',').filter(Boolean)
);

async function sendMessage(chatId, text) {
  if (!text) return;

  // Чат заблокирован — молча пропускаем
  if (FORBIDDEN_CHATS.has(chatId)) return;

  const MAX     = 4000;
  const isGroup = chatId && (chatId.startsWith('0/') || chatId.includes('/22/'));
  const login   = !isGroup ? USER_LOGIN_MAP[chatId] : null;

  for (let i = 0; i < text.length; i += MAX) {
    const chunk   = text.slice(i, i + MAX);
    const payload = { text: chunk };
    if (login)   payload.login   = login;
    else         payload.chat_id = chatId;

    try {
      await ax.post('/messages/sendText/', payload);
    } catch (e) {
      const status = e.response && e.response.status;
      const errMsg = e.response && e.response.data && e.response.data.error && e.response.data.error.message;

      // 403 — нет прав на отправку в этот чат
      if (status === 403) {
        console.log('   ⚠️  Нет прав в чате ' + chatId.slice(0, 30) + ' — пропускаем');
        FORBIDDEN_CHATS.add(chatId);
        return;
      }

      // 400 — пробуем альтернативный формат
      if (status === 400) {
        const alt = { text: chunk };
        if (payload.login) alt.chat_id = chatId;
        else if (USER_LOGIN_MAP[chatId]) alt.login = USER_LOGIN_MAP[chatId];
        else alt.chat_id = chatId;
        try {
          await ax.post('/messages/sendText/', alt);
        } catch (e2) {
          const s2 = e2.response && e2.response.status;
          if (s2 === 403) { FORBIDDEN_CHATS.add(chatId); return; }
        }
      } else {
        throw e;
      }
    }
    if (i + MAX < text.length) await new Promise(r => setTimeout(r, 300));
  }
  console.log('   -> ' + chatId.slice(0, 20) + '...');
}

// ── SAVE TO VAULT ──
async function saveToVault(update) {
  try {
    const chatId   = update.chat && update.chat.id;
    const chatType = (update.chat && update.chat.type) || 'private';
    const sender   = (update.from && (update.from.display_name || update.from.login)) || 'Unknown';
    const text     = (update.text || '').trim();
    const ts       = update.timestamp ? new Date(update.timestamp * 1000) : new Date();
    const dateStr  = ts.toISOString().slice(0, 10);
    const timeStr  = ts.toISOString().replace('T', ' ').slice(0, 16);
    const chatName = chatType === 'private'
      ? sender
      : 'group_' + chatId.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);

    const vaultDir = path.join(cfg.VAULT_PATH, '02_Messenger',
      chatType === 'private' ? 'Личные' : 'Группы');
    fs.ensureDirSync(vaultDir);

    const filePath = path.join(vaultDir, chatName + '.md');
    let fileContent = '';

    if (fs.existsSync(filePath)) {
      fileContent = fs.readFileSync(filePath, 'utf8');
      fileContent = fileContent.replace(/^date: .+/m, 'date: "' + dateStr + '"');
    } else {
      fileContent = '---\ntype: messenger_chat\nchat_type: ' + chatType +
        '\nchat_id: "' + chatId + '"\nchat_name: "' + chatName +
        '"\nsource: yandex_messenger\ndate: "' + dateStr + '"\n---\n\n# ' + chatName + '\n';
    }
    if (text) {
      fileContent += '\n**' + sender + '** `' + timeStr + '`\n> ' + text + '\n';
      fs.writeFileSync(filePath, fileContent, 'utf8');
    }
  } catch (e) {
    console.error('   Vault save error:', e.message);
  }
}

// ── API ──
async function getUpdates(offset) {
  const { data } = await ax.get('/messages/getUpdates/', { params: { limit: 100, offset } });
  return data.updates || [];
}

// ── VOICE HANDLER ──
async function handleVoice(update) {
  const chatId = update.chat && update.chat.id;
  if (!chatId) return;
  if (!cfg.GROK_KEY) { await sendMessage(chatId, 'GROK_KEY не настроен'); return; }

  await sendMessage(chatId, 'Получил голосовое, расшифровываю...');
  try {
    const fileUrl = (update.voice && update.voice.url) || (update.audio && update.audio.url);
    if (!fileUrl) { await sendMessage(chatId, 'Не могу получить аудиофайл'); return; }

    const os      = require('os');
    const tmpOgg  = path.join(os.tmpdir(), 'voice_' + Date.now() + '.ogg');
    const tmpMp3  = tmpOgg.replace('.ogg', '.mp3');

    const { data: stream } = await axios.get(fileUrl, { responseType: 'stream', httpsAgent: agent });
    await new Promise((res, rej) => {
      const ws = require('fs').createWriteStream(tmpOgg);
      stream.pipe(ws);
      ws.on('finish', res); ws.on('error', rej);
    });

    const { execFile } = require('child_process');
    const ffmpegPaths  = ['/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', 'ffmpeg'];
    const ffmpeg       = ffmpegPaths.find(p => { try { require('fs').accessSync(p); return true; } catch (_) { return false; } });
    await new Promise(res => execFile(ffmpeg || 'ffmpeg',
      ['-i', tmpOgg, '-ar', '16000', '-ac', '1', '-q:a', '2', tmpMp3, '-y'], () => res()));

    const FormData = require('form-data');
    const form     = new FormData();
    const audioFile = require('fs').existsSync(tmpMp3) ? tmpMp3 : tmpOgg;
    form.append('file', require('fs').createReadStream(audioFile), { filename: 'voice.mp3', contentType: 'audio/mpeg' });
    form.append('model',    'grok-stt');
    form.append('language', 'ru');

    const sttAgent = new (require('https').Agent)({ rejectUnauthorized: false });
    const { data: sttData } = await axios.post(cfg.GROK_STT_URL, form, {
      headers: Object.assign({}, form.getHeaders(), { Authorization: 'Bearer ' + cfg.GROK_KEY }),
      httpsAgent: sttAgent, timeout: 60000,
    });

    const text = sttData.text || (sttData.segments && sttData.segments.map(s => s.text).join(' ')) || '';
    if (!text) { await sendMessage(chatId, 'Не удалось распознать речь'); return; }

    await sendMessage(chatId, 'Распознано: "' + text + '"\n\nИщу в базе знаний...');
    const answer = await ragAnswer(text, chatId);
    await sendMessage(chatId, answer);
    await saveToVault(Object.assign({}, update, { text }));

    for (const f of [tmpOgg, tmpMp3]) { try { require('fs').unlinkSync(f); } catch (_) {} }
  } catch (e) {
    console.error('Voice error:', e.message);
    await sendMessage(chatId, 'Ошибка распознавания: ' + e.message.slice(0, 80));
  }
}

// ── COMMAND HANDLER ──
async function handleCommand(cmd, chatId, text) {
  const args = text.slice(cmd.length).trim();

  switch (cmd) {
    case '/start':
    case '/help': {
      const stats     = vaultIndex.stats();
      const cur       = getModel(chatId);
      const lastEmail = vaultIndex.docs.filter(d => d.type === 'email' && d.date)
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      const lastFile  = vaultIndex.docs.filter(d => d.type === 'disk_file' && d.date)
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      const lastChat  = vaultIndex.docs.filter(d => d.type === 'messenger_chat')
        .sort((a, b) => (b.date||'').localeCompare(a.date||''))[0];

      const lines = [
        'Привет! Я ваш персональный ИИ-ассистент',
        '',
        'База знаний: ' + stats.total + ' заметок',
        'Email: ' + (stats.by_type.email||0) + '  Диск: ' + (stats.by_type.disk_file||0) + '  Чаты: ' + (stats.by_type.messenger_chat||0),
        'Модель: ' + ((MODELS[cur] && MODELS[cur].name) || cur),
        '',
        'Последние события:',
      ];
      if (lastEmail)
        lines.push('  Email ' + lastEmail.date + ': ' + (lastEmail.subject||lastEmail.title||'').slice(0,50));
      if (lastFile)
        lines.push('  Файл ' + lastFile.date + ': ' + (lastFile.title||'').slice(0,50));
      if (lastChat) {
        const lastMsg = (lastChat.body||'').split('\n').reverse().find(l => l.startsWith('> '));
        lines.push('  Чат ' + (lastChat.chatName||lastChat.title) + ': ' + (lastMsg ? lastMsg.slice(2,60) : ''));
      }

      if (chatId) {
        await sendMessage(chatId, lines.join('\n') + mainMenuText());
        return null;
      }
      return lines.join('\n');
    }

    case '/search': {
      if (!args) return 'Укажите запрос: /search <текст>';
      const { dateFrom, dateTo, cleaned } = parseTimeExpression(args);
      let docs = [];
      try { docs = await vaultIndex.searchHybrid(cleaned||args, { topK:5, dateFrom, dateTo }); }
      catch (_) { docs = vaultIndex.search(cleaned||args, { topK:5, dateFrom, dateTo }); }
      if (!docs.length) return 'Ничего не найдено: ' + args;
      const em = { email:'Email', messenger_chat:'Чат', voice_transcript:'Голос', disk_file:'Файл' };
      let out = 'Поиск: ' + args + '\n\n';
      for (const d of docs) {
        out += (em[d.type]||'Doc') + ': ' + d.title + '\n';
        if (d.date) out += '  ' + d.date + '\n';
        out += '  ' + (d.body||'').slice(0,80).replace(/\n/g,' ') + '...\n\n';
      }
      return out;
    }

    case '/last': {
      const lines = [];
      const emails = vaultIndex.docs.filter(d => d.type==='email'&&d.date)
        .sort((a,b) => b.date.localeCompare(a.date)).slice(0,5);
      if (emails.length) {
        lines.push('Последние письма:');
        for (const e of emails)
          lines.push('  ' + e.date + '  ' + (e.subject||e.title||'').slice(0,50));
        lines.push('');
      }
      const disks = vaultIndex.docs.filter(d => d.type==='disk_file'&&d.date)
        .sort((a,b) => b.date.localeCompare(a.date)).slice(0,5);
      if (disks.length) {
        lines.push('Последние файлы на диске:');
        for (const d of disks)
          lines.push('  ' + d.date + '  ' + (d.title||'').slice(0,50));
        lines.push('');
      }
      const chats = vaultIndex.docs.filter(d => d.type==='messenger_chat')
        .sort((a,b) => (b.date||'').localeCompare(a.date||'')).slice(0,3);
      if (chats.length) {
        lines.push('Последние чаты:');
        for (const c of chats) {
          const lastMsg = (c.body||'').split('\n').reverse().find(l => l.startsWith('> '));
          lines.push('  ' + (c.chatName||c.title) + '  ' + (c.date||''));
          if (lastMsg) lines.push('    ' + lastMsg.slice(2,70));
        }
        lines.push('');
      }
      const plauds = vaultIndex.docs.filter(d => d.type==='voice_transcript'&&d.date)
        .sort((a,b) => b.date.localeCompare(a.date)).slice(0,1);
      if (plauds.length) {
        lines.push('Последняя запись Plaud:');
        lines.push('  ' + plauds[0].date + '  ' + (plauds[0].title||'').slice(0,50));
      }
      return lines.join('\n') || 'Данных пока нет.';
    }

    case '/digest': {
      await sendMessage(chatId, 'Генерирую дайджест недели...');
      try {
        const sections = [];
        const emails   = vaultIndex.getRecent('email', 7);
        if (emails.length) {
          const r = await callLLM([{ role:'user', content:
            'Краткий дайджест писем за неделю (3-5 пунктов):\n' + formatContext(emails.slice(0,8), 1500) }],
            { maxTokens: 400, chatId });
          sections.push('Email:\n' + r);
        }
        const taskDocs = ['email','messenger_chat','voice_transcript']
          .reduce((acc, t) => acc.concat(vaultIndex.getRecent(t,7)), []).slice(0,10);
        if (taskDocs.length) {
          const r = await callLLM([{ role:'user', content:
            'Задачи и дедлайны:\n' + formatContext(taskDocs,1000) + '\n\nВыдай список: - [ ] задача' }],
            { maxTokens: 300, chatId });
          sections.push('Задачи:\n' + r);
        }
        const contacts  = vaultIndex.getTopContacts(5);
        const recent3   = vaultIndex.getRecent(null,3).map(d => (d.from||'').toLowerCase());
        const silent    = contacts
          .filter(c => !recent3.some(f => f.includes(c.email.toLowerCase()))).slice(0,3);
        if (silent.length)
          sections.push('Давно не общались:\n' + silent.map(c => '  ' + c.name).join('\n'));

        return ('Дайджест за неделю (' + new Date().toLocaleDateString('ru') + ')\n\n' +
          sections.join('\n\n')).slice(0, 4000);
      } catch (e) { return 'Ошибка: ' + e.message; }
    }

    case '/tasks': {
      await sendMessage(chatId, 'Ищу задачи...');
      try {
        const docs = ['email','messenger_chat','voice_transcript']
          .reduce((acc,t) => acc.concat(vaultIndex.getRecent(t,30)), []).slice(0,12);
        return await callLLM([{ role:'user', content:
          'Задачи и дедлайны:\n' + formatContext(docs) +
          '\n\nЗАДАЧИ:\n- [ ] ...\nДЕДЛАЙНЫ:\n- ...\nДОГОВОРЁННОСТИ:\n- ...' }],
          { maxTokens: 800, chatId });
      } catch (e) { return 'Ошибка: ' + e.message; }
    }

    case '/stats': {
      const s   = vaultIndex.stats();
      const cur = getModel(chatId);
      let out   = 'База знаний: ' + s.total + ' заметок\n\n';
      for (const [t, n] of Object.entries(s.by_type).sort((a,b) => b[1]-a[1]))
        out += t + ': ' + n + '\n';
      out += '\nМодель: ' + ((MODELS[cur]&&MODELS[cur].name)||cur);
      return out;
    }

    case '/insights': {
      await sendMessage(chatId, 'Анализирую базу знаний...');
      try {
        const lines    = ['Инсайты:\n'];
        const contacts = vaultIndex.getTopContacts(10);
        const recent7  = vaultIndex.getRecent(null, 7);
        const fromSet  = new Set(recent7.map(d => (d.from||'').toLowerCase()));
        const silent   = contacts.filter(c => c.count>=2 && !fromSet.has(c.email.toLowerCase())).slice(0,3);
        if (silent.length) {
          lines.push('Давно не общались:');
          for (const c of silent) lines.push('  ' + c.name + ' (' + c.count + ' писем)');
          lines.push('');
        }
        const topicCnt = {};
        for (const d of recent7) {
          for (const w of ((d.subject||'').toLowerCase().match(/[а-яa-z]{5,}/g)||[]))
            topicCnt[w] = (topicCnt[w]||0)+1;
        }
        const hot = Object.entries(topicCnt).filter(([,c]) => c>=2).sort((a,b)=>b[1]-a[1]).slice(0,5);
        if (hot.length) {
          lines.push('Горячие темы:');
          for (const [w,c] of hot) lines.push('  ' + w + ' (' + c + ' раз)');
          lines.push('');
        }
        const ctx  = formatContext(recent7.slice(0,8), 1500);
        const resp = await callLLM([{ role:'user', content:
          'Проактивные инсайты:\n' + ctx + '\n\n1) дедлайны 2) незакрытые вопросы 3) важные контакты' }],
          { maxTokens:400, chatId });
        lines.push('AI инсайты:\n' + resp);
        return lines.join('\n') || 'Всё спокойно.';
      } catch (e) { return 'Ошибка: ' + e.message; }
    }

    case '/contacts': {
      const contacts = vaultIndex.getTopContacts(10);
      if (!contacts.length) return 'Контакты не найдены.';
      let out = 'Топ контактов:\n\n';
      for (let i=0; i<contacts.length; i++) {
        const c   = contacts[i];
        const bar = '|'.repeat(Math.min(Math.floor(c.count/3), 10));
        out += (i+1) + '. ' + c.name.slice(0,30) + '\n   ' + bar + ' ' + c.count + ' писем\n';
      }
      return out;
    }

    case '/analytics': {
      const s       = vaultIndex.getActivityStats();
      const lines   = ['Аналитика vault\n'];
      const months  = Object.entries(s.byMonth).slice(-6);
      const maxM    = Math.max.apply(null, months.map(function(x){return x[1];}), 1);
      lines.push('По месяцам:');
      for (const [m,n] of months)
        lines.push(m + '  ' + '|'.repeat(Math.round(n/maxM*12)) + ' ' + n);
      const folders = Object.entries(s.byFolder).slice(0,5);
      const maxF    = Math.max.apply(null, folders.map(function(x){return x[1];}), 1);
      lines.push('\nТоп папок:');
      for (const [f,n] of folders)
        lines.push(f.slice(0,20) + '  ' + '|'.repeat(Math.round(n/maxF*10)) + ' ' + n);
      lines.push('\nГорячие темы:');
      lines.push(Object.entries(s.topTopics).slice(0,8).map(function(x){return x[0]+'('+x[1]+')';}).join(', '));
      return lines.join('\n');
    }

    case '/security': {
      await sendMessage(chatId, 'Формирую ИБ дайджест...');
      try {
        const recent  = vaultIndex.getRecent('email', 7);
        const SEC_KW  = ['инцидент','взлом','утечка','доступ','пароль','уязвимость','incident','breach'];
        const secMsgs = recent.filter(d => {
          const t = ((d.subject||'') + ' ' + (d.body||'').slice(0,300)).toLowerCase();
          return SEC_KW.some(k => t.includes(k));
        });
        let text = 'ИБ Дайджест\n\n';
        if (secMsgs.length) {
          text += 'Письма с ИБ тематикой (' + secMsgs.length + '):\n';
          for (const m of secMsgs.slice(0,5))
            text += '  ' + m.date + '  ' + (m.subject||'').slice(0,50) + '\n';
        } else {
          text += 'Писем с ИБ тематикой нет\n';
        }
        return text;
      } catch (e) { return 'Ошибка: ' + e.message; }
    }

    case '/pii': {
      await sendMessage(chatId, 'Сканирую на персданные...');
      try {
        const PII_PATTERNS = [
          { name: 'Банк. карта', pattern: '\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}' },
          { name: 'Телефон',     pattern: '(?:\\+7|8)[\\s-]?\\(?\\d{3}\\)?[\\s-]?\\d{3}[\\s-]?\\d{2}[\\s-]?\\d{2}' },
          { name: 'Email',       pattern: '[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}' },
          { name: 'СНИЛС',       pattern: '\\d{3}-\\d{3}-\\d{3}\\s?\\d{2}' },
        ];
        const results = [];
        const docs = vaultIndex.docs.filter(d => ['disk_file','email'].includes(d.type)).slice(0,50);
        for (const doc of docs) {
          const body  = doc.body || '';
          const found = [];
          for (const p of PII_PATTERNS) {
            const re = new RegExp(p.pattern, 'g');
            const m  = body.match(re);
            if (m) {
              const masked = m[0].slice(0,4) + '****';
              found.push(p.name + ': ' + masked);
            }
          }
          if (found.length)
            results.push((doc.title||'').slice(0,40) + '\n  ' + found.join(', '));
        }
        if (!results.length) return 'PII не обнаружено';
        return 'PII в ' + results.length + ' документах:\n\n' + results.slice(0,10).join('\n\n');
      } catch (e) { return 'Ошибка: ' + e.message; }
    }

    case '/classify': {
      if (!args) return 'Укажите запрос: /classify <текст>';
      const docs = vaultIndex.search(args, { topK:5 });
      if (!docs.length) return 'Не найдено: ' + args;
      let out = 'Классификация: ' + args + '\n\n';
      for (const doc of docs) {
        const t = ((doc.title||'') + ' ' + (doc.body||'').slice(0,500)).toLowerCase();
        let level = 'ОТКРЫТОЕ';
        if (/секретно|top secret/i.test(t))          level = 'СЕКРЕТНО';
        else if (/конфиденциально|confidential/i.test(t)) level = 'КОНФИДЕНЦИАЛЬНО';
        else if (/внутреннее|internal/i.test(t))     level = 'ВНУТРЕННЕЕ';
        out += level + '\n' + (doc.title||'').slice(0,50) + '\n  Тип: ' + doc.type + '  Дата: ' + (doc.date||'—') + '\n\n';
      }
      return out;
    }

    case '/person': {
      if (!args) return 'Укажите имя: /person Иванов';
      const docs = vaultIndex.searchByPerson(args);
      if (!docs.length) return 'Ничего по: ' + args;
      let out = args + '\n\n';
      for (const d of docs.slice(0,5))
        out += (d.type==='email'?'Email':'Чат') + ' ' + (d.date||'') + ': ' + (d.subject||d.title||'').slice(0,50) + '\n';
      return out;
    }

    case '/where': {
      const folders = vaultIndex.getFolders ? vaultIndex.getFolders() : {};
      const lines   = ['Папки для поиска:\n'];
      for (const [section, items] of Object.entries(folders)) {
        if (items && items.length) {
          lines.push(section + ':');
          for (const item of items.slice(0,5)) lines.push('  ' + item);
        }
      }
      lines.push('\nИспользуйте: /search <запрос>');
      return lines.join('\n');
    }

    case '/model': {
      if (!args) {
        const cur  = getModel(chatId);
        const list = Object.entries(MODELS)
          .map(function(e) { return (e[0]===cur?'[x] ':'[ ] ') + e[1].name + ' — /model ' + e[0]; })
          .join('\n');
        return 'Модель: ' + ((MODELS[cur]&&MODELS[cur].name)||cur) + '\n\n' + list;
      }
      if (MODELS[args]) {
        setModel(chatId, args);
        return 'Модель изменена: ' + MODELS[args].name;
      }
      return 'Неизвестная модель: ' + args + '\nДоступные: ' + Object.keys(MODELS).join(', ');
    }

    case '/checktoken': {
      await sendMessage(chatId, 'Проверяю токены...');
      const checks = [];
      try {
        await anthropic.messages.create({ model:'claude-haiku-4-5-20251001', max_tokens:5, messages:[{role:'user',content:'ping'}] });
        checks.push('OK Anthropic Claude');
      } catch (e) { checks.push('FAIL Anthropic: ' + e.message.slice(0,40)); }
      try {
        await axios.post(cfg.GROQ_CHAT_URL,
          { model:'llama-3.1-8b-instant', messages:[{role:'user',content:'ping'}], max_tokens:5 },
          { headers:{ Authorization:'Bearer '+cfg.GROQ_KEY }, httpsAgent:agent });
        checks.push('OK Groq (Llama)');
      } catch (e) { checks.push('FAIL Groq: ' + e.message.slice(0,40)); }
      try {
        await axios.get('https://cloud-api.yandex.net/v1/disk/',
          { headers:{ Authorization:'OAuth '+cfg.YANDEX_DISK_TOKEN }, httpsAgent:agent });
        checks.push('OK Яндекс Диск');
      } catch (e) { checks.push('FAIL Диск: ' + e.message.slice(0,40)); }
      try {
        await ax.get('/messages/getUpdates/', { params:{ limit:1, offset:0 } });
        checks.push('OK Яндекс Мессенджер');
      } catch (e) { checks.push('FAIL Мессенджер: ' + e.message.slice(0,40)); }
      return 'Статус токенов:\n\n' + checks.join('\n');
    }

    case '/audit': {
      try {
        const AUDIT = './vault_audit.log';
        if (!require('fs').existsSync(AUDIT)) return 'Аудит лог пуст.';
        const raw  = require('fs').readFileSync(AUDIT, 'utf8').split('\n').filter(Boolean);
        const last = raw.slice(-20).reverse().map(function(l) {
          try { const e = JSON.parse(l); return e.ts.slice(0,16) + ' ' + e.action + ' ' + (e.detail||''); }
          catch (_) { return l; }
        }).join('\n');
        return ('Последние 20 событий:\n\n' + last).slice(0, 4000);
      } catch (e) { return 'Ошибка: ' + e.message; }
    }

    case '/sync': {
      if (!args) {
        await sendMessage(chatId, [
          'Синхронизация — выберите источник:',
          '',
          '/sync email     — только почта',
          '/sync disk      — только диск',
          '/sync messenger — только мессенджер',
          '/sync plaud     — только Plaud',
          '/sync all       — всё сразу',
          '/sync force     — всё принудительно',
        ].join('\n'));
        return null;
      }
      const source = args.toLowerCase();
      await sendMessage(chatId, 'Запускаю синхронизацию: ' + source + '...');
      try {
        const { syncEmail, syncDisk, syncMessenger, syncPlaud } = require('./syncer');
        if (source==='email'||source==='all'||source==='force') {
          try {
            const r = await syncEmail(cfg.VAULT_PATH, {});
            await sendMessage(chatId, 'Email: +' + r.new + ' новых, ошибок: ' + r.errors);
          } catch (e) { await sendMessage(chatId, 'Email ошибка: ' + e.message); }
        }
        if (source==='disk'||source==='all'||source==='force') {
          try {
            const r = await syncDisk(cfg.VAULT_PATH, { force: source==='force',
              onProgress: async function(cur,total) { if(cur%20===0) await sendMessage(chatId, 'Диск: '+cur+'/'+total+'...'); }
            });
            await sendMessage(chatId, 'Диск: +' + r.new + ' новых, пропущено: ' + r.skipped);
          } catch (e) { await sendMessage(chatId, 'Диск ошибка: ' + e.message); }
        }
        if (source==='messenger'||source==='all'||source==='force') {
          try {
            const r = await syncMessenger(cfg.VAULT_PATH);
            await sendMessage(chatId, 'Мессенджер: +' + r.new + ' новых');
          } catch (e) { await sendMessage(chatId, 'Мессенджер ошибка: ' + e.message); }
        }
        if (source==='plaud'||source==='all'||source==='force') {
          try {
            const r = await syncPlaud(cfg.VAULT_PATH, cfg.ANTHROPIC_KEY);
            await sendMessage(chatId, 'Plaud: +' + r.processed + ' записей');
          } catch (e) { await sendMessage(chatId, 'Plaud ошибка: ' + e.message); }
        }
        vaultIndex = new VaultIndex(cfg.VAULT_PATH);
        return 'Синхронизация завершена!\nВсего заметок: ' + vaultIndex.stats().total;
      } catch (e) { return 'Ошибка: ' + e.message; }
    }

    case '/refresh': {
      await sendMessage(chatId, 'Переиндексирую vault...');
      try {
        vaultIndex = new VaultIndex(cfg.VAULT_PATH);
        const s = vaultIndex.stats();
        return 'Готово! Заметок: ' + s.total + '\nEmail: ' + (s.by_type.email||0) + '  Диск: ' + (s.by_type.disk_file||0);
      } catch (e) { return 'Ошибка: ' + e.message; }
    }

    case '/jira': {
      if (!chatId) return null;
      try {
        const jira = getJIRA();
        if (!args||args==='my') {
          const issues = await jira.getMyIssues();
          let text = 'Мои задачи JIRA:\n\n';
          for (const i of issues.slice(0,10))
            text += i.key + ' — ' + i.summary.slice(0,50) + '\n' + i.status + '\n\n';
          await sendMessage(chatId, text||'Нет задач');
        } else if (args.startsWith('log ')) {
          const parsed = parseWorklog(args.slice(4));
          if (!parsed.hours||!parsed.issueKey) {
            await sendMessage(chatId, 'Формат: /jira log 2h BITASK-123 комментарий');
          } else {
            const r = await jira.logWork(parsed.issueKey, parsed.hours, parsed.comment, parsed.date);
            await sendMessage(chatId, 'Списано ' + r.timeSpent + ' на ' + r.issueKey + '\n' + r.comment);
          }
        } else if (args==='worklogs') {
          const logs  = await jira.getMyWorklogs(7);
          let text    = 'Логи за 7 дней:\n\n';
          let total   = 0;
          for (const l of logs) { text += l.key + ': ' + l.loggedHours + 'ч\n'; total += l.loggedHours; }
          text += '\nИтого: ' + Math.round(total*10)/10 + 'ч';
          await sendMessage(chatId, text||'Нет логов');
        } else {
          const issue = await jira.getIssue(args.toUpperCase());
          await sendMessage(chatId, issue.key + ': ' + issue.summary + '\nСтатус: ' + issue.status + '\nСписано: ' + issue.timeSpent + '\n' + issue.url);
        }
      } catch (e) { await sendMessage(chatId, 'JIRA: ' + e.message); }
      return null;
    }

    case '/confluence': {
      if (!chatId) return null;
      try {
        const confluence = getConfluence();
        if (!args) {
          const pages = await confluence.getSpacePages(5);
          let text = 'Confluence (' + cfg.CONFLUENCE_SPACE + '):\n\n';
          for (const p of pages) text += p.title + '  ' + (p.updated||'') + '\n' + p.url + '\n\n';
          await sendMessage(chatId, text||'Нет страниц');
        } else if (args.startsWith('search ')) {
          const pages = await confluence.searchPages(args.slice(7));
          let text = 'Найдено:\n\n';
          for (const p of pages.slice(0,5)) text += p.title + '\n' + p.url + '\n\n';
          await sendMessage(chatId, text||'Ничего не найдено');
        } else {
          const page = await createConfluencePage(args, '', vaultIndex);
          await sendMessage(chatId, 'Страница создана!\n' + page.title + '\n' + page.url);
        }
      } catch (e) { await sendMessage(chatId, 'Confluence: ' + e.message); }
      return null;
    }

    case '/risk': {
      await sendMessage(chatId, 'Формирую дашборд рисков...');
      try {
        const PII_PATTERNS_LOCAL = [
          { name: 'Банк. карта', pattern: '\\d{4}[\\s\\-]?\\d{4}[\\s\\-]?\\d{4}[\\s\\-]?\\d{4}' },
          { name: 'Телефон',     pattern: '(?:\\+7|8)[\\s\\-]?\\(?\\d{3}\\)?[\\s\\-]?\\d{3}[\\s\\-]?\\d{2}[\\s\\-]?\\d{2}' },
          { name: 'Email',       pattern: '[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}' },
          { name: 'СНИЛС',       pattern: '\\d{3}-\\d{3}-\\d{3}\\s?\\d{2}' },
          { name: 'Паспорт РФ',  pattern: '\\d{4}\\s?\\d{6}' },
        ];
        const scored = [];
        const docs = vaultIndex.docs.filter(function(d) {
          return ['disk_file','email'].indexOf(d.type) >= 0;
        }).slice(0, 100);
        for (const doc of docs) {
          const body   = (doc.body||'').slice(0,5000);
          const found  = [];
          const weights = { 'Банк. карта':10, 'Паспорт РФ':8, 'СНИЛС':7, 'Email':1, 'Телефон':3 };
          let score = 0;
          for (const p of PII_PATTERNS_LOCAL) {
            const re = new RegExp(p.pattern, 'g');
            const m  = body.match(re);
            if (m && m.length) { found.push(p.name+'('+m.length+')'); score += (weights[p.name]||1)*m.length; }
          }
          if (found.length) scored.push({ doc, found, score });
        }
        scored.sort(function(a,b){return b.score-a.score;});
        const lines = ['Дашборд рисков ИБ\n', 'Топ рискованных документов:'];

        for (const {doc,found,score} of scored.slice(0,5)) {
          const lvl = score>=20?'[ВЫСОКИЙ]':score>=10?'[СРЕДНИЙ]':'[НИЗКИЙ]';
          lines.push('');
          lines.push(lvl+' '+((doc.title||'').slice(0,50)));
          lines.push('  '+doc.type+'  '+doc.date+'  риск: '+score);
          lines.push('  PII: '+found.join(', '));
        }
        lines.push('\nВсего документов с PII: '+scored.length);

        lines.push('Сформировано: '+new Date().toLocaleString('ru'));
        return lines.join('\n');

      } catch (e) { return 'Ошибка: '+e.message; }
    }

    case '/graph': {
      try {
        const extDomains = ['gmail.com','yandex.ru','mail.ru','yahoo.com','outlook.com'];
        const graph = new Map();
        for (const doc of vaultIndex.docs.filter(function(d){return d.type==='email';})) {
          const body   = doc.body||'';
          const toLine = body.match(/To:.*?([\w._%+\-]+@[\w.\-]+\.[a-zA-Z]{2,})/gi)||[];
          for (const t of toLine) {
            const email  = (t.match(/([\w._%+\-]+@[\w.\-]+\.[a-zA-Z]{2,})/)||[])[1]||'';
            const domain = email.split('@')[1]||'';
            if (extDomains.some(function(d){return domain.indexOf(d)>=0;})) {
              const from = (doc.from||'unknown').slice(0,25);
              const key  = from+' -> '+email;
              graph.set(key, (graph.get(key)||0)+1);
            }
          }
        }
        if (!graph.size) return 'Внешних получателей не обнаружено.';
        const sorted = Array.from(graph.entries()).sort(function(a,b){return b[1]-a[1];}).slice(0,10);
        const lines  = ['Граф внешних коммуникаций:\n'];

        for (const [route,cnt] of sorted)
          lines.push('('+cnt+') '+route);
        return lines.join('\n');

      } catch (e) { return 'Ошибка: '+e.message; }
    }

    case '/anomaly': {
      try {
        const now=Date.now();
        const emails=vaultIndex.docs.filter(function(d){return d.type==='email'&&d.date;});
        const byWeek={};
        for (const doc of emails) {
          try {
            const daysAgo=Math.floor((now-new Date(doc.date).getTime())/86400000);
            if(daysAgo>56) continue;
            const wk=Math.floor(daysAgo/7);
            byWeek[wk]=(byWeek[wk]||0)+1;
          } catch(_) {}
        }
        const thisWeek=byWeek[0]||0;
        const lastWeek=byWeek[1]||1;
        const ratio=thisWeek/lastWeek;
        const lines=['Аномалии активности\n'];

        if(ratio>=3) lines.push('КРИТИЧНО: Рост писем в '+ratio.toFixed(1)+'x ('+thisWeek+' vs '+lastWeek+')');
        else if(ratio>=2) lines.push('ВНИМАНИЕ: Рост в '+ratio.toFixed(1)+'x');
        else lines.push('Объём в норме ('+thisWeek+' на неделе)');

        const EXTERNAL=['gmail.com','yandex.ru','mail.ru','yahoo.com','outlook.com'];
        const extMap={};
        const recent7=emails.filter(function(d){
          try{return(now-new Date(d.date).getTime())<7*86400000;}catch(_){return false;}
        });
        for (const doc of recent7) {
          const matches=(doc.body||'').match(/[\w._%+\-]+@[\w.\-]+\.[a-zA-Z]{2,}/g)||[];
          for (const em of matches) {
            const dom=em.split('@')[1]||'';
            if(EXTERNAL.some(function(d){return dom.indexOf(d)>=0;}))
              extMap[em]=(extMap[em]||0)+1;
          }
        }
        const mass=Object.entries(extMap).filter(function(x){return x[1]>=3;}).sort(function(a,b){return b[1]-a[1];});
        if(mass.length) {
          lines.push('Массовая пересылка на внешние адреса:');

          for (const [em,cnt] of mass.slice(0,5)) lines.push('  '+em+': '+cnt);
        } else lines.push('Массовой пересылки нет');

        return lines.join('');

      } catch(e) { return 'Ошибка: '+e.message; }
    }

    case '/patterns': {
      try {
        const emails=vaultIndex.docs.filter(function(d){return d.type==='email';});
        const contacts=new Map();
        for (const doc of emails) {
          const m=(doc.from||'').match(/([\w._%+\-]+@[\w.\-]+\.[a-zA-Z]{2,})/);
          if(!m) continue;
          const from=m[1].toLowerCase();
          if(!contacts.has(from)) contacts.set(from,{sent:0,peers:new Set(),ext:0});
          contacts.get(from).sent++;
          const matches=(doc.body||'').match(/[\w._%+\-]+@[\w.\-]+\.[a-zA-Z]{2,}/g)||[];
          const EXTERNAL=['gmail','yandex.ru','mail.ru','yahoo','outlook'];
          for (const to of matches) {
            const toL=to.toLowerCase();
            if(toL!==from) {
              contacts.get(from).peers.add(toL);
              if(EXTERNAL.some(function(d){return toL.indexOf(d)>=0;})) contacts.get(from).ext++;
            }
          }
        }
        const sorted=[...contacts.entries()].sort(function(a,b){return b[1].sent-a[1].sent;}).slice(0,8);
        const lines=['Паттерны коммуникации\n','Топ отправителей:'];

        for (const [em,d] of sorted) {
          const extNote=d.ext>5?' !'+d.ext+'внеш':'';
          lines.push('  '+em.slice(0,35)+': '+d.sent+' писем, '+d.peers.size+' контактов'+extNote);
        }
        const isolated=[...contacts.entries()].filter(function(x){return x[1].peers.size<=1&&x[1].sent>=5;});
        if(isolated.length) {
          lines.push('Потенциально изолированные:');

          for (const [em] of isolated.slice(0,3)) lines.push('  '+em.slice(0,40));
        }
        return lines.join('');

      } catch(e) { return 'Ошибка: '+e.message; }
    }

    case '/sentiment': {
      await sendMessage(chatId, 'Анализирую тональность...');
      try {
        const emails=vaultIndex.getRecent('email',14);
        const NEG=['жалоба','проблема','ошибка','нарушение','срочно','критично','complaint','problem','urgent','critical'];
        const negMsgs=emails.filter(function(d){
          const t=((d.subject||'')+' '+(d.body||'').slice(0,200)).toLowerCase();
          return NEG.filter(function(k){return t.indexOf(k)>=0;}).length>=2;
        });
        const COMP=['конкурент','metro','leroy','ozon','wildberries','лента','магнит'];
        const compMsgs=emails.filter(function(d){
          const t=((d.subject||'')+' '+(d.body||'').slice(0,300)).toLowerCase();
          return COMP.some(function(c){return t.indexOf(c)>=0;});
        });
        const lines=['Тональность переписки (14 дней)\n'];

        lines.push('Негативных писем: '+negMsgs.length+(negMsgs.length>5?' !'  :''));
        if(negMsgs.length) for (const d of negMsgs.slice(0,3)) lines.push('  '+(d.date||'')+': '+(d.subject||'').slice(0,50));
        lines.push('Упоминания конкурентов: '+compMsgs.length);

        if(compMsgs.length) for (const d of compMsgs.slice(0,3)) lines.push('  '+(d.subject||'').slice(0,50));
        try {
          const ctx=emails.slice(0,5).map(function(d){return (d.subject||'')+': '+(d.body||'').slice(0,80);}).join('');

          const resp=await callLLM([{role:'user',content:'Тональность этих писем (2 предложения):\n'+ctx}],{maxTokens:150,chatId});

          lines.push('AI: '+resp);

        } catch(_) {}
        return lines.join('');

      } catch(e) { return 'Ошибка: '+e.message; }
    }

    case '/processes': {
      try {
        const PROC={
          'Продажи':    ['продажа','заказ','клиент','счёт','сделка','sale','order'],
          'Закупки':    ['закупка','поставщик','тендер','контракт','vendor','supply'],
          'HR':         ['найм','кандидат','отпуск','увольнение','hr','вакансия'],
          'Юридические':['договор','нда','nda','юрист','legal','суд','претензия'],
          'IT':         ['сервер','база','api','баг','деплой','система','software'],
          'Финансы':    ['бюджет','оплата','счёт','платёж','invoice','budget','finance'],
          'ИБ':         ['безопасность','инцидент','пароль','security','breach'],
        };
        const counts={};
        const emails=vaultIndex.docs.filter(function(d){return d.type==='email';});
        const total=emails.length||1;
        for (const proc of Object.keys(PROC)) counts[proc]=0;
        for (const doc of emails) {
          const t=((doc.subject||'')+' '+(doc.body||'').slice(0,200)).toLowerCase();
          for (const [proc,kws] of Object.entries(PROC))
            if(kws.some(function(k){return t.indexOf(k)>=0;})) counts[proc]++;
        }
        const sorted=Object.entries(counts).sort(function(a,b){return b[1]-a[1];});
        const maxC=sorted[0][1]||1;
        const lines=['Классификация по процессам\n'];

        for (const [proc,cnt] of sorted) {
          const pct=Math.round(cnt/total*100);
          const bar='#'.repeat(Math.round(cnt/maxC*12));
          lines.push(proc.padEnd(13,' ')+' '+bar.padEnd(12,' ')+' '+cnt+' ('+pct+'%)');
        }
        lines.push('Всего писем: '+total);

        return lines.join('');

      } catch(e) { return 'Ошибка: '+e.message; }
    }

    case '/duplicates': {
      try {
        const files=vaultIndex.docs.filter(function(d){return d.type==='disk_file';});
        const byTitle={};
        for (const f of files) {
          const key=(f.title||'').toLowerCase().replace(/[^а-яёa-z0-9]/g,'').slice(0,30);
          if(!key) continue;
          if(!byTitle[key]) byTitle[key]=[];
          byTitle[key].push(f);
        }
        const dups=Object.values(byTitle).filter(function(d){return d.length>1;}).sort(function(a,b){return b.length-a.length;});
        const lines=['Дубликаты документов\n'];

        if(!dups.length) { lines.push('Явных дубликатов не найдено'); }
        else {
          lines.push('Групп дубликатов: '+dups.length+'\n');

          for (const docs of dups.slice(0,6)) {
            lines.push((docs[0].title||'').slice(0,50)+' ('+docs.length+' копий)');
            for (const d of docs) lines.push('  '+((d.folder||d.path||'').slice(0,40))+'  '+(d.date||''));
          }
        }
        const now=Date.now();
        const oldPII=files.filter(function(f){
          try {
            const old=(now-new Date(f.date).getTime())/86400000>180;
            return old&&/\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}/.test(f.body||'');
          } catch(_){return false;}
        }).slice(0,5);
        if(oldPII.length) {
          lines.push('Устаревшие документы с PII (>6 мес):');

          for (const f of oldPII) lines.push('  '+(f.title||'').slice(0,50)+'  '+(f.date||''));
        }
        return lines.join('');

      } catch(e) { return 'Ошибка: '+e.message; }
    }

    case '/heatmap': {
      try {
        const days  = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
        const hours = [9,10,11,12,13,14,15,16,17,18,19,20];
        const heat  = {};
        for (const d of days) for (const h of hours) heat[d+':'+h]=0;
        for (const doc of vaultIndex.docs.filter(function(d){return d.type==='email'&&d.date;})) {
          try {
            const dt=new Date(doc.date);
            const day=days[dt.getDay()===0?6:dt.getDay()-1];
            const h=dt.getHours();
            if(days.includes(day)&&hours.includes(h)) heat[day+':'+h]++;
          } catch(_) {}
        }
        const lines=['Тепловая карта активности\n','     '+hours.map(function(h){return String(h).padStart(2);}).join(' ')];

        for (const day of days) {
          const vals=hours.map(function(h){return heat[day+':'+h]||0;});
          const max=Math.max.apply(null,vals.concat([1]));
          const bar=vals.map(function(v){
            const r=v/max;
            return r===0?'.':r<0.33?'o':r<0.66?'O':'#';
          }).join(' ');
          lines.push(day+'  '+bar+'  '+vals.reduce(function(a,b){return a+b;},0));
        }
        return lines.join('\n');

      } catch(e) { return 'Ошибка: '+e.message; }
    }

    case '/trend': {
      try {
        const SEC_KW=['инцидент','взлом','утечка','доступ','пароль','уязвимость','incident','breach'];
        const weeks={};
        const now=Date.now();
        for (const doc of vaultIndex.docs.filter(function(d){return d.type==='email'&&d.date;})) {
          try {
            const dt=new Date(doc.date);
            const daysAgo=Math.floor((now-dt.getTime())/86400000);
            if(daysAgo>84) continue;
            const wk='W'+Math.floor(daysAgo/7);
            const text=((doc.subject||'')+' '+(doc.body||'').slice(0,200)).toLowerCase();
            const isIB=SEC_KW.some(function(k){return text.indexOf(k)>=0;});
            if(!weeks[wk]) weeks[wk]={total:0,ib:0,wnum:Math.floor(daysAgo/7)};
            weeks[wk].total++;
            if(isIB) weeks[wk].ib++;
          } catch(_) {}
        }
        const sorted=Object.values(weeks).sort(function(a,b){return b.wnum-a.wnum;}).slice(0,8).reverse();
        if(!sorted.length) return 'Недостаточно данных.';
        const maxIB=Math.max.apply(null,sorted.map(function(w){return w.ib;}).concat([1]));
        const lines=['Trend ИБ инцидентов (8 недель)\n'];

        for (const w of sorted) {
          const bar='#'.repeat(Math.round(w.ib/maxIB*12));
          const pct=w.total>0?Math.round(w.ib/w.total*100):0;
          lines.push('Нед-'+w.wnum+' '+bar.padEnd(12,' ')+' '+w.ib+'/'+w.total+' ('+pct+'%)'+(w.ib>3?' !':''));
        }
        const last2=sorted.slice(-2).map(function(w){return w.ib;});
        if(last2.length>=2)
          lines.push('\n'+(last2[1]>last2[0]?'Растет':last2[1]<last2[0]?'Снижается':'Стабильно'));

        return lines.join('\n');

      } catch(e) { return 'Ошибка: '+e.message; }
    }

    case '/depts': {
      try {
        const deptRisk={};
        const PII_PAT=[/\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}/g, /\d{3}-\d{3}-\d{3}\s?\d{2}/g];
        for (const doc of vaultIndex.docs.filter(function(d){return ['email','disk_file'].indexOf(d.type)>=0;})) {
          const folder=(doc.folder||doc.path||'Unknown').split('/')[0].slice(0,20);
          const body=(doc.body||'').slice(0,3000);
          let score=0;
          for (const re of PII_PAT) { re.lastIndex=0; const m=body.match(re); if(m) score+=m.length*5; }
          if(score>0) {
            if(!deptRisk[folder]) deptRisk[folder]={score:0,docs:0};
            deptRisk[folder].score+=score;
            deptRisk[folder].docs++;
          }
        }
        const sorted=Object.entries(deptRisk).sort(function(a,b){return b[1].score-a[1].score;}).slice(0,8);
        if(!sorted.length) return 'Рискованных папок не обнаружено.';
        const lines=['Дашборд рисков по отделам\n'];

        const maxS=sorted[0][1].score;
        for (const [dept,{score,docs}] of sorted) {
          const lvl=score>=50?'[!]':score>=20?'[~]':'[ ]';
          const bar='#'.repeat(Math.round(score/maxS*10));
          lines.push(lvl+' '+dept.slice(0,18).padEnd(18,' ')+' '+bar+' '+score+' ('+docs+')');
        }
        return lines.join('\n');

      } catch(e) { return 'Ошибка: '+e.message; }
    }

    case '/ibreport': {
      await sendMessage(chatId, 'Генерирую ИБ отчёт...');
      try {
        const sections = [];
        // PII статистика
        const piiTypes = {};
        let piiDocCount = 0;
        const PII_SIMPLE = [
          { name:'Банк. карта', re:/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g },
          { name:'Телефон',     re:/(\+7|8)[\s-]?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/g },
          { name:'Email',       re:/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g },
        ];
        for (const doc of vaultIndex.docs.filter(function(d){return ['disk_file','email'].indexOf(d.type)>=0;}).slice(0,100)) {
          const body  = doc.body||'';
          let   found = false;
          for (const p of PII_SIMPLE) {
            p.re.lastIndex=0;
            const m = body.match(p.re);
            if (m&&m.length) { piiTypes[p.name]=(piiTypes[p.name]||0)+m.length; found=true; }
          }
          if (found) piiDocCount++;
        }
        const piiBlock = ['PII статистика:'];
        for (const [t,c] of Object.entries(piiTypes)) piiBlock.push('  '+t+': '+c+' шт');
        piiBlock.push('  Документов с PII: '+piiDocCount);
        sections.push(piiBlock.join('\n'));

        // ИБ письма
        const secEmails = vaultIndex.getRecent('email',7).filter(function(d) {
          const t=((d.subject||'')+' '+(d.body||'').slice(0,200)).toLowerCase();
          return ['инцидент','взлом','утечка','доступ','пароль'].some(function(k){return t.indexOf(k)>=0;});
        });
        if (secEmails.length)
          sections.push('Письма ИБ тематики (7 дней): '+secEmails.length+'\n'+secEmails.slice(0,3).map(function(e){return '  '+(e.date||'')+': '+(e.subject||'').slice(0,50);}).join('\n'));



        // AI анализ
        try {
          const ctx  = vaultIndex.getRecent('email',7).slice(0,5).map(function(d){return d.subject||d.title||'';}).join(', ');
          const resp = await callLLM([{role:'user',content:'3 ИБ рекомендации для компании на основе тем писем: '+ctx}],
            {maxTokens:300, chatId});
          sections.push('AI рекомендации:\n'+resp);

        } catch (_) {}
        return ('ЕЖЕНЕДЕЛЬНЫЙ ИБ ОТЧЁТ\n'+new Date().toLocaleDateString('ru')+'\n\n'+sections.join('\n\n')).slice(0,4000);






      } catch (e) { return 'Ошибка: '+e.message; }
    }

    case '/fillrf': {
      // Поиск IP по rf_list.xlsx и заполнение TESTing.xlsx (с прогрессом)
      //   /fillrf            — полный прогон (поиск + LLM + заливка на Диск)
      //   /fillrf dry        — без записи
      //   /fillrf nollm      — без LLM
      //   /fillrf noupload   — не заливать на Диск
      //   /fillrf inspect <ссылка> — структура одного РФ
      let rflib;
      try { rflib = require('./fill_from_rflist'); }
      catch (e) { return 'Модуль fill_from_rflist недоступен (выполните npm install): ' + e.message.slice(0, 150); }

      if (/^inspect\b/i.test(args)) {
        const link = args.replace(/^inspect\s*/i, '').trim();
        if (!link) return 'Укажите ссылку: /fillrf inspect <ссылка на РФ>';
        await sendMessage(chatId, 'Загружаю структуру РФ...');
        try { return await rflib.inspectRf(link); }
        catch (e) { return 'Ошибка: ' + e.message.slice(0, 300); }
      }

      const opts = {
        dryRun:   /\bdry\b/i.test(args),
        noLlm:    /\bnollm\b/i.test(args),
        noUpload: /\bnoupload\b/i.test(args),
      };
      await sendMessage(chatId, '⚙️ Запускаю заполнение TESTing.xlsx по rf_list.xlsx' +
        (opts.dryRun ? ' (DRY-RUN)' : '') + '\nЭто может занять несколько минут...');

      // Я.Мессенджер не умеет править сообщения — прогресс шлём новыми сообщениями не чаще раза в 15с
      let lastSent = Date.now();
      const onProgress = (t) => {
        const now = Date.now();
        if (now - lastSent < 15000) return;
        lastSent = now;
        sendMessage(chatId, t).catch(() => {});
      };

      try {
        const res = await rflib.run(opts, onProgress);
        return res.summary;
      } catch (e) {
        return 'Ошибка: ' + e.message.slice(0, 400);
      }
    }

    case '/rf': {
      // /rf, /rf list, /rf <IP>, /rf <IP> <вопрос>, /rf <вопрос>
      if (!args || args === 'help') {
        return [
          'Поиск по Request Form (РФ) файлам',
          '',
          '/rf list — список всех РФ-файлов',
          '/rf <IP> — загрузить документ по IP',
          '/rf <IP> <вопрос> — вопрос по документу',
          '/rf <вопрос> — вопрос по загруженному документу',
          '',
          'Примеры:',
          '/rf 10.156.1.40',
          '/rf 10.156.1.40 кто ответственный?',
          '/rf какие порты используются?',
        ].join('\n');
      }

      if (args === 'list' || args === 'список') {
        await sendMessage(chatId, 'Загружаю список РФ-файлов...');
        try {
          const files = await rfGetFileList();
          const lines = ['Request Form файлы (' + files.length + '):\n'];
          for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const isPart = f.is ? ' — ' + f.is.slice(0,25) : '';
            lines.push((i+1) + '. IP ' + f.ip + isPart);
            if (f.link) lines.push('   🔗 ' + f.link);
          }
          lines.push('\nЗагрузить: /rf <IP>');
          return lines.join('\n');
        } catch (e) { return 'Ошибка: ' + e.message; }
      }

      // IP + опциональный вопрос
      const ipMatch = args.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s*([\s\S]*)$/);
      if (ipMatch) {
        const ip = ipMatch[1];
        const question = (ipMatch[2] || '').trim();
        await sendMessage(chatId, 'Загружаю документ для IP ' + ip + '...');
        try {
          const files = await rfGetFileList();
          const file = files.find(function(f){ return f.ip === ip; }) || files.find(function(f){ return f.ip.includes(ip); });
          if (!file) return 'IP ' + ip + ' не найден. Попробуйте /rf list';

          let docText = RF_DOC_CACHE.get(file.link);
          if (!docText) {
            const buf = await rfDownload(file.link);
            docText = rfBuildFullText(buf);
            RF_DOC_CACHE.set(file.link, docText);
          }
          const tokens = rfEstimateTokens(docText);
          RF_STATE.set(chatId, { ip, docText, tokens, is: file.is });

          if (!question) {
            return ['Документ загружен:',
              'IP: ' + ip,
              'ИС: ' + (file.is || '—'),
              'Символов: ' + docText.length.toLocaleString('ru'),
              'Токенов: ~' + tokens.toLocaleString('ru'),
              tokens > 16000 ? 'Большой документ — поиск по частям' : '',
              '\nЗадайте вопрос: /rf <вопрос>'].filter(Boolean).join('\n');
          }
          await sendMessage(chatId, 'Анализирую документ (~' + tokens.toLocaleString('ru') + ' токенов)...');
          const answer = await rfAskLLM(docText, question, chatId);
          return 'IP ' + ip + ' | ' + (file.is||'') + '\n\n❓ ' + question + '\n\n💡 ' + answer;
        } catch (e) { return 'Ошибка: ' + e.message; }
      }

      // Вопрос по загруженному документу
      const state = RF_STATE.get(chatId);
      if (!state) return 'Сначала загрузите документ: /rf <IP>\nИли: /rf list';
      await sendMessage(chatId, 'Ищу в документе IP ' + state.ip + '...');
      try {
        const answer = await rfAskLLM(state.docText, args, chatId);
        return 'IP ' + state.ip + ' | ' + (state.is||'') + '\n\n❓ ' + args + '\n\n💡 ' + answer;
      } catch (e) { return 'Ошибка: ' + e.message; }
    }

    case '/embcheck': {
      await sendMessage(chatId, 'Перебираю эндпоинты embedding и rerank...');
      const lines = ['🔬 Автопоиск эндпоинтов Ашан\n'];
      const testAgent = new (require('https').Agent)({ rejectUnauthorized: false });
      const base = (cfg.AUCHAN_LLM_URL || '').replace(/\/+$/, '');
      const baseRoot = base.replace(/\/v1$/, '');  // без /v1
      const headers = {
        'X-Gravitee-Api-Key': cfg.AUCHAN_API_KEY,
        'Authorization': 'Bearer ' + (cfg.AUCHAN_BEARER || ''),
        'Content-Type': 'application/json',
      };

      // ── Локальный embedding ──
      lines.push('📐 ЛОКАЛЬНЫЙ EMBEDDING:');
      try {
        const { embeddingSearch } = require('./indexer');
        if (embeddingSearch && embeddingSearch.ready) {
          lines.push('  ✅ e5-small работает (384 разм.)');
        } else lines.push('  ⚠️ не загружен');
      } catch (_) {}

      // ── Перебор EMBEDDING эндпоинтов ──
      lines.push('\n📐 ПОИСК EMBEDDING (Ашан):');
      const embUrls = [
        base + '/embeddings',
        baseRoot + '/embeddings',
        base + '/embed',
        baseRoot + '/v1/embeddings',
      ];
      const embModels = [cfg.AUCHAN_EMBEDDING_MODEL || 'qwen3-embedding', 'qwen2-embedding', 'bge-m3', 'text-embedding'];
      const embBodies = function(model, text) { return [
        { input: text, model: model },
        { input: [text], model: model },
        { text: text, model: model },
        { inputs: text, model: model },
      ]; };

      let embFound = null;
      outerEmb:
      for (const url of embUrls) {
        for (const model of embModels) {
          for (const body of embBodies(model, 'тест')) {
            try {
              const { data } = await axios.post(url, body, { headers, httpsAgent: testAgent, timeout: 12000 });
              const vec = (data.data && data.data[0] && data.data[0].embedding) || data.embedding || (data.embeddings && data.embeddings[0]);
              if (vec && vec.length) {
                embFound = { url, model, body: Object.keys(body).join('+'), dim: vec.length };
                break outerEmb;
              }
            } catch (e) {
              const st = e.response && e.response.status;
              // 404 — путь неверный, пропускаем быстро; 400 — путь есть, формат не тот
              if (st === 404) break; // пробуем следующий URL
            }
          }
        }
      }

      if (embFound) {
        lines.push('  ✅ НАЙДЕНО!');
        lines.push('     URL: ' + embFound.url);
        lines.push('     Модель: ' + embFound.model);
        lines.push('     Формат тела: {' + embFound.body + '}');
        lines.push('     Размерность: ' + embFound.dim);
        lines.push('\n  Добавьте в .env:');
        lines.push('  AUCHAN_EMBEDDING_URL=' + embFound.url);
        lines.push('  AUCHAN_EMBEDDING_MODEL=' + embFound.model);
      } else {
        lines.push('  ❌ Рабочий embedding эндпоинт не найден');
        lines.push('     (перебрано ' + (embUrls.length*embModels.length*4) + ' комбинаций)');
      }

      // ── Перебор RERANK эндпоинтов ──
      lines.push('\n🔀 ПОИСК RERANK (Ашан):');
      const rrUrls = [
        base + '/rerank',
        baseRoot + '/rerank',
        base + '/reranking',
        baseRoot + '/v1/rerank',
      ];
      const rrModels = [cfg.AUCHAN_RERANK_MODEL || 'qwen3-reranker', 'qwen2-reranker', 'bge-reranker-v2-m3', 'rerank'];
      const rrBodies = function(model) { return [
        { model: model, query: 'тест', documents: ['док один', 'док два'] },
        { model: model, query: 'тест', texts: ['док один', 'док два'] },
        { query: 'тест', documents: ['док один', 'док два'] },
        { model: model, query: 'тест', passages: ['док один', 'док два'] },
      ]; };

      let rrFound = null;
      outerRr:
      for (const url of rrUrls) {
        for (const model of rrModels) {
          for (const body of rrBodies(model)) {
            try {
              const { data } = await axios.post(url, body, { headers, httpsAgent: testAgent, timeout: 12000 });
              if (data.results || data.scores || (data.data && Array.isArray(data.data)) || data.rankings) {
                rrFound = { url, model, body: Object.keys(body).join('+') };
                break outerRr;
              }
            } catch (e) {
              const st = e.response && e.response.status;
              if (st === 404) break;
            }
          }
        }
      }

      if (rrFound) {
        lines.push('  ✅ НАЙДЕНО!');
        lines.push('     URL: ' + rrFound.url);
        lines.push('     Модель: ' + rrFound.model);
        lines.push('     Формат тела: {' + rrFound.body + '}');
        lines.push('\n  Добавьте в .env:');
        lines.push('  AUCHAN_RERANK_URL=' + rrFound.url);
        lines.push('  AUCHAN_RERANK_MODEL=' + rrFound.model);
      } else {
        lines.push('  ❌ Рабочий rerank эндпоинт не найден');
        lines.push('     Возможно Ашан не предоставляет rerank');
        lines.push('     Reranking работает через LLM-промпт');
      }

      return lines.join('\n').slice(0, 4000);
    }

    case '/clear': {
      clearDialog(chatId);
      return 'История диалога очищена.';
    }

    default:
      return undefined;
  }
}

// ── PROCESS UPDATE ──
async function processUpdate(update) {
  const chatId    = update.chat && update.chat.id;
  const text      = (update.text || '').trim();
  const sender    = (update.from && (update.from.display_name || update.from.login)) || 'Unknown';
  const isGroup   = update.chat && update.chat.type === 'group';
  const isRobot   = update.from && update.from.robot === true;
  const userLogin = update.from && update.from.login;

  if (!chatId) return;
  if (!isGroup && userLogin) USER_LOGIN_MAP[chatId] = userLogin;

  if (update.voice || update.audio) { await handleVoice(update); return; }
  if (!isRobot && text) await saveToVault(update);
  if (!text || isRobot) return;

  // Сохраняем историю чата для контекста цифрового двойника
  if (isGroup && !isRobot) addChatHistory(chatId, sender, text);

  // Цифровой двойник — отвечаем если упомянули Станислава
  if (isGroup && isMentioned(text)) {
    await digitalTwinResponse(update);
    return;
  }

  // В группах — отвечаем только на команды (упоминания уже обработаны выше)
  if (isGroup) {
    if (!text.startsWith('/')) return; // без команды — молчим
  }

  console.log('[' + new Date().toISOString().slice(11,19) + '] ' + sender + ': ' + text.slice(0,60));

  try {
    const parts    = text.split(' ');
    const baseCmd  = parts[0].toLowerCase();
    const modelArg = parts[1] && MODELS[parts[1]] ? parts[1] : null;
    const cmd      = text.startsWith('/') ? (modelArg ? '/model' : baseCmd) : null;
    const cmdText  = cmd === '/model' && modelArg ? '/model ' + modelArg : text;

    let response = null;
    if (cmd) {
      response = await handleCommand(cmd, chatId, cmdText);
      if (response === undefined) response = await ragAnswer(text, chatId);
    } else {
      response = await ragAnswer(text, chatId);
    }

    if (response) {
      await sendMessage(chatId, response);
      console.log('   -> ' + response.length + ' символов');
    }
  } catch (e) {
    const status = e.response && e.response.status;
    if (status === 403) {
      console.log('   403 в ' + (chatId||'').slice(0,20) + ' — нет прав');
      FORBIDDEN_CHATS.add(chatId);
      return;
    }
    console.error('   Error:', e.message);
    // Не отправляем ошибку в группы — только в личку
    const isGroup2 = chatId && (chatId.startsWith('0/') || chatId.includes('/22/'));
    if (!isGroup2) {
      try { await sendMessage(chatId, 'Ошибка: ' + e.message.slice(0,80)); } catch (_) {}
    }
  }
}

// ── POLL LOOP ──
let vaultIndex;
let isRunning = true;

async function poll() {
  let emptyCount = 0;
  while (isRunning) {
    try {
      const updates = await getUpdates(STATE.offset);
      if (!updates.length) {
        emptyCount++;
        if (emptyCount > 30 && STATE.offset > 0) {
          STATE.offset = 0; emptyCount = 0; saveState(STATE);
          console.log('   Auto-reset offset');
        }
      } else {
        emptyCount = 0;
        for (const update of updates) {
          await processUpdate(update);
          STATE.offset = Math.max(STATE.offset, update.update_id + 1);
        }
        saveState(STATE);
      }
    } catch (e) {
      if (e.response && e.response.status === 401) { console.error('Invalid token'); process.exit(1); }
      const isNet = ['ENOTFOUND','EHOSTUNREACH','ECONNRESET','socket','TLS','SSL','EFATAL']
        .some(function(s) { return e.message.indexOf(s) >= 0; });
      if (!isNet) console.error('Polling: ' + e.message);
      if (isNet) await new Promise(r => setTimeout(r, 5000));
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

// ── CLI MODE ──
async function cliMode() {
  const readline = require('readline');
  vaultIndex = new VaultIndex(cfg.VAULT_PATH);
  console.log('Жду загрузки эмбеддингов (8с)...');
  await new Promise(r => setTimeout(r, 8000));
  console.log('Vault: ' + vaultIndex.stats().total + ' заметок');
  console.log('CLI режим (exit для выхода)\n');

  const rl       = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const TEST_ID  = 'cli_test';

  const ask = function() {
    rl.question('Вы: ', async function(text) {
      text = (text||'').trim();
      if (text === 'exit') { rl.close(); process.exit(0); }
      if (!text) { ask(); return; }
      try {
        const cmd  = text.startsWith('/') ? text.split(' ')[0].toLowerCase() : null;
        let resp   = cmd ? await handleCommand(cmd, TEST_ID, text) : null;
        if (resp === undefined || (!resp && resp !== null)) resp = await ragAnswer(text, TEST_ID);
        if (resp) console.log('\nБот: ' + resp + '\n');
      } catch (e) { console.error('Error:', e.message); }
      ask();
    });
  };
  ask();
}

// ── MAIN ──
async function main() {
  if (process.argv.indexOf('--cli') >= 0) return cliMode();

  console.log('Яндекс Мессенджер Бот v2');
  if (!cfg.YANDEX_BOT_TOKEN) { console.error('YANDEX_BOT_TOKEN не задан'); process.exit(1); }

  vaultIndex = new VaultIndex(cfg.VAULT_PATH);

  try {
    await ax.get('/messages/getUpdates/', { params: { limit:1, offset:0 } });
    console.log('Мессенджер: подключён, offset=' + STATE.offset);
  } catch (e) {
    console.error('Ошибка подключения: ' + e.message);
    if (e.response && e.response.status === 401) process.exit(1);
  }

  try {
    await ax.post('/setMyCommands/', { commands: [
      { command:'start',       description:'Главное меню' },
      { command:'search',      description:'Поиск в базе знаний' },
      { command:'last',        description:'Последние события' },
      { command:'digest',      description:'Дайджест недели' },
      { command:'tasks',       description:'Задачи и дедлайны' },
      { command:'insights',    description:'Проактивные инсайты' },
      { command:'contacts',    description:'Топ контактов' },
      { command:'analytics',   description:'Аналитика активности' },
      { command:'stats',       description:'Статистика vault' },
      { command:'security',    description:'ИБ дайджест' },
      { command:'pii',         description:'Сканирование персданных' },
      { command:'classify',    description:'Классификация документов' },
      { command:'person',      description:'Поиск по человеку' },
      { command:'where',       description:'Папки для поиска' },
      { command:'model',       description:'Выбор LLM модели' },
      { command:'checktoken',  description:'Статус токенов' },
      { command:'risk',         description:'Дашборд рисков ИБ' },
      { command:'graph',        description:'Граф внешних коммуникаций' },
      { command:'anomaly',       description:'Аномалии активности' },
      { command:'patterns',      description:'Паттерны коммуникации' },
      { command:'sentiment',     description:'Тональность переписки' },
      { command:'processes',     description:'Классификация по процессам' },
      { command:'duplicates',    description:'Дубликаты документов' },
      { command:'rf',            description:'Поиск по Request Form файлам' },
      { command:'embcheck',      description:'Проверка embedding/rerank' },
      { command:'heatmap',       description:'Тепловая карта активности' },
      { command:'trend',         description:'Тренд ИБ инцидентов' },
      { command:'depts',         description:'Дашборд рисков по отделам' },
      { command:'ibreport',      description:'Полный ИБ отчёт' },
      { command:'audit',        description:'Лог доступов' },
      { command:'jira',        description:'Задачи JIRA' },
      { command:'confluence',  description:'Страницы Confluence' },
      { command:'sync',        description:'Синхронизация данных' },
      { command:'refresh',     description:'Переиндексация vault' },
      { command:'clear',       description:'Очистить историю' },
    ]});
    console.log('Команды зарегистрированы');
  } catch (_) { console.log('setMyCommands не поддерживается'); }

  console.log('Polling каждые ' + POLL_INTERVAL/1000 + 'с (Ctrl+C — стоп)\n');

  process.on('SIGINT', function() { isRunning = false; saveState(STATE); process.exit(0); });

  // ── Real-time мониторинг источников ──

  // Почта каждые 5 минут
  setInterval(async function() {
    try {
      const { syncEmail } = require('./syncer');
      const r = await syncEmail(cfg.VAULT_PATH, {});
      if (r.new > 0) {
        vaultIndex = new VaultIndex(cfg.VAULT_PATH);
        console.log('[sync] Почта: +' + r.new + ' новых писем');
        // Авто-разметка
        require('child_process').execFile('node', ['mark_visibility.js'],
          { cwd: process.cwd() }, function() {});
      }
    } catch (_) {}
  }, 5 * 60 * 1000);

  // Мессенджер каждые 2 минуты
  setInterval(async function() {
    try {
      const { syncMessenger } = require('./syncer');
      const r = await syncMessenger(cfg.VAULT_PATH);
      if (r.new > 0) {
        vaultIndex = new VaultIndex(cfg.VAULT_PATH);
        console.log('[sync] Мессенджер: +' + r.new + ' новых');
      }
    } catch (_) {}
  }, 2 * 60 * 1000);

  // Диск каждые 30 минут
  setInterval(async function() {
    try {
      const { syncDisk } = require('./syncer');
      const r = await syncDisk(cfg.VAULT_PATH, { force: false });
      if (r.new > 0 || r.updated > 0) {
        vaultIndex = new VaultIndex(cfg.VAULT_PATH);
        console.log('[sync] Диск: +' + r.new + ' новых, ' + r.updated + ' обновлено');
      }
    } catch (_) {}
  }, 30 * 60 * 1000);

  // Инкрементальная индексация через chokidar (с задержкой на первичную векторизацию)
  const { embeddingSearch: embSearch } = require('./indexer');
  function startWatcher() {
    if (embSearch.indexing) { setTimeout(startWatcher, 10000); return; }
    watchVault(
      cfg.VAULT_PATH,
      function() { return vaultIndex; },
      function(fresh) { vaultIndex = fresh; },
      function(stats) {
        console.log('[watch] Vault обновлён: +' + stats.changed + ' → ' + stats.total + ' заметок');
        require('child_process').execFile('node', ['mark_visibility.js'], { cwd: process.cwd() }, function() {});
      }
    );
  }
  setTimeout(startWatcher, 30000);

  // Резервная полная переиндексация раз в сутки
  setInterval(async function() {
    try {
      vaultIndex = new VaultIndex(cfg.VAULT_PATH);
      console.log('[reindex] Суточный резерв: ' + vaultIndex.stats().total + ' заметок');
      require('child_process').execFile('node', ['mark_visibility.js'],
        { cwd: process.cwd() }, function() {});
    } catch (_) {}
  }, 24 * 60 * 60 * 1000);

  await poll();
}

main().catch(function(e) { console.error('Fatal:', e.message); process.exit(1); });
