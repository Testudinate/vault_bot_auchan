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
const XLSX      = require('xlsx');
const cron      = require('node-cron');
const winston   = require('winston');
const TelegramBot = require('node-telegram-bot-api');
const Anthropic   = require('@anthropic-ai/sdk');

const cfg     = require('./config');
const { getConfluence, getJIRA, createConfluencePage, parseWorklog } = require('./integrations');
const { VaultIndex, parseTimeExpression, embeddingSearch, watchVault } = require('./indexer');
const { syncAll, syncDisk }              = require('./syncer');
const { KnowledgeGraph, formatConnections } = require('./graph_rag');
const guardrails = require('./guardrails');

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

// Долгосрочная память пользователя
function getUserMemory(uid) { return STATE.memory && STATE.memory[uid] ? STATE.memory[uid] : {}; }
function updateUserMemory(uid, key, value) {
  if (!STATE.memory) STATE.memory = {};
  if (!STATE.memory[uid]) STATE.memory[uid] = {};
  STATE.memory[uid][key] = value;
  STATE.memory[uid].updatedAt = new Date().toISOString();
  saveState(STATE);
}
function getMemoryContext(uid) {
  const mem = getUserMemory(uid);
  if (!Object.keys(mem).length) return '';
  const parts = [];
  if (mem.name)        parts.push('Пользователь: ' + mem.name);
  if (mem.role)        parts.push('Роль: ' + mem.role);
  if (mem.topics)      parts.push('Частые темы: ' + mem.topics.join(', '));
  if (mem.lastSearch)  parts.push('Последний поиск: ' + mem.lastSearch);
  return parts.length ? '[Память о пользователе: ' + parts.join(' | ') + ']' : '';

}

// Обновляем память после каждого запроса
async function updateMemoryFromQuery(uid, question) {
  try {
    const mem    = getUserMemory(uid);
    const topics = mem.topics || [];
    // Извлекаем ключевые слова из запроса
    const words  = question.toLowerCase().match(/[а-яёa-z]{5,}/g) || [];
    const newTopics = [...new Set([...topics, ...words.slice(0, 2)])].slice(-10);
    updateUserMemory(uid, 'topics', newTopics);
    updateUserMemory(uid, 'lastSearch', question.slice(0, 80));
    updateUserMemory(uid, 'queryCount', (mem.queryCount || 0) + 1);
  } catch (_) {}
}
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
let knowledgeGraph = null;  // строится лениво при первом /graphrag

// Флаг локального реранкера (bge-reranker). Включается через /reranker on
let USE_LOCAL_RERANKER = process.env.USE_LOCAL_RERANKER === 'true';

function getGraph() {
  if (!knowledgeGraph) {
    log.info('🕸️ Строю граф знаний...');
    knowledgeGraph = new KnowledgeGraph(vaultIndex.docs);
    log.info('✅ Граф: ' + JSON.stringify(knowledgeGraph.stats()));
  }
  return knowledgeGraph;
}
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
//  MULTI-HOP REASONING
// ──────────────────────────────────────────────

// Определяет нужен ли multi-hop (сложный вопрос с несколькими шагами)
function needsMultiHop(question) {
  const multiHopSignals = [
    /какой.*(бюджет|сумма|стоимость).*(встреч|проект|письм)/i,
    /когда.*(после|до|между)/i,
    /кто.*(упомина|писал|говорил).*(о|про|насчёт)/i,
    /связан.*(с|между)/i,
    /what.*(budget|cost).*(meeting|project)/i,
  ];
  return multiHopSignals.some(re => re.test(question));
}

async function multiHopRag(question, { uid = 0, docType = null, folders = null } = {}) {
  log.info('Multi-hop reasoning for: ' + question.slice(0, 60));

  // Шаг 1: разбить вопрос на под-вопросы
  const decompose = await callLLM(
    [{ role: 'user', content: 'Разбей этот вопрос на 2-3 простых под-вопроса для поиска в базе знаний (каждый с новой строки):\n' + question }],


    { maxTokens: 150, uid }
  );
  const subQuestions = decompose.trim().split('\n').filter(Boolean).slice(0, 3);

  log.info('Sub-questions: ' + subQuestions.join(' | '));

  // Шаг 2: ответить на каждый под-вопрос
  const subAnswers = [];
  for (const sq of subQuestions) {
    try {
      const { dateFrom, dateTo, cleaned } = parseTimeExpression(sq);
      const docs = await vaultIndex.searchHybrid(cleaned || sq, { topK: 3, docType, folders, dateFrom, dateTo });
      const ctx  = formatContext(docs, 1000);
      const ans = await callLLM([{ role:'user', content:'Ответь кратко:\n'+sq+'\n\nДокументы:\n'+ctx }], { maxTokens:200, uid });








    } catch (_) {}
  }

  // Шаг 3: объединить ответы в финальный
  const combined = subAnswers.map(function(sa,i){return '['+(i+1)+'] '+sa.q+'\n-> '+sa.a;}).join('\n\n');



  const final    = await callLLM(
    [{ role: 'user', content: 'На основе промежуточных ответов дай финальный ответ:\n\nВопрос: ' + question + '\n\nПромежуточные ответы:\n' + combined }],







    { maxTokens: 600, uid }
  );

  addToDialog(uid, 'user', question);
  addToDialog(uid, 'assistant', final);
  await updateMemoryFromQuery(uid, question);
  return final;
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

  // Query expansion
  let queries = [cleaned];
  try {
    const prompt = detectLanguage(cleaned) === 'en'
      ? '2 alternative search phrasings (one per line):\n' + cleaned
      : '2 альтернативных формулировки для поиска (по строке):\n' + cleaned;
    const r = await callLLM([{ role:'user', content: prompt }], { maxTokens:80, uid });
    queries = [cleaned, ...r.trim().split('\n').filter(Boolean).slice(0, 2)];
    log.info('Query expansion: ' + queries.join(' | '));
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

  // Reranking — сначала локальный cross-encoder (bge-reranker), фолбэк на LLM
  let topDocs = allDocs.slice(0, 6);
  if (allDocs.length >= 8) {
    let reranked = false;

    // 1. Локальный reranker (быстрый, без затрат на LLM)
    if (USE_LOCAL_RERANKER) {
      try {
        const candidates = allDocs.slice(0, 15);
        const scores = await embeddingSearch.rerank(question, candidates);
        if (scores) {
          topDocs = candidates
            .map(function(d, i) { return { doc: d, score: scores[i] }; })
            .sort(function(a, b) { return b.score - a.score; })
            .slice(0, 5)
            .map(function(x) { return x.doc; });
          reranked = true;
          log.info('Reranking: локальный bge-reranker');
        }
      } catch (_) {}
    }

    // 2. Фолбэк — LLM reranking
    if (!reranked) {
      try {
        const candidateList = allDocs.slice(0,15).map(function(d,i){ return '['+i+'] '+d.title+' | '+d.type+' | '+(d.date||'')+' | '+(d.relevantChunk||d.body||'').slice(0,150); }).join('\n');
        const rerankResp = await callLLM(
          [{ role:'user', content: 'Вопрос: "'+question+'"\n\nКандидаты:\n'+candidateList+'\n\nУкажи номера 5 наиболее релевантных (через запятую, только цифры):' }],
          { maxTokens: 30, uid }
        );
        const indices = rerankResp.match(/\d+/g);
        if (indices && indices.length >= 3) {
          topDocs = indices
            .map(function(i) { return allDocs[parseInt(i)]; })
            .filter(Boolean)
            .slice(0, 5);
          log.info('Reranking: LLM ' + indices.join(','));
        }
      } catch (_) {}
    }
  }

  const context  = formatContext(topDocs);
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
  await updateMemoryFromQuery(uid, question);
  // Прослеживаемость — источники
  const sources = formatSources(topDocs);
  // GraphRAG — связи между сущностями в найденных документах
  const connections = formatGraphConnectionsForDocs(question, topDocs);
  // MCP-стиль — связанные задачи JIRA и страницы Confluence
  const integrations = await enrichFromIntegrations(question);
  return answer + sources + connections + integrations;
}

// GraphRAG: добавляет связи "человек → документ → проект" для найденных документов
function formatGraphConnectionsForDocs(query, docs) {
  if (!docs || !docs.length) return '';
  try {
    const graph = getGraph();
    if (!graph) return '';
    // Берём связи по самому релевантному запросу
    const conns = graph.getConnections(query);
    if (!conns || !conns.length) return '';

    const lines = ['\n\n🕸️ Связи:'];
    let added = 0;
    for (const conn of conns.slice(0, 2)) {
      if (!conn.related || !conn.related.length) continue;
      const grouped = {};
      for (const r of conn.related.slice(0, 8)) {
        if (!grouped[r.rel]) grouped[r.rel] = [];
        grouped[r.rel].push(r.node.label);
      }
      const relLines = [];
      for (const [rel, items] of Object.entries(grouped)) {
        relLines.push('  ' + rel + ': ' + items.slice(0, 4).join(', '));
      }
      if (relLines.length) {
        lines.push((conn.node.type === 'person' ? '👤 ' : conn.node.type === 'project' ? '📁 ' : '📄 ') + conn.node.label);
        lines.push(...relLines);
        added++;
      }
    }
    return added > 0 ? lines.join('\n').slice(0, 800) : '';
  } catch (_) { return ''; }
}

// MCP-стиль обогащение: ищет связанное в Confluence/JIRA когда вопрос про задачи/доки
async function enrichFromIntegrations(query) {
  const lower = query.toLowerCase();
  const wantsJira = /задач|тикет|jira|ticket|issue|баг|спринт|bitask/i.test(lower);
  const wantsConf = /confluence|документац|страниц|вики|wiki|инструкци|регламент/i.test(lower);
  if (!wantsJira && !wantsConf) return '';

  const parts = [];

  if (wantsJira) {
    try {
      const jira = getJIRA();
      // Ищем по тексту запроса в проекте
      const cleanQ = query.replace(/[^а-яёa-z0-9 ]/gi, ' ').trim().split(/\s+/).slice(0, 4).join(' ');
      const jql = 'text ~ "' + cleanQ + '" ORDER BY updated DESC';
      const issues = await jira.searchIssues(jql, 5);
      if (issues && issues.length) {
        const lines = ['\n\n🎫 Связанные задачи JIRA:'];
        for (const it of issues.slice(0, 5)) {
          const key = it.key || '';
          const sum = (it.fields && it.fields.summary) || it.summary || '';
          const st  = (it.fields && it.fields.status && it.fields.status.name) || '';
          lines.push('• ' + key + ' — ' + sum.slice(0, 60) + (st ? ' [' + st + ']' : ''));
        }
        parts.push(lines.join('\n'));
      }
    } catch (e) { /* JIRA недоступна — молча */ }
  }

  if (wantsConf) {
    try {
      const conf = getConfluence();
      const pages = await conf.searchPages(query, 5);
      if (pages && pages.length) {
        const lines = ['\n\n📘 Confluence:'];
        for (const p of pages.slice(0, 5)) {
          const title = p.title || (p.content && p.content.title) || '';
          lines.push('• ' + title.slice(0, 70));
        }
        parts.push(lines.join('\n'));
      }
    } catch (e) { /* Confluence недоступен — молча */ }
  }

  return parts.join('');
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
          '/last — последние события\n/rf — поиск по Request Form файлам\n/embcheck — проверка embedding/rerank\n/checktoken — проверить все токены\n/security — ИБ дайджест\n/pii — сканирование PII\n/classify <запрос> — классификация\n/audit — лог доступов\n/refresh — переиндексировать\n/sync — синхронизация\n' +
          '/model — сменить LLM\n/usage — токены\n/clear — очистить диалог\n' +
          '🎤 Голосовое → транскрипция + поиск';

  await reply(msg, text, inlineKb([
    [{ text: '💡 Инсайты',        callback_data: 'insights'     }, { text: '📊 Аналитика',  callback_data: 'analytics'   }],
    [{ text: '📧 Саммари почты',  callback_data: 'sum_email'    }, { text: '💬 Чаты',       callback_data: 'sum_chat'    }],
    [{ text: '📋 Задачи',         callback_data: 'tasks'        }, { text: '🗓 Дайджест',   callback_data: 'digest'      }],
    [{ text: '👥 Контакты',       callback_data: 'contacts'     }, { text: '⭐ Избранное',  callback_data: 'favorites'   }],
    [{ text: '🔍 Папки',          callback_data: 'where'        }, { text: '🔄 Переиндекс', callback_data: 'refresh'     }],
    [{ text: '🕐 Последние',       callback_data: 'last_events'  }],
    [{ text: '🔐 ИБ Дайджест',      callback_data: 'security'     }, { text: '🔍 Скан PII',  callback_data: 'pii_scan'  }],
    [{ text: '🛡️ Дашборд рисков',   callback_data: 'risk_dash'    }, { text: '📤 Граф связей', callback_data: 'ext_graph' }],
    [{ text: '🌡️ Тепловая карта',   callback_data: 'heatmap'      }, { text: '📈 Тренд ИБ',     callback_data: 'trend'     }],
    [{ text: '🚨 Аномалии',          callback_data: 'anomaly'      }, { text: '🕸️ Паттерны',     callback_data: 'patterns'  }],
    [{ text: '😤 Тональность',       callback_data: 'sentiment'    }, { text: '📂 Процессы',     callback_data: 'processes' }],
    [{ text: '📋 Дубликаты',         callback_data: 'duplicates'   }],
    [{ text: '🏢 Риски по отделам', callback_data: 'depts'        }],
    [{ text: '📊 ИБ Отчёт',         callback_data: 'ib_report'    }],
    [{ text: '💾 Синхронизация',  callback_data: 'sync_menu'   }, { text: '🤖 Модель',     callback_data: 'switch_model'}],
    [{ text: '📊 Токены',         callback_data: 'show_usage'   }],
    [{ text: '🔑 Проверить токены', callback_data: 'checktoken'   }],
  ]));
});

// ── /embcheck — проверка embedding и rerank эндпоинтов ──
bot.onText(/\/reranker(?:\s+(on|off|status))?/, async (msg, match) => {
  if (!checkAccess(msg.from.id)) return;
  auditLog(msg.from.id, '/reranker');
  const arg = (match[1] || 'status').trim();

  if (arg === 'on') {
    USE_LOCAL_RERANKER = true;
    const sent = await reply(msg, '🔄 Включаю локальный reranker (bge-reranker)...');
    const ok = await embeddingSearch.initReranker();
    await edit(msg.chat.id, sent.message_id, ok
      ? '✅ Локальный reranker включён.\nПоиск теперь использует cross-encoder вместо LLM — быстрее и точнее.'
      : '⚠️ Не удалось загрузить модель. Реранк остаётся через LLM.\nПри первом запуске модель скачивается (~100МБ).');
  } else if (arg === 'off') {
    USE_LOCAL_RERANKER = false;
    await reply(msg, '✅ Локальный reranker выключен. Реранк через LLM-промпт.');
  } else {
    await reply(msg, [
      '🔀 Reranker — переранжирование результатов поиска',
      '',
      'Статус: ' + (USE_LOCAL_RERANKER ? '🟢 локальный (bge-reranker)' : '🟡 LLM-промпт'),
      '',
      '/reranker on — включить локальный cross-encoder',
      '/reranker off — вернуть LLM-реранк',
      '',
      'Локальный быстрее и не тратит запросы к LLM,',
      'но требует ~100МБ на модель (скачивается раз).',
    ].join('\n'));
  }
});

bot.onText(/\/embcheck/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  auditLog(msg.from.id, '/embcheck');
  const sent = await reply(msg, '🔍 Перебираю эндпоинты embedding и rerank...');

  const lines = ['🔬 Автопоиск эндпоинтов Ашан\n'];
  const testAgent = new (require('https').Agent)({ rejectUnauthorized: false });
  const base = (cfg.AUCHAN_LLM_URL || '').replace(/\/+$/, '');
  const baseRoot = base.replace(/\/v1$/, '');
  const headers = {
    'X-Gravitee-Api-Key': cfg.AUCHAN_API_KEY,
    'Authorization': 'Bearer ' + (cfg.AUCHAN_BEARER || ''),
    'Content-Type': 'application/json',
  };

  // Локальный embedding
  lines.push('📐 ЛОКАЛЬНЫЙ EMBEDDING:');
  try {
    const { embeddingSearch } = require('./indexer');
    lines.push(embeddingSearch && embeddingSearch.ready ? '  ✅ e5-small (384 разм.)' : '  ⚠️ не загружен');
  } catch (_) {}

  // Перебор EMBEDDING
  lines.push('\n📐 ПОИСК EMBEDDING (Ашан):');
  const embUrls = [base + '/embeddings', baseRoot + '/embeddings', base + '/embed', baseRoot + '/v1/embeddings'];
  const embModels = [cfg.AUCHAN_EMBEDDING_MODEL || 'qwen3-embedding', 'qwen2-embedding', 'bge-m3', 'text-embedding'];
  const embBodies = (model, text) => [
    { input: text, model }, { input: [text], model }, { text, model }, { inputs: text, model },
  ];
  let embFound = null;
  outerEmb:
  for (const url of embUrls) {
    for (const model of embModels) {
      for (const body of embBodies(model, 'тест')) {
        try {
          const { data } = await axios.post(url, body, { headers, httpsAgent: testAgent, timeout: 12000 });
          const vec = (data.data && data.data[0] && data.data[0].embedding) || data.embedding || (data.embeddings && data.embeddings[0]);
          if (vec && vec.length) { embFound = { url, model, body: Object.keys(body).join('+'), dim: vec.length }; break outerEmb; }
        } catch (e) { if (e.response && e.response.status === 404) break; }
      }
    }
  }
  if (embFound) {
    lines.push('  ✅ НАЙДЕНО!');
    lines.push('     URL: ' + embFound.url);
    lines.push('     Модель: ' + embFound.model);
    lines.push('     Тело: {' + embFound.body + '}, разм: ' + embFound.dim);
    lines.push('  В .env: AUCHAN_EMBEDDING_URL=' + embFound.url);
    lines.push('          AUCHAN_EMBEDDING_MODEL=' + embFound.model);
  } else {
    lines.push('  ❌ Не найден (перебрано ' + (embUrls.length*embModels.length*4) + ' комбинаций)');
  }

  // Перебор RERANK
  lines.push('\n🔀 ПОИСК RERANK (Ашан):');
  const rrUrls = [base + '/rerank', baseRoot + '/rerank', base + '/reranking', baseRoot + '/v1/rerank'];
  const rrModels = [cfg.AUCHAN_RERANK_MODEL || 'qwen3-reranker', 'qwen2-reranker', 'bge-reranker-v2-m3', 'rerank'];
  const rrBodies = (model) => [
    { model, query: 'тест', documents: ['док один', 'док два'] },
    { model, query: 'тест', texts: ['док один', 'док два'] },
    { query: 'тест', documents: ['док один', 'док два'] },
    { model, query: 'тест', passages: ['док один', 'док два'] },
  ];
  let rrFound = null;
  outerRr:
  for (const url of rrUrls) {
    for (const model of rrModels) {
      for (const body of rrBodies(model)) {
        try {
          const { data } = await axios.post(url, body, { headers, httpsAgent: testAgent, timeout: 12000 });
          if (data.results || data.scores || (data.data && Array.isArray(data.data)) || data.rankings) {
            rrFound = { url, model, body: Object.keys(body).join('+') }; break outerRr;
          }
        } catch (e) { if (e.response && e.response.status === 404) break; }
      }
    }
  }
  if (rrFound) {
    lines.push('  ✅ НАЙДЕНО!');
    lines.push('     URL: ' + rrFound.url);
    lines.push('     Модель: ' + rrFound.model);
    lines.push('     Тело: {' + rrFound.body + '}');
    lines.push('  В .env: AUCHAN_RERANK_URL=' + rrFound.url);
    lines.push('          AUCHAN_RERANK_MODEL=' + rrFound.model);
  } else {
    lines.push('  ❌ Не найден. Reranking через LLM-промпт');
  }

  await edit(msg.chat.id, sent.message_id, lines.join('\n').slice(0, 4000));
});

// ── /rf — поиск по Request Form файлам ──
// ── /rffill — пакетное заполнение всех строк TESTing.xlsx ──
bot.onText(/\/rffill(?:\s+(\S+))?/, async (msg, match) => {
  if (!checkAccess(msg.from.id)) return;
  auditLog(msg.from.id, '/rffill');
  const flag = (match[1] || '').trim();
  const sent = await reply(msg, '⚙️ Запускаю пакетное заполнение TESTing.xlsx...\nЭто может занять несколько минут.');

  try {
    const { execFile } = require('child_process');
    const args = ['fill_testing.js'];
    if (flag === 'overwrite') args.push('--overwrite');
    // По умолчанию создаёт отдельный файл _filled, без LLM (быстрее, парсинг точный)
    args.push('--no-llm');

    const child = execFile('node', args, { cwd: process.cwd(), timeout: 600000, maxBuffer: 10*1024*1024 },
      async (err, stdout, stderr) => {
        // Извлекаем итоговую строку
        const summary = (stdout || '').split('\n').filter(l =>
          l.includes('Итог') || l.includes('заполнено') || l.includes('Загружено') || l.includes('Сохранено')
        ).join('\n');
        const result = err
          ? '⚠️ Заполнение завершилось с ошибкой:\n' + (stderr || err.message).slice(0, 500)
          : '✅ Заполнение завершено:\n' + (summary || stdout.slice(-500));
        try { await edit(msg.chat.id, sent.message_id, result.slice(0, 4000)); } catch (_) {}
      }
    );
  } catch (e) {
    await edit(msg.chat.id, sent.message_id, '❌ Ошибка запуска: ' + e.message);
  }
});

bot.onText(/\/rf(?!fill)(?:\s+([\s\S]+))?/, async (msg, match) => {
  if (!checkAccess(msg.from.id)) return;
  auditLog(msg.from.id, '/rf');
  const uid  = msg.from.id;
  const args = (match[1] || '').trim();

  // /rf без аргументов или /rf help — справка
  if (!args || args === 'help') {
    await reply(msg, [
      '📋 Поиск по Request Form (РФ) файлам',
      '',
      'Команды:',
      '/rf list — список всех РФ-файлов с оценкой токенов',
      '/rf <IP> — загрузить документ по IP-адресу',
      '/rf <IP> <вопрос> — задать вопрос по документу',
      '/rf <вопрос> — вопрос по текущему загруженному документу',
      '',
      'Примеры:',
      '/rf list',
      '/rf 10.156.1.40',
      '/rf 10.156.1.40 кто ответственный за систему?',
      '/rf какие сетевые потоки открыты?',
      '',
      'Документ загружается целиком в LLM. Большие файлы',
      'автоматически разбиваются на части для поиска.',
    ].join('\n'));
    return;
  }

  // /rf list — список файлов
  if (args === 'list' || args === 'список') {
    const sent = await reply(msg, '📥 Загружаю список РФ-файлов...');
    try {
      const files = await rfGetFileList();
      const header = '📋 Request Form файлы (' + files.length + '):';
      const blocks = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const isPart = f.is ? ' — ' + f.is.slice(0, 25) : '';
        let block = (i+1) + '. IP ' + f.ip + isPart;
        if (f.link) block += '\n   🔗 ' + f.link;
        blocks.push(block);
      }

      // Разбиваем на сообщения по ~3800 символов
      const messages = [];
      let cur = header;
      for (const b of blocks) {
        if ((cur + '\n' + b).length > 3800) { messages.push(cur); cur = ''; }
        cur += (cur ? '\n' : '') + b;
      }
      if (cur) messages.push(cur);
      messages[messages.length - 1] += '\n\nЗагрузить: /rf <IP>';

      // Первое сообщение — редактируем, остальные — новые
      await edit(msg.chat.id, sent.message_id, messages[0]);
      for (let m = 1; m < messages.length; m++) {
        await reply(msg, messages[m]);
      }
    } catch (e) {
      await edit(msg.chat.id, sent.message_id, '❌ Ошибка: ' + e.message);
    }
    return;
  }

  // Парсим: первый токен может быть IP, остальное — вопрос
  const ipMatch = args.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s*([\s\S]*)$/);

  if (ipMatch) {
    // /rf <IP> [вопрос]
    const ip       = ipMatch[1];
    const question = (ipMatch[2] || '').trim();
    const sent = await reply(msg, '📥 Загружаю документ для IP ' + ip + '...');

    try {
      // Находим файл по IP
      const files = await rfGetFileList();
      const file  = files.find(f => f.ip === ip) || files.find(f => f.ip.includes(ip));
      if (!file) {
        await edit(msg.chat.id, sent.message_id, '❌ IP ' + ip + ' не найден в TESTing.xlsx\nПопробуйте /rf list');
        return;
      }

      // Загружаем документ (с кэшем)
      let docText = RF_DOC_CACHE.get(file.link);
      if (!docText) {
        const buf = await rfDownload(file.link);
        docText = rfBuildFullText(buf);
        RF_DOC_CACHE.set(file.link, docText);
      }
      const tokens = rfEstimateTokens(docText);

      // Сохраняем как текущий документ пользователя
      RF_STATE.set(uid, { ip, docText, tokens, is: file.is });

      if (!question) {
        // Просто показываем инфо о документе
        await edit(msg.chat.id, sent.message_id, [
          '✅ Документ загружен:',
          'IP: ' + ip,
          'ИС: ' + (file.is || '—'),
          'Символов: ' + docText.length.toLocaleString('ru'),
          'Токенов: ~' + tokens.toLocaleString('ru'),
          tokens > 16000 ? '\n⚠️ Большой документ — поиск по частям' : '',
          '\nТеперь задайте вопрос: /rf <ваш вопрос>',
        ].filter(Boolean).join('\n'));
      } else {
        // Сразу отвечаем на вопрос
        await edit(msg.chat.id, sent.message_id, '🤔 Анализирую документ (' + tokens.toLocaleString('ru') + ' токенов)...');
        const answer = await rfAskLLM(docText, question, uid);
        await edit(msg.chat.id, sent.message_id,
          ('📋 IP ' + ip + ' | ' + (file.is || '') + '\n\n❓ ' + question + '\n\n💡 ' + answer).slice(0, 4000));
      }
    } catch (e) {
      await edit(msg.chat.id, sent.message_id, '❌ Ошибка: ' + e.message);
    }
    return;
  }

  // /rf <вопрос> — вопрос по уже загруженному документу
  const state = RF_STATE.get(uid);
  if (!state) {
    await reply(msg, '❓ Сначала загрузите документ: /rf <IP>\nИли посмотрите список: /rf list');
    return;
  }

  const sent = await reply(msg, '🤔 Ищу в документе IP ' + state.ip + '...');
  try {
    const answer = await rfAskLLM(state.docText, args, uid);
    await edit(msg.chat.id, sent.message_id,
      ('📋 IP ' + state.ip + ' | ' + (state.is || '') + '\n\n❓ ' + args + '\n\n💡 ' + answer).slice(0, 4000));
  } catch (e) {
    await edit(msg.chat.id, sent.message_id, '❌ Ошибка: ' + e.message);
  }
});

// ── /anomaly — аномалии активности ──
bot.onText(/\/anomaly/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  auditLog(msg.from.id, '/anomaly');
  await reply(msg, detectActivityAnomalies().slice(0, 4000));
});

// ── /patterns — паттерны коммуникации ──
bot.onText(/\/patterns/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  auditLog(msg.from.id, '/patterns');
  await reply(msg, getCommunicationPatterns().slice(0, 4000));
});

// ── /sentiment — тональность ──
bot.onText(/\/sentiment/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  auditLog(msg.from.id, '/sentiment');
  const sent = await reply(msg, '😤 Анализирую тональность...');
  try {
    const text = await analyzeSentiment(msg.from.id);
    await edit(msg.chat.id, sent.message_id, text.slice(0, 4000));
  } catch (e) { await edit(msg.chat.id, sent.message_id, '❌ ' + e.message); }
});

// ── /processes — классификация по процессам ──
bot.onText(/\/processes/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  auditLog(msg.from.id, '/processes');
  await reply(msg, classifyByProcess().slice(0, 4000));
});

// ── /duplicates — дубликаты документов ──
bot.onText(/\/duplicates/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  auditLog(msg.from.id, '/duplicates');
  await reply(msg, findDuplicates().slice(0, 4000));
});

// ── /heatmap — тепловая карта ──
bot.onText(/\/heatmap/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  auditLog(msg.from.id, '/heatmap');
  await reply(msg, getHeatmap().slice(0, 4000));
});

// ── /trend — тренд ИБ инцидентов ──
bot.onText(/\/trend/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  auditLog(msg.from.id, '/trend');
  await reply(msg, getSecurityTrend().slice(0, 4000));
});

// ── /depts — дашборд по отделам ──
bot.onText(/\/depts/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  auditLog(msg.from.id, '/depts');
  await reply(msg, getDeptRiskDashboard().slice(0, 4000));
});

// ── /risk — дашборд рисков ──
bot.onText(/\/risk/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  auditLog(msg.from.id, '/risk');
  const sent = await reply(msg, '🛡️ Формирую дашборд рисков...');
  try {
    const text = getRiskDashboard();
    for (let i = 0; i < text.length; i += 4000)
      i === 0
        ? await edit(msg.chat.id, sent.message_id, text.slice(0, 4000))
        : await reply(msg, text.slice(i, i + 4000));
  } catch (e) {
    await edit(msg.chat.id, sent.message_id, '❌ ' + e.message);
  }
});

// ── /graph — граф внешних коммуникаций ──
bot.onText(/\/graph(?!rag)\b/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  auditLog(msg.from.id, '/graph');
  const sent = await reply(msg, '📤 Строю граф внешних получателей...');
  try {
    await edit(msg.chat.id, sent.message_id, getExternalRecipientsGraph());
  } catch (e) {
    await edit(msg.chat.id, sent.message_id, '❌ ' + e.message);
  }
});

// ── /ibreport — полный ИБ отчёт ──
bot.onText(/\/ibreport/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  auditLog(msg.from.id, '/ibreport');
  const sent = await reply(msg, '🔐 Генерирую ИБ отчёт (может занять минуту)...');
  try {
    const report = await weeklySecurityReport(msg.from.id);
    await bot.deleteMessage(msg.chat.id, sent.message_id);
    for (let i = 0; i < report.length; i += 4000)
      await reply(msg, report.slice(i, i + 4000));
  } catch (e) {
    await edit(msg.chat.id, sent.message_id, '❌ ' + e.message);
  }
});

// ── /graphrag — граф знаний ──
bot.onText(/\/graphrag(.*)/, async (msg, match) => {
  if (!checkAccess(msg.from.id)) return;
  auditLog(msg.from.id, '/graphrag', match[1]);
  const query = (match[1] || '').trim();
  const sent  = await reply(msg, '🕸️ Анализирую граф знаний...');
  try {
    const graph = getGraph();
    if (!query) {
      // Показываем статистику и топ сущностей
      const s = graph.stats();
      const lines = ['🕸️ Граф знаний\n'];
      lines.push('Узлов: ' + s.nodes + ' | Связей: ' + s.edges);
      lines.push('Типы: ' + Object.entries(s.byType).map(([t,n]) => t+'('+n+')').join(', '));
      lines.push('\n👤 Топ людей:');
      for (const n of graph.topEntities('person', 8))
        lines.push('   ' + n.label + ' — ' + n.count + ' упоминаний');
      lines.push('\n📁 Топ проектов:');
      for (const n of graph.topEntities('project', 8))
        lines.push('   ' + n.label + ' — ' + n.count);
      lines.push('\n💡 Используйте: /graphrag <имя или проект>');
      await edit(msg.chat.id, sent.message_id, lines.join('\n').slice(0, 4000));
    } else {
      const connections = graph.getConnections(query);
      await edit(msg.chat.id, sent.message_id, formatConnections(connections).slice(0, 4000));
    }
  } catch (e) {
    await edit(msg.chat.id, sent.message_id, '❌ ' + e.message);
  }
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
bot.onText(/\/sync(?!status)\b/, async (msg) => {
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
    const answer = useMultiHop
      ? await multiHopRag(msg.text, { uid: msg.from.id, docType: dt, folders: filt.folders })
      : await ragAsk(msg.text, { uid: msg.from.id, docType: dt, folders: filt.folders });
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

  if (data === 'anomaly') {
    await edit(cid, mid, '🚨 Анализирую аномалии...');
    try { await edit(cid, mid, detectActivityAnomalies().slice(0, 4000)); }
    catch (e) { await edit(cid, mid, '❌ ' + e.message); }
    return;
  }

  if (data === 'patterns') {
    await edit(cid, mid, '🕸️ Строю граф коммуникаций...');
    try { await edit(cid, mid, getCommunicationPatterns().slice(0, 4000)); }
    catch (e) { await edit(cid, mid, '❌ ' + e.message); }
    return;
  }

  if (data === 'sentiment') {
    await edit(cid, mid, '😤 Анализирую тональность...');
    try { await edit(cid, mid, (await analyzeSentiment(uid)).slice(0, 4000)); }
    catch (e) { await edit(cid, mid, '❌ ' + e.message); }
    return;
  }

  if (data === 'processes') {
    await edit(cid, mid, '📂 Классифицирую по процессам...');
    try { await edit(cid, mid, classifyByProcess().slice(0, 4000)); }
    catch (e) { await edit(cid, mid, '❌ ' + e.message); }
    return;
  }

  if (data === 'duplicates') {
    await edit(cid, mid, '📋 Ищу дубликаты...');
    try { await edit(cid, mid, findDuplicates().slice(0, 4000)); }
    catch (e) { await edit(cid, mid, '❌ ' + e.message); }
    return;
  }

  if (data === 'heatmap') {
    await edit(cid, mid, '🌡️ Строю тепловую карту...');
    try { await edit(cid, mid, getHeatmap().slice(0, 4000)); }
    catch (e) { await edit(cid, mid, '❌ ' + e.message); }
    return;
  }

  if (data === 'trend') {
    await edit(cid, mid, '📈 Анализирую тренды...');
    try { await edit(cid, mid, getSecurityTrend().slice(0, 4000)); }
    catch (e) { await edit(cid, mid, '❌ ' + e.message); }
    return;
  }

  if (data === 'depts') {
    await edit(cid, mid, '🏢 Анализирую отделы...');
    try { await edit(cid, mid, getDeptRiskDashboard().slice(0, 4000)); }
    catch (e) { await edit(cid, mid, '❌ ' + e.message); }
    return;
  }

  if (data === 'risk_dash') {
    auditLog(uid, 'risk_dash');
    await edit(cid, mid, '🛡️ Формирую дашборд рисков...');
    try { await edit(cid, mid, getRiskDashboard().slice(0, 4000)); }
    catch (e) { await edit(cid, mid, '❌ ' + e.message); }
    return;
  }

  if (data === 'ext_graph') {
    auditLog(uid, 'ext_graph');
    await edit(cid, mid, '📤 Строю граф...');
    try { await edit(cid, mid, getExternalRecipientsGraph()); }
    catch (e) { await edit(cid, mid, '❌ ' + e.message); }
    return;
  }

  if (data === 'ib_report') {
    auditLog(uid, 'ib_report');
    await edit(cid, mid, '🔐 Генерирую ИБ отчёт...');
    try {
      const report = await weeklySecurityReport(uid);
      await edit(cid, mid, report.slice(0, 4000));
    } catch (e) { await edit(cid, mid, '❌ ' + e.message); }
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


// ── ТЕПЛОВАЯ КАРТА АКТИВНОСТИ ──
function getHeatmap() {
  // Активность по дням недели и часам
  const heatmap = {};
  const days    = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
  const hours   = [9,10,11,12,13,14,15,16,17,18,19,20];

  for (const day of days)
    for (const h of hours)
      heatmap[day+':'+h] = 0;

  for (const doc of vaultIndex.docs.filter(d => d.type==='email' && d.date)) {
    try {
      const dt  = new Date(doc.date);
      const day = days[dt.getDay()===0?6:dt.getDay()-1];
      const h   = dt.getHours();
      if (days.includes(day) && hours.includes(h))
        heatmap[day+':'+h] = (heatmap[day+':'+h]||0)+1;
    } catch(_) {}
  }

  const lines = ['🌡️ Тепловая карта активности\n'];
  lines.push('     ' + hours.map(h => String(h).padStart(2)).join(' '));

  for (const day of days) {
    const vals = hours.map(h => heatmap[day+':'+h]||0);
    const max  = Math.max(...vals, 1);
    const bar  = vals.map(v => {
      const ratio = v/max;
      if (ratio === 0)   return '·';
      if (ratio < 0.25)  return '░';
      if (ratio < 0.5)   return '▒';
      if (ratio < 0.75)  return '▓';
      return '█';
    }).join(' ');
    const total = vals.reduce((a,b)=>a+b,0);
    lines.push(day + '  ' + bar + '  ' + total);
  }

  // Пик активности
  let peakDay = '', peakHour = 0, peakVal = 0;
  for (const [key, val] of Object.entries(heatmap)) {
    if (val > peakVal) { peakVal = val; [peakDay, peakHour] = key.split(':'); }
  }
  if (peakVal > 0)
    lines.push('\n🔥 Пик: ' + peakDay + ' в ' + peakHour + ':00 (' + peakVal + ' писем)');

  return lines.join('\n');
}

// ── TREND ИБ ИНЦИДЕНТОВ ──
function getSecurityTrend() {
  const SEC_KW = ['инцидент','взлом','утечка','доступ','пароль','уязвимость',
                  'incident','breach','phishing','фишинг','атака','malware',
                  'suspicious','подозрительн','compromise'];

  // Группируем по неделям (последние 12 недель)
  const weeks  = {};
  const now    = Date.now();

  for (const doc of vaultIndex.docs.filter(d => d.type==='email' && d.date)) {
    try {
      const dt      = new Date(doc.date);
      const daysAgo = Math.floor((now - dt.getTime()) / 86400000);
      if (daysAgo > 84) continue; // 12 недель

      const weekNum = Math.floor(daysAgo / 7);
      const weekKey = 'W-' + weekNum;

      const text    = ((doc.subject||'') + ' ' + (doc.body||'').slice(0,300)).toLowerCase();
      const isIB    = SEC_KW.some(kw => text.includes(kw));

      if (!weeks[weekKey]) weeks[weekKey] = { total: 0, ib: 0, week: weekNum };
      weeks[weekKey].total++;
      if (isIB) weeks[weekKey].ib++;
    } catch(_) {}
  }

  const sorted = Object.values(weeks).sort((a,b) => b.week-a.week).slice(0,8).reverse();
  if (!sorted.length) return '📈 Недостаточно данных для тренда.';

  const lines = ['📈 Trend ИБ инцидентов (8 недель)\n'];
  const maxIB = Math.max(...sorted.map(w=>w.ib), 1);

  for (const w of sorted) {
    const label   = 'Нед-' + w.week;
    const bar     = '█'.repeat(Math.round(w.ib/maxIB*15));
    const pct     = w.total > 0 ? Math.round(w.ib/w.total*100) : 0;
    const alert   = w.ib > 3 ? ' ⚠️' : '';
    lines.push(label + ' ' + bar.padEnd(15) + ' ' + w.ib + ' ИБ / ' + w.total + ' всего (' + pct + '%)' + alert);
  }

  // Тренд (растёт или падает)
  if (sorted.length >= 2) {
    const last2weeks  = sorted.slice(-2).map(w=>w.ib);
    const trend       = last2weeks[1] > last2weeks[0] ? '📈 Растёт' : last2weeks[1] < last2weeks[0] ? '📉 Снижается' : '➡️ Стабильно';
    const totalIB     = sorted.reduce((s,w)=>s+w.ib,0);
    const totalEmails = sorted.reduce((s,w)=>s+w.total,0);
    lines.push('\n' + trend + ' | Всего ИБ писем: ' + totalIB + ' из ' + totalEmails);
  }

  // По отделам (из папок)
  const deptStats = {};
  for (const doc of vaultIndex.docs.filter(d => d.type==='email')) {
    const text   = ((doc.subject||'') + ' ' + (doc.body||'').slice(0,200)).toLowerCase();
    const isIB   = SEC_KW.some(kw => text.includes(kw));
    if (!isIB) continue;
    const folder = (doc.folder||'Unknown').split('/')[0].slice(0,20);
    deptStats[folder] = (deptStats[folder]||0)+1;
  }
  const topDepts = Object.entries(deptStats).sort((a,b)=>b[1]-a[1]).slice(0,5);
  if (topDepts.length) {
    lines.push('\n📁 По папкам/отделам:');
    for (const [dept, cnt] of topDepts)
      lines.push('   ' + dept + ': ' + cnt + ' ИБ событий');
  }

  return lines.join('\n');
}

// ── ДАШБОРД РИСКОВ ПО ОТДЕЛАМ ──
function getDeptRiskDashboard() {
  const PII_RE = [
    /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g,
    /\b\d{3}\-\d{3}\-\d{3}\s?\d{2}\b/g,
    /\b\d{4}\s?\d{6}\b/g,
  ];

  const deptRisk = {};

  for (const doc of vaultIndex.docs.filter(d => ['email','disk_file'].includes(d.type))) {
    const folder = (doc.folder || doc.path || 'Unknown').split('/')[0].slice(0, 25);
    const body   = (doc.body||'').slice(0,3000);
    let   score  = 0;
    for (const re of PII_RE) {
      re.lastIndex = 0;
      const m = body.match(re);
      if (m) score += m.length * 5;
    }
    if (score > 0) {
      if (!deptRisk[folder]) deptRisk[folder] = { score: 0, docs: 0 };
      deptRisk[folder].score += score;
      deptRisk[folder].docs++;
    }
  }

  const sorted = Object.entries(deptRisk).sort((a,b)=>b[1].score-a[1].score).slice(0,10);
  if (!sorted.length) return '✅ Рискованных папок не обнаружено.';

  const lines = ['🏢 Дашборд рисков по отделам/папкам\n'];
  const maxScore = sorted[0][1].score;

  for (const [dept, { score, docs }] of sorted) {
    const level = score >= 50 ? '🔴' : score >= 20 ? '🟠' : '🟡';
    const bar   = '█'.repeat(Math.round(score/maxScore*12));
    lines.push(level + ' ' + dept.padEnd(22) + ' ' + bar + ' ' + score + ' (' + docs + ' doc)');
  }

  lines.push('\n💡 Рекомендация: проверьте документы в красных папках командой /pii');
  return lines.join('\n');
}


// ══════════════════════════════════════════════
//  📊 ПОВЕДЕНЧЕСКАЯ И КОНТЕНТНАЯ АНАЛИТИКА
// ══════════════════════════════════════════════

// Аномалии активности — резкий рост писем
function detectActivityAnomalies() {
  const now    = Date.now();
  const emails = vaultIndex.docs.filter(d => d.type === 'email' && d.date);
  const lines  = ['🚨 Аномалии активности\n'];

  // Объём по неделям
  const byWeek = {};
  for (const doc of emails) {
    try {
      const daysAgo = Math.floor((now - new Date(doc.date).getTime()) / 86400000);
      if (daysAgo > 56) continue;
      const wk = Math.floor(daysAgo / 7);
      byWeek[wk] = (byWeek[wk] || 0) + 1;
    } catch (_) {}
  }

  // Сравниваем текущую и прошлую недели
  const thisWeek = byWeek[0] || 0;
  const lastWeek = byWeek[1] || 1;
  const ratio    = thisWeek / lastWeek;
  if (ratio >= 3) {
    lines.push('🔴 КРИТИЧНО: Рост писем в ' + ratio.toFixed(1) + 'x (неделя: ' + thisWeek + ' vs ' + lastWeek + ')');
    lines.push('   Возможна утечка данных или массовая рассылка!');
  } else if (ratio >= 2) {
    lines.push('🟠 ВНИМАНИЕ: Рост писем в ' + ratio.toFixed(1) + 'x (неделя: ' + thisWeek + ' vs ' + lastWeek + ')');
  } else {
    lines.push('✅ Объём писем в норме (' + thisWeek + ' на этой неделе)');
  }

  // Массовая пересылка на внешние адреса
  const EXTERNAL = ['gmail.com','yandex.ru','mail.ru','yahoo.com','outlook.com','hotmail.com'];
  const extForwards = new Map();
  const recentEmails = emails.filter(d => {
    try { return (now - new Date(d.date).getTime()) < 7 * 86400000; } catch (_) { return false; }
  });

  for (const doc of recentEmails) {
    const body = doc.body || '';
    const toMatches = body.match(/[\w._%+\-]+@[\w.\-]+\.[a-zA-Z]{2,}/g) || [];
    for (const email of toMatches) {
      const domain = email.split('@')[1] || '';
      if (EXTERNAL.some(d => domain.includes(d))) {
        extForwards.set(email, (extForwards.get(email) || 0) + 1);
      }
    }
  }

  const massForward = [...extForwards.entries()]
    .filter(([, cnt]) => cnt >= 3)
    .sort((a, b) => b[1] - a[1]);

  if (massForward.length) {
    lines.push('\n🔴 Массовая пересылка на внешние адреса (7 дней):');
    for (const [email, cnt] of massForward.slice(0, 5))
      lines.push('   ' + email + ': ' + cnt + ' писем');
  } else {
    lines.push('\n✅ Массовой пересылки не обнаружено');
  }

  // Необычные файлы (доступ к редко открываемым)
  const diskDocs = vaultIndex.docs.filter(d => d.type === 'disk_file' && d.date);
  const recentDisk = diskDocs.filter(d => {
    try { return (now - new Date(d.date).getTime()) < 7 * 86400000; } catch (_) { return false; }
  });
  const oldDisk = diskDocs.filter(d => {
    try { return (now - new Date(d.date).getTime()) > 90 * 86400000; } catch (_) { return false; }
  });

  // Файлы из старых папок которые недавно изменились
  const suspiciousFiles = recentDisk.filter(d =>
    oldDisk.some(old => old.folder === d.folder) && d.date
  ).slice(0, 5);

  if (suspiciousFiles.length) {
    lines.push('\n🟠 Недавно изменённые старые документы:');
    for (const f of suspiciousFiles)
      lines.push('   ' + (f.title || '').slice(0, 50) + '  ' + (f.date || ''));
  }

  return lines.join('\n');
}

// Паттерны коммуникации — граф связей
function getCommunicationPatterns() {
  const emails   = vaultIndex.docs.filter(d => d.type === 'email');
  const contacts = new Map(); // email -> {sent, received, contacts: Set}
  const lines    = ['🕸️ Паттерны коммуникации\n'];

  for (const doc of emails) {
    const from = (doc.from || '').match(/([\w._%+\-]+@[\w.\-]+\.[a-zA-Z]{2,})/);
    if (!from) continue;
    const fromEmail = from[1].toLowerCase();

    if (!contacts.has(fromEmail))
      contacts.set(fromEmail, { sent: 0, received: 0, peers: new Set(), external: 0 });
    contacts.get(fromEmail).sent++;

    const body    = doc.body || '';
    const toEmails = body.match(/[\w._%+\-]+@[\w.\-]+\.[a-zA-Z]{2,}/g) || [];
    for (const to of toEmails) {
      const toEmail = to.toLowerCase();
      if (toEmail === fromEmail) continue;
      contacts.get(fromEmail).peers.add(toEmail);

      const EXTERNAL = ['gmail','yandex.ru','mail.ru','yahoo','outlook'];
      if (EXTERNAL.some(d => toEmail.includes(d)))
        contacts.get(fromEmail).external++;
    }
  }

  // Топ отправителей
  const sorted = [...contacts.entries()]
    .sort((a, b) => b[1].sent - a[1].sent)
    .slice(0, 8);

  lines.push('📤 Топ отправителей:');
  for (const [email, data] of sorted) {
    const extFlag = data.external > 5 ? ' ⚠️ ' + data.external + ' внешних' : '';
    lines.push('   ' + email.slice(0, 35) + ': ' + data.sent + ' писем, ' + data.peers.size + ' контактов' + extFlag);
  }

  // Изолированные — мало связей
  const isolated = [...contacts.entries()]
    .filter(([, d]) => d.peers.size <= 1 && d.sent >= 5)
    .slice(0, 5);

  if (isolated.length) {
    lines.push('\n😶 Потенциально изолированные:');
    for (const [email, data] of isolated)
      lines.push('   ' + email.slice(0, 40) + ': ' + data.sent + ' писем, ' + data.peers.size + ' уник. контактов');
  }

  // Новые внешние контакты (только за последние 30 дней)
  const now        = Date.now();
  const recentDocs = emails.filter(d => {
    try { return (now - new Date(d.date).getTime()) < 30 * 86400000; } catch (_) { return false; }
  });
  const oldDocs = emails.filter(d => {
    try { return (now - new Date(d.date).getTime()) > 30 * 86400000; } catch (_) { return false; }
  });

  const oldContacts = new Set();
  for (const doc of oldDocs) {
    const m = (doc.from || '').match(/([\w._%+\-]+@[\w.\-]+\.[a-zA-Z]{2,})/);
    if (m) oldContacts.add(m[1].toLowerCase());
  }

  const newExternal = new Set();
  for (const doc of recentDocs) {
    const m = (doc.from || '').match(/([\w._%+\-]+@[\w.\-]+\.[a-zA-Z]{2,})/);
    if (!m) continue;
    const email  = m[1].toLowerCase();
    const domain = email.split('@')[1] || '';
    const EXTERNAL = ['gmail','yandex.ru','mail.ru','yahoo','outlook'];
    if (EXTERNAL.some(d => domain.includes(d)) && !oldContacts.has(email))
      newExternal.add(email);
  }

  if (newExternal.size > 0) {
    lines.push('\n🆕 Новые внешние контакты (30 дней): ' + newExternal.size);
    for (const email of [...newExternal].slice(0, 5))
      lines.push('   ' + email);
  }

  return lines.join('\n');
}

// Тональность переписки — негатив, конкуренты, финансы
async function analyzeSentiment(uid = 0) {
  const emails  = vaultIndex.getRecent('email', 14);
  const lines   = ['😤 Анализ тональности переписки\n'];

  // Негативные маркеры
  const NEG_KW  = ['жалоба','проблема','ошибка','нарушение','претензия','недоволен',
                   'срочно','критично','провал','задержка','штраф','блокировка',
                   'complaint','problem','error','urgent','critical','failed','delay'];
  const negMsgs = emails.filter(d => {
    const text = ((d.subject || '') + ' ' + (d.body || '').slice(0, 300)).toLowerCase();
    return NEG_KW.filter(kw => text.includes(kw)).length >= 2;
  });

  if (negMsgs.length) {
    lines.push('🔴 Негативные письма (2 нед): ' + negMsgs.length);
    for (const d of negMsgs.slice(0, 3))
      lines.push('   ' + (d.date || '') + '  ' + (d.subject || '').slice(0, 50));
  } else {
    lines.push('✅ Негативных писем не обнаружено');
  }

  // Упоминание конкурентов
  const COMPETITORS = ['конкурент','auchan','metro','leroy','ikea','ozon','wildberries',
                       'лента','магнит','перекрёсток','пятёрочка','ашан'];
  const compMsgs    = emails.filter(d => {
    const text = ((d.subject || '') + ' ' + (d.body || '').slice(0, 500)).toLowerCase();
    return COMPETITORS.some(c => text.includes(c));
  });

  if (compMsgs.length) {
    lines.push('\n🏢 Упоминания конкурентов: ' + compMsgs.length + ' писем');
    const competitorCount = {};
    for (const d of compMsgs) {
      const text = ((d.subject || '') + ' ' + (d.body || '').slice(0, 500)).toLowerCase();
      for (const c of COMPETITORS)
        if (text.includes(c)) competitorCount[c] = (competitorCount[c] || 0) + 1;
    }
    for (const [comp, cnt] of Object.entries(competitorCount).sort((a,b)=>b[1]-a[1]).slice(0,5))
      lines.push('   ' + comp + ': ' + cnt + ' раз');
  }

  // Финансовые суммы
  const FIN_RE    = /(?:₽|руб|RUB|USD|\$|EUR|€)\s*[\d\s.,]+|[\d\s.,]+\s*(?:₽|руб|RUB|тыс|млн|млрд)/gi;
  const finEmails = emails.filter(d => FIN_RE.test(d.body || ''));
  FIN_RE.lastIndex = 0;

  if (finEmails.length) {
    lines.push('\n💰 Письма с финансовыми суммами: ' + finEmails.length);
    for (const d of finEmails.slice(0, 3))
      lines.push('   ' + (d.date || '') + '  ' + (d.subject || '').slice(0, 50));
  }

  // AI анализ топ-5 писем
  if (emails.length > 0) {
    try {
      const ctx  = emails.slice(0, 5).map(d => (d.subject || '') + ': ' + (d.body || '').slice(0, 100)).join('\n');
      const resp = await callLLM(
        [{ role: 'user', content: 'Общая тональность этих писем (позитивная/нейтральная/негативная) и 2-3 наблюдения:\n' + ctx }],
        { maxTokens: 200, uid }
      );
      lines.push('\n🤖 AI оценка: ' + resp);
    } catch (_) {}
  }

  return lines.join('\n');
}

// Классификация по бизнес-процессам
function classifyByProcess() {
  const PROCESSES = {
    'Продажи':    ['продажа','заказ','клиент','счёт','договор','сделка','offer','sale','order','client'],
    'Закупки':    ['закупка','поставщик','тендер','контракт','поставка','vendor','supply','procurement'],
    'HR':         ['найм','кандидат','собеседование','отпуск','увольнение','hr','вакансия','сотрудник'],
    'Юридические':['договор','соглашение','нда','nda','юрист','legal','contract','суд','иск','претензия'],
    'IT/Техника': ['сервер','база данных','api','баг','деплой','система','техничес','it','software','код'],
    'Финансы':    ['бюджет','оплата','счёт','финанс','платёж','invoice','budget','payment','finance'],
    'ИБ':         ['безопасность','инцидент','доступ','пароль','security','breach','incident','утечка'],
  };

  const counts  = {};
  const total   = vaultIndex.docs.filter(d => d.type === 'email').length || 1;
  for (const proc of Object.keys(PROCESSES)) counts[proc] = 0;

  for (const doc of vaultIndex.docs.filter(d => d.type === 'email')) {
    const text = ((doc.subject || '') + ' ' + (doc.body || '').slice(0, 200)).toLowerCase();
    for (const [proc, keywords] of Object.entries(PROCESSES)) {
      if (keywords.some(kw => text.includes(kw))) counts[proc]++;
    }
  }

  const lines = ['📂 Классификация писем по процессам\n'];
  const maxCnt = Math.max(...Object.values(counts), 1);

  for (const [proc, cnt] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    const pct = Math.round(cnt / total * 100);
    const bar = '█'.repeat(Math.round(cnt / maxCnt * 15));
    lines.push(proc.padEnd(14) + ' ' + bar.padEnd(15) + ' ' + cnt + ' (' + pct + '%)');
  }

  lines.push('\nВсего писем: ' + total);
  lines.push('\n💡 Основная нагрузка: ' +
    Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0]);

  return lines.join('\n');
}

// Дублирование документов
function findDuplicates() {
  const files = vaultIndex.docs.filter(d => d.type === 'disk_file');
  const lines = ['📋 Дублирование документов\n'];

  // Группируем по похожим именам (первые 30 символов)
  const byTitle = new Map();
  for (const f of files) {
    const key = (f.title || '').toLowerCase().replace(/[^а-яёa-z0-9]/g, '').slice(0, 30);
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(f);
  }

  const duplicates = [...byTitle.entries()]
    .filter(([, docs]) => docs.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  if (!duplicates.length) {
    lines.push('✅ Явных дубликатов не обнаружено');
  } else {
    lines.push('⚠️ Потенциальных дубликатов: ' + duplicates.length + ' групп\n');
    for (const [, docs] of duplicates.slice(0, 8)) {
      lines.push('📄 ' + (docs[0].title || '').slice(0, 50) + ' (' + docs.length + ' копий)');
      for (const d of docs)
        lines.push('   └ ' + (d.folder || d.path || '').slice(0, 50) + '  ' + (d.date || ''));
    }
  }

  // Устаревшие документы с PII
  const now         = Date.now();
  const PII_SIMPLE  = [/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
                       /\b\d{3}-\d{3}-\d{3}\s?\d{2}\b/];
  const oldWithPII  = files.filter(f => {
    try {
      const daysOld = (now - new Date(f.date).getTime()) / 86400000;
      if (daysOld < 180) return false;
      const body = f.body || '';
      return PII_SIMPLE.some(re => re.test(body));
    } catch (_) { return false; }
  }).slice(0, 5);

  if (oldWithPII.length) {
    lines.push('\n🔴 Устаревшие документы с PII (>6 мес):');
    for (const f of oldWithPII)
      lines.push('   ' + (f.title || '').slice(0, 50) + '  ' + (f.date || ''));
    lines.push('💡 Рекомендация: проверьте и удалите или зашифруйте');
  }

  return lines.join('\n');
}

// ══════════════════════════════════════════════
//  🔐 ИБ ДАШБОРД — расширенный модуль
// ══════════════════════════════════════════════

// PII паттерны (расширенные)
const PII_PATTERNS_EXT = [
  { name: 'Банк. карта',  re: /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g },
  { name: 'Телефон РФ',   re: /(\+7|8)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/g },
  { name: 'Email',        re: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g },
  { name: 'СНИЛС',        re: /\b\d{3}\-\d{3}\-\d{3}\s?\d{2}\b/g },
  { name: 'ИНН',          re: /\b\d{10,12}\b/g },
  { name: 'Паспорт РФ',   re: /\b\d{4}\s?\d{6}\b/g },
  { name: 'IP адрес',     re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
];

// Внешние домены (не корпоративные)
const EXTERNAL_DOMAINS = ['gmail.com','yandex.ru','mail.ru','yahoo.com','outlook.com','hotmail.com'];

function isExternalEmail(email) {
  if (!email) return false;
  const domain = email.split('@')[1] || '';
  return EXTERNAL_DOMAINS.some(d => domain.includes(d));
}

// Сканирование PII по всем документам
function scanAllPII(maxDocs = 200) {
  const results = [];
  const docs = vaultIndex.docs
    .filter(d => ['disk_file','email','messenger_chat'].includes(d.type))
    .slice(0, maxDocs);

  for (const doc of docs) {
    const body  = (doc.body || '').slice(0, 5000);
    const found = [];
    for (const p of PII_PATTERNS_EXT) {
      p.re.lastIndex = 0;
      const matches = body.match(p.re);
      if (matches && matches.length > 0) {
        const masked = matches.slice(0,2).map(m =>
          m.slice(0,4) + '*'.repeat(Math.max(0, m.length-6)) + m.slice(-2)
        );
        found.push({ type: p.name, count: matches.length, examples: masked });
      }
    }
    if (found.length) results.push({ doc, pii: found });
  }
  return results;
}

// Топ-5 рискованных документов
function getRiskDashboard() {
  const piiDocs  = scanAllPII(100);
  const lines    = ['🛡️ Дашборд рисков ИБ\n'];

  // Топ рискованных документов
  const scored = piiDocs.map(({ doc, pii }) => {
    const score = pii.reduce((s, p) => {
      const weights = { 'Банк. карта': 10, 'Паспорт РФ': 8, 'СНИЛС': 7, 'ИНН': 5, 'Телефон РФ': 3, 'Email': 1, 'IP адрес': 2 };
      return s + (weights[p.type] || 1) * p.count;
    }, 0);
    return { doc, pii, score };
  }).sort((a, b) => b.score - a.score);

  lines.push('📋 Топ-5 рискованных документов:');
  for (const { doc, pii, score } of scored.slice(0, 5)) {
    const level = score >= 20 ? '🔴' : score >= 10 ? '🟠' : '🟡';
    lines.push('');
    lines.push(level + ' ' + (doc.title || '').slice(0, 50));
    lines.push('   Тип: ' + doc.type + '  Дата: ' + (doc.date || '—') + '  Риск: ' + score);
    lines.push('   PII: ' + pii.map(p => p.type + '(' + p.count + ')').join(', '));
  }

  // Статистика по типам PII
  lines.push('\n📊 PII по типам:');
  const piiStats = {};
  for (const { pii } of piiDocs) {
    for (const p of pii) piiStats[p.type] = (piiStats[p.type] || 0) + p.count;
  }
  for (const [type, cnt] of Object.entries(piiStats).sort((a,b) => b[1]-a[1]))
    lines.push('   ' + type + ': ' + cnt + ' шт в ' + piiDocs.filter(r => r.pii.some(p => p.type===type)).length + ' документах');

  // Внешние получатели
  const externalEmails = new Map();
  for (const doc of vaultIndex.docs.filter(d => d.type === 'email')) {
    const to = (doc.body || '').match(/To:.*?([\w._%+\-]+@[\w.\-]+\.[a-zA-Z]{2,})/gi) || [];
    for (const t of to) {
      const email = (t.match(/([\w._%+\-]+@[\w.\-]+\.[a-zA-Z]{2,})/)||[])[1] || '';
      if (isExternalEmail(email)) {
        externalEmails.set(email, (externalEmails.get(email) || 0) + 1);
      }
    }
  }
  if (externalEmails.size > 0) {
    lines.push('\n📤 Внешние получатели писем (топ-5):');
    const sorted = [...externalEmails.entries()].sort((a,b) => b[1]-a[1]).slice(0,5);
    for (const [email, cnt] of sorted)
      lines.push('   ' + email + ': ' + cnt + ' писем');
  }

  // Активность вне рабочего времени
  const offHours = vaultIndex.docs.filter(d => {
    if (d.type !== 'email' || !d.date) return false;
    try {
      const h = new Date(d.date).getHours();
      return h < 7 || h > 21;
    } catch (_) { return false; }
  });
  if (offHours.length > 0)
    lines.push('\n🌙 Активность вне рабочего времени: ' + offHours.length + ' писем');

  lines.push('\n📅 Сформировано: ' + new Date().toLocaleString('ru'));
  return lines.join('\n');
}

// Еженедельный ИБ отчёт
async function weeklySecurityReport(uid = 0) {
  const sections = [];

  // 1. Дашборд рисков
  sections.push(getRiskDashboard());

  // 2. ИБ письма за неделю
  const recentEmails = vaultIndex.getRecent('email', 7);
  const SEC_KW = ['инцидент','взлом','утечка','доступ','пароль','уязвимость',
                  'incident','breach','phishing','фишинг','атака','malware'];
  const secEmails = recentEmails.filter(d => {
    const text = ((d.subject||'') + ' ' + (d.body||'').slice(0,300)).toLowerCase();
    return SEC_KW.some(kw => text.includes(kw));
  });

  if (secEmails.length) {
    const secBlock = ['\n📧 Письма ИБ тематики за неделю (' + secEmails.length + '):'];
    for (const e of secEmails.slice(0,5))
      secBlock.push('   ' + (e.date||'') + '  ' + (e.subject||'').slice(0,60));
    sections.push(secBlock.join('\n'));
  }

  // 3. Аудит лог за неделю
  try {
    const fs2 = require('fs');
    if (fs2.existsSync(AUDIT_FILE)) {
      const raw  = fs2.readFileSync(AUDIT_FILE,'utf8').split('\n').filter(Boolean);
      const week = raw
        .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
        .filter(e => e && new Date(e.ts) > new Date(Date.now() - 7*86400000));
      const actions = {};
      for (const e of week) actions[e.action] = (actions[e.action]||0)+1;
      const topActions = Object.entries(actions).sort((a,b)=>b[1]-a[1]).slice(0,5);
      sections.push('\n📋 Активность за неделю (' + week.length + ' запросов):\n' +
        topActions.map(([a,n]) => '   '+a+': '+n).join('\n'));
    }
  } catch (_) {}

  // 4. AI анализ рисков
  try {
    const piiDocs = scanAllPII(50);
    if (piiDocs.length > 0) {
      const ctx = piiDocs.slice(0,5).map(({doc,pii}) =>
        doc.type+': '+doc.title+' | PII: '+pii.map(p=>p.type).join(', ')
      ).join('\n');
      const analysis = await callLLM(
        [{ role:'user', content:
          'Краткий ИБ анализ (3-5 рекомендаций) по найденным PII данным:\n'+ctx }],
        { maxTokens:400, uid }
      );
      sections.push('\n🤖 AI рекомендации:\n' + analysis);
    }
  } catch (_) {}

  const report = [
    '🔐 ЕЖЕНЕДЕЛЬНЫЙ ИБ ОТЧЁТ',
    'Период: ' + new Date(Date.now()-7*86400000).toLocaleDateString('ru') +
    ' — ' + new Date().toLocaleDateString('ru'),
    '',
    ...sections,
  ].join('\n');

  return report;
}

// Граф внешних получателей
function getExternalRecipientsGraph() {
  const graph  = new Map();
  const emails = vaultIndex.docs.filter(d => d.type === 'email');

  for (const doc of emails) {
    const from   = doc.from || '';
    const body   = doc.body || '';
    const toLine = body.match(/To:.*?([\w._%+\-]+@[\w.\-]+\.[a-zA-Z]{2,})/gi) || [];

    for (const t of toLine) {
      const toEmail = (t.match(/([\w._%+\-]+@[\w.\-]+\.[a-zA-Z]{2,})/)||[])[1]||'';
      if (!isExternalEmail(toEmail)) continue;

      const key = from.slice(0,30) + ' → ' + toEmail;
      graph.set(key, (graph.get(key)||0)+1);
    }
  }

  const sorted = [...graph.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15);
  if (!sorted.length) return '📤 Внешних получателей не обнаружено.';

  const lines = ['📤 Граф внешних коммуникаций:\n'];
  for (const [route, cnt] of sorted) {
    const bar = '▓'.repeat(Math.min(cnt, 10));
    lines.push(bar + ' (' + cnt + ')  ' + route);
  }
  return lines.join('\n');
}

// ──────────────────────────────────────────────
//  ФОНОВЫЕ ЗАДАЧИ (cron)
// ──────────────────────────────────────────────

// Ежемесячный ИБ отчёт (1-е число каждого месяца в 9:00)
cron.schedule('0 9 1 * *', async () => {
  if (!cfg.ALLOWED_USER_ID) return;
  log.info('📊 Формирую ежемесячный ИБ отчёт...');
  try {
    const report = [
      '📊 ЕЖЕМЕСЯЧНЫЙ ИБ ОТЧЁТ',
      new Date().toLocaleDateString('ru', {month:'long', year:'numeric'}),
      '',
      getRiskDashboard(),
      '',
      getSecurityTrend(),
      '',
      getDeptRiskDashboard(),
      '',
      getHeatmap(),
    ].join('\n');

    for (let i = 0; i < report.length; i += 4000)
      await send(cfg.ALLOWED_USER_ID, report.slice(i, i+4000));
    log.info('✅ Ежемесячный ИБ отчёт отправлен');
  } catch (e) { log.error('Monthly IB report: ' + e.message); }
});

// Детектор аномалий каждые 15 минут
cron.schedule('*/15 * * * *', async () => {
  await checkAnomalies();
});

// ══════════════════════════════════════════════
//  📋 ПОИСК ПО REQUEST FORM (РФ) ФАЙЛАМ
// ══════════════════════════════════════════════
//
// Команда /rf позволяет:
//  1. /rf list           — список всех РФ-файлов из TESTing.xlsx с оценкой токенов
//  2. /rf <IP>           — загрузить документ по IP, показать размер
//  3. /rf <IP> <вопрос>  — задать вопрос по документу (LLM по всему файлу)
//
// Большие документы автоматически режутся на части (мини-RAG внутри документа).

const RF_TESTING_PATH = process.env.RF_TESTING_PATH || '/00_Project_IS/TESTing.xlsx';

// Состояние: какой документ выбрал пользователь (uid -> {ip, docText, tokens})
const RF_STATE = new Map();

// Кэш загруженных документов (link -> docText)
const RF_DOC_CACHE = new Map();

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
    text += '## Лист: ' + name + '\n';
    text += rows.map(r => r.join(' | ')).join('\n') + '\n\n';
  }
  return text;
}

// Список РФ-файлов из TESTing.xlsx
async function rfGetFileList() {
  const buf = await rfDownload(RF_TESTING_PATH);
  const wb  = XLSX.read(buf, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  const COL = { ip: 1, is: 3, link: 7 };
  const files = [];
  const seen = new Set();
  for (let r = 1; r < rows.length; r++) {
    const ip   = String(rows[r][COL.ip]   || '').trim();
    const is   = String(rows[r][COL.is]   || '').trim();
    const link = String(rows[r][COL.link] || '').trim();
    if (!link || seen.has(link)) continue;
    seen.add(link);
    files.push({ ip, is, link });
  }
  return files;
}

// Чанкинг + scoring для больших документов
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

// Вопрос к документу через Auchan LLM (с обработкой больших файлов)
async function rfAskLLM(docText, question, uid) {
  const SAFE_CHARS = 40000;
  const system = 'Ты помощник для анализа Request Form на ИС. Отвечай ТОЛЬКО по документу, конкретно, на русском. Если данных нет — скажи об этом.';

  if (docText.length <= SAFE_CHARS) {
    return callLLM(
      [{ role: 'user', content: 'ДОКУМЕНТ:\n' + docText + '\n\nВОПРОС: ' + question }],
      { system, maxTokens: 800, uid }
    );
  }

  // Большой документ — берём релевантные части
  const chunks = rfChunkText(docText, SAFE_CHARS);
  const scored = chunks
    .map((c, i) => ({ chunk: c, score: rfScoreChunk(c, question), idx: i }))
    .sort((a, b) => b.score - a.score);
  const selected = scored.filter(s => s.score > 0).slice(0, 2);
  const use = selected.length ? selected : [scored[0]];

  const partial = [];
  for (const s of use) {
    try {
      const ans = await callLLM(
        [{ role: 'user', content: 'ДОКУМЕНТ (фрагмент):\n' + s.chunk + '\n\nВОПРОС: ' + question + '\nЕсли нет ответа — "нет данных".' }],
        { system, maxTokens: 400, uid }
      );
      if (ans && !/^нет данных/i.test(ans.trim())) partial.push(ans);
    } catch (_) {}
  }
  if (!partial.length) return 'В документе не найдено информации по этому вопросу.';
  if (partial.length === 1) return partial[0];
  return callLLM(
    [{ role: 'user', content: 'Объедини ответы из частей документа в один на вопрос "' + question + '":\n\n' + partial.join('\n\n---\n\n') }],
    { maxTokens: 600, uid }
  );
}

// ══════════════════════════════════════════════
//  🔄 REAL-TIME МОНИТОРИНГ ИСТОЧНИКОВ
// ══════════════════════════════════════════════

// Счётчики для статистики
const SYNC_STATS = {
  email:     { total: 0, lastSync: null, lastNew: 0 },
  disk:      { total: 0, lastSync: null, lastNew: 0 },
  messenger: { total: 0, lastSync: null, lastNew: 0 },
  plaud:     { total: 0, lastSync: null, lastNew: 0 },
};

// Умная переиндексация — только если что-то изменилось
async function reindexIfNeeded(source, newCount) {
  if (newCount > 0) {
    log.info(`🔄 Переиндексирую после ${source} (+${newCount})...`);
    vaultIndex = new VaultIndex(cfg.VAULT_PATH);
    // Авто-разметка новых заметок
    try {
      const { execFile } = require('child_process');
      execFile('node', ['mark_visibility.js'], { cwd: process.cwd() },
        (err) => { if (!err) log.info('🏷️  Разметка visibility обновлена'); }
      );
    } catch (_) {}
    log.info(`✅ Vault: ${vaultIndex.stats().total} заметок`);
    return true;
  }
  return false;
}

// Отправить алерт пользователю
async function notifyUser(message) {
  if (!cfg.ALLOWED_USER_ID) return;
  try { await send(cfg.ALLOWED_USER_ID, message); } catch (_) {}
}

// ── Почта: каждые 5 минут ──
cron.schedule('*/5 * * * *', async () => {
  try {
    const { syncEmail } = require('./syncer');
    const r = await syncEmail(cfg.VAULT_PATH, {});
    SYNC_STATS.email.lastSync = new Date().toISOString();
    SYNC_STATS.email.lastNew  = r.new;
    SYNC_STATS.email.total   += r.new;
    if (r.new > 0) {
      log.info(`📧 Почта: +${r.new} новых писем`);
      await reindexIfNeeded('email', r.new);
      // Алерт если много писем сразу
      if (r.new >= 10)
        await notifyUser(`📧 Получено ${r.new} новых писем\nНапишите /last чтобы увидеть`);
    }
  } catch (e) { log.error(`Синх почта: ${e.message}`); }
});

// ── Мессенджер: каждые 2 минуты ──
cron.schedule('*/2 * * * *', async () => {
  try {
    const { syncMessenger } = require('./syncer');
    const r = await syncMessenger(cfg.VAULT_PATH);
    SYNC_STATS.messenger.lastSync = new Date().toISOString();
    SYNC_STATS.messenger.lastNew  = r.new;
    SYNC_STATS.messenger.total   += r.new;
    if (r.new > 0) {
      log.info(`💬 Мессенджер: +${r.new} новых`);
      await reindexIfNeeded('messenger', r.new);
    }
  } catch (e) { log.error(`Синх мессенджер: ${e.message}`); }
});

// ── Plaud: каждые 10 минут ──
cron.schedule('*/10 * * * *', async () => {
  try {
    const { syncPlaud } = require('./syncer');
    const r = await syncPlaud(cfg.VAULT_PATH, cfg.ANTHROPIC_KEY);
    SYNC_STATS.plaud.lastSync = new Date().toISOString();
    SYNC_STATS.plaud.lastNew  = r.processed;
    SYNC_STATS.plaud.total   += r.processed;
    if (r.processed > 0) {
      log.info(`🎙️ Plaud: +${r.processed} записей`);
      await reindexIfNeeded('plaud', r.processed);
    }
  } catch (e) { log.error(`Синх Plaud: ${e.message}`); }
});

// ── Яндекс Диск: каждые 30 минут ──
cron.schedule('*/30 * * * *', async () => {
  try {
    const { syncDisk } = require('./syncer');
    const r = await syncDisk(cfg.VAULT_PATH, { force: false });
    SYNC_STATS.disk.lastSync = new Date().toISOString();
    SYNC_STATS.disk.lastNew  = r.new;
    SYNC_STATS.disk.total   += r.new + r.updated;
    if (r.new > 0 || r.updated > 0) {
      log.info(`💾 Диск: +${r.new} новых, ${r.updated} обновлено`);
      await reindexIfNeeded('disk', r.new + r.updated);
    }
  } catch (e) { log.error(`Синх диск: ${e.message}`); }
});

// ── Полная переиндексация каждые 3 часа ──
// ── Инкрементальная индексация через chokidar (вместо переиндексации каждые 3ч) ──
// Запускаем watcher с задержкой, чтобы не мешать первичной векторизации
let vaultWatcher = null;
function startVaultWatcher() {
  if (vaultWatcher) return;
  // Ждём пока завершится первичная векторизация
  if (embeddingSearch.indexing) {
    setTimeout(startVaultWatcher, 10000);
    return;
  }
  vaultWatcher = watchVault(
    cfg.VAULT_PATH,
    () => vaultIndex,
    (fresh) => {
      vaultIndex = fresh;
      if (typeof knowledgeGraph !== 'undefined' && knowledgeGraph) {
        try { knowledgeGraph = new KnowledgeGraph(vaultIndex.docs); } catch (_) {}
      }
    },
    (stats) => {
      log.info(`👁️  Vault обновлён инкрементально: +${stats.changed} → ${stats.total} заметок`);
      const { execFile } = require('child_process');
      execFile('node', ['mark_visibility.js'], { cwd: process.cwd() }, () => {});
    }
  );
}
// Стартуем слежение через 30 секунд после запуска (даём время на первичную векторизацию)
setTimeout(startVaultWatcher, 30000);

// Резервная полная переиндексация раз в сутки (на случай если watcher что-то пропустил)
cron.schedule('0 4 * * *', async () => {
  log.info('🔄 Суточная полная переиндексация (резерв)...');
  try {
    vaultIndex = new VaultIndex(cfg.VAULT_PATH);
    const { execFile } = require('child_process');
    execFile('node', ['mark_visibility.js'], { cwd: process.cwd() },
      (err) => { if (!err) log.info('🏷️  Разметка обновлена (суточная)'); }
    );
    const s = vaultIndex.stats();
    log.info(`✅ Индекс: ${s.total} заметок | ${JSON.stringify(s.by_visibility || {})}`);
  } catch (e) { log.error(`Переиндексация: ${e.message}`); }
});

// RF batch — еженедельное автозаполнение TESTing.xlsx (понедельник 6:00)
cron.schedule('0 6 * * 1', async () => {
  log.info('📋 Еженедельное заполнение TESTing.xlsx...');
  try {
    const { execFile } = require('child_process');
    execFile('node', ['fill_testing.js', '--no-llm'], { cwd: process.cwd(), timeout: 600000, maxBuffer: 10*1024*1024 },
      (err, stdout) => {
        if (err) { log.error('RF fill: ' + err.message); return; }
        const summary = (stdout||'').split('\n').filter(l => l.includes('Итог') || l.includes('заполнено')).join(' ');
        log.info('✅ RF fill: ' + summary);
        if (cfg.ALLOWED_USER_ID) {
          send(cfg.ALLOWED_USER_ID, '📋 Еженедельное заполнение TESTing.xlsx готово\n' + summary).catch(() => {});
        }
      }
    );
  } catch (e) { log.error('RF fill cron: ' + e.message); }
});

// ── Команда /syncstatus — статус всех источников ──
bot.onText(/\/syncstatus/, async (msg) => {
  if (!checkAccess(msg.from.id)) return;
  const lines = ['📡 Real-time статус синхронизации\n'];
  const icons = { email:'📧', disk:'💾', messenger:'💬', plaud:'🎙️' };
  const interval = { email:'5 мин', disk:'30 мин', messenger:'2 мин', plaud:'10 мин' };

  for (const [src, stat] of Object.entries(SYNC_STATS)) {
    const last = stat.lastSync ? new Date(stat.lastSync).toLocaleTimeString('ru') : 'ещё не было';
    lines.push(
      `${icons[src]} ${src}\n` +
      `   Последняя синх: ${last}\n` +
      `   Новых сегодня: ${stat.total}\n` +
      `   Интервал: ${interval[src]}`
    );
  }

  const s = vaultIndex.stats();
  lines.push(`\n📊 Vault: ${s.total} заметок`);
  if (s.by_visibility) {
    lines.push(
      `   🔴 private: ${s.by_visibility.private || 0}\n` +
      `   🟡 team: ${s.by_visibility.team || 0}\n` +
      `   🟢 public: ${s.by_visibility.public || 0}`
    );
  }

  await reply(msg, lines.join('\n'));
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

// Еженедельный ИБ отчёт по понедельникам в 8:00
cron.schedule('0 8 * * 1', async () => {
  if (!cfg.ALLOWED_USER_ID) return;
  log.info('🔐 Формирую еженедельный ИБ отчёт...');
  try {
    const report = await weeklySecurityReport();
    for (let i = 0; i < report.length; i += 4000)
      await send(cfg.ALLOWED_USER_ID, report.slice(i, i + 4000));
    log.info('✅ ИБ отчёт отправлен');
  } catch (e) { log.error('ИБ отчёт: ' + e.message); }
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
