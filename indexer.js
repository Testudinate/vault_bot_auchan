'use strict';
/**
 * indexer.js — индексация Obsidian vault
 *
 * Возможности:
 *  • Чтение всех .md файлов с frontmatter
 *  • BM25 поиск (через пакет natural + TF-IDF)
 *  • Инвертированный индекс с весами по типу документа
 *  • Временной поиск («за март», «прошлая неделя»)
 *  • Поиск по людям
 *  • Аналитика активности
 */

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const cfg     = require('./config');

// ──────────────────────────────────────────────
//  УТИЛИТЫ
// ──────────────────────────────────────────────

function tokenize(text) {
  if (!text) return [];
  return text.toLowerCase().match(/[а-яёa-z0-9]{2,}/g) || [];
}

function parseFrontmatter(text) {
  const meta = {};
  if (!text.startsWith('---')) return { meta, body: text };
  const end = text.indexOf('---', 3);
  if (end < 0) return { meta, body: text };
  const fm = text.slice(3, end);
  for (const line of fm.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const k = line.slice(0, colon).trim();
    const v = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
    if (k) meta[k] = v;
  }
  return { meta, body: text.slice(end + 3).trim() };
}

// ──────────────────────────────────────────────
//  ВРЕМЕННОЙ ПАРСЕР
// ──────────────────────────────────────────────

function parseTimeExpression(text) {
  const now   = new Date();
  const lower = text.toLowerCase();
  let dateFrom = null, dateTo = null, cleaned = text;

  const monthMap = {
    'январ': 0, 'феврал': 1, 'март': 2, 'апрел': 3,
    'ма':    4, 'июн':    5, 'июл':  6, 'август': 7,
    'сентябр': 8, 'октябр': 9, 'ноябр': 10, 'декабр': 11,
  };

  // Кириллица: \w не работает в JS, используем явный класс
  const CYR = '[а-яёa-z0-9_]*';
  const re_prev_week = new RegExp('(?:за\\s+)?прошл' + CYR + '\\s+недел' + CYR, 'i');
  const re_this_week = new RegExp('(?:за\\s+)?эт' + CYR + '\\s+недел' + CYR, 'i');
  const re_days      = new RegExp('(?:за\\s+)?последни' + CYR + '\\s+(\\d+)\\s+дн', 'i');
  const re_month     = new RegExp('(?:за\\s+)?последни' + CYR + '\\s+месяц', 'i');
  const re_yday      = new RegExp('вчера', 'i');
  const re_today     = new RegExp('сегодня', 'i');

  if (re_prev_week.test(lower)) {
    const day = now.getDay() || 7;
    dateFrom  = new Date(now); dateFrom.setDate(now.getDate() - day - 6);
    dateTo    = new Date(now); dateTo.setDate(now.getDate() - day);
    cleaned   = lower.replace(re_prev_week, '').trim();
  } else if (re_this_week.test(lower)) {
    const day = now.getDay() || 7;
    dateFrom  = new Date(now); dateFrom.setDate(now.getDate() - day + 1);
    dateTo    = new Date(now);
    cleaned   = lower.replace(re_this_week, '').trim();
  }

  const mDays = lower.match(re_days);
  if (mDays && !dateFrom) {
    dateFrom = new Date(now); dateFrom.setDate(now.getDate() - parseInt(mDays[1]));
    dateTo   = new Date(now);
    cleaned  = lower.replace(re_days, '').replace(/^\s*[а-яё]{1,3}\s+/,'').trim();
  }

  if (!dateFrom && re_month.test(lower)) {
    dateFrom = new Date(now); dateFrom.setDate(now.getDate() - 30);
    dateTo   = new Date(now);
    cleaned  = lower.replace(re_month, '').trim();
  }

  if (!dateFrom && re_yday.test(lower)) {
    dateFrom = new Date(now); dateFrom.setDate(now.getDate() - 1);
    dateTo   = new Date(dateFrom);
    cleaned  = lower.replace(re_yday, '').trim();
  }

  if (!dateFrom && re_today.test(lower)) {
    dateFrom = new Date(now);
    dateTo   = new Date(now);
    cleaned  = lower.replace(re_today, '').trim();
  }
  // «за вчера»
  if (/вчера/i.test(lower) && !dateFrom) {
    dateFrom = new Date(now); dateFrom.setDate(now.getDate() - 1);
    dateTo   = new Date(dateFrom);
    cleaned  = lower.replace(/вчера/i, '').trim();
  }
  // «за март», «в марте»
  if (!dateFrom) {
    for (const [prefix, monthIdx] of Object.entries(monthMap)) {
      const re = new RegExp('(?:за|в|во)\\s+' + prefix + '[а-яёa-z]*', 'i');
      if (re.test(lower)) {
        const year = monthIdx <= now.getMonth() ? now.getFullYear() : now.getFullYear() - 1;
        dateFrom   = new Date(year, monthIdx, 1);
        dateTo     = new Date(year, monthIdx + 1, 0);
        cleaned    = lower.replace(re, '').trim();
        break;
      }
    }
  }


  return { dateFrom, dateTo, cleaned: cleaned || text };
}

// ──────────────────────────────────────────────
//  EMBEDDINGS + CHROMA
// ──────────────────────────────────────────────

class EmbeddingSearch {
  constructor() {
    this.index    = null;
    this.embedder = null;
    this.reranker = null;       // локальный cross-encoder (bge-reranker)
    this.ready    = false;
    this.indexing = false;      // флаг: идёт векторизация (блокирует параллельный доступ)
    this.indexPath = './.vectra_index';
    this.idToDoc  = new Map();
    this.queryCache = new Map(); // кэш эмбеддингов запросов: текст -> вектор
    this.cacheMax   = 500;       // лимит записей в кэше
  }

  async init() {
    try {
      const { LocalIndex } = require('vectra');
      const { pipeline }   = require('@xenova/transformers');

      console.log('   🔄 Загружаю модель эмбеддингов...');
      this.embedder = await pipeline(
        'feature-extraction',
        'Xenova/multilingual-e5-small',
        { progress_callback: null }
      );
      console.log('   ✅ Модель загружена');

      this.index = new LocalIndex(this.indexPath);
      if (!await this.index.isIndexCreated()) {
        await this.index.createIndex();
      }
      const items = await this.index.listItems();
      console.log(`   ✅ Vectra: ${items.length} векторов (без сервера)`);
      this.ready = true;
    } catch (e) {
      console.warn(`   ⚠️  Векторный поиск недоступен: ${e.message}`);
      console.warn('   Запустите: npm install @xenova/transformers vectra');
      this.ready = false;
    }
  }

  async embed(text) {
    // Кэш эмбеддингов запросов — повторные запросы не пересчитываются
    if (this.queryCache.has(text)) {
      return this.queryCache.get(text);
    }

    let vector = null;

    // Вариант 1: Ашан Qwen embedding endpoint (если задан в .env)
    const cfg = require('./config');
    if (cfg.AUCHAN_EMBEDDING_URL && cfg.AUCHAN_API_KEY) {
      try {
        const axios = require('axios');
        const agent = new (require('https').Agent)({ rejectUnauthorized: false });
        const { data } = await axios.post(cfg.AUCHAN_EMBEDDING_URL,
          { input: text, model: cfg.AUCHAN_EMBEDDING_MODEL || 'qwen3-embedding' },
          {
            headers: {
              'X-Gravitee-Api-Key': cfg.AUCHAN_API_KEY,
              'Authorization':      'Bearer ' + (cfg.AUCHAN_BEARER || ''),
              'Content-Type':       'application/json',
            },
            httpsAgent: agent,
            timeout: 30000,
          }
        );
        // OpenAI-совместимый формат ответа
        const vec = data.data && data.data[0] && data.data[0].embedding;
        if (vec) vector = vec;
      } catch (e) {
        // Фолбэк на локальную модель при ошибке
        if (!this._qwenWarned) {
          console.warn('   ⚠️  Qwen embedding недоступен, использую локальную модель: ' + e.message.slice(0,60));
          this._qwenWarned = true;
        }
      }
    }

    // Вариант 2: локальная модель multilingual-e5-small
    if (!vector) {
      if (!this.embedder) return null;
      const out = await this.embedder(text, { pooling: 'mean', normalize: true });
      vector = Array.from(out.data);
    }

    // Сохраняем в кэш (с ограничением размера — FIFO)
    if (vector) {
      if (this.queryCache.size >= this.cacheMax) {
        const firstKey = this.queryCache.keys().next().value;
        this.queryCache.delete(firstKey);
      }
      this.queryCache.set(text, vector);
    }
    return vector;
  }

  async addDocs(docs) {
    if (!this.ready || !this.index) return;
    const existing = new Set(
      (await this.index.listItems()).map(i => i.metadata && i.metadata.id)
    );
    // id вектора = docId или docId#chunkN — проверяем по docId
    const existingDocs = new Set(
      [...existing].map(id => String(id).split('#')[0])
    );
    const toAdd = docs.filter(d => !existingDocs.has(d.id));
    if (!toAdd.length) return;
    this.indexing = true;   // блокируем параллельную переиндексацию
    console.log(`   🔄 Векторизую ${toAdd.length} новых документов (по чанкам)...`);

    let vecCount = 0;
    try {
    for (let i = 0; i < toAdd.length; i++) {
      const doc = toAdd[i];
      try {
        // Заголовок + метаданные как первый "чанк" (для поиска по названию)
        const headText = `${doc.title} ${doc.from || ''} ${doc.chatName || ''}`;
        const chunks   = (doc.chunks && doc.chunks.length) ? doc.chunks : [(doc.body || '').slice(0, 800)];

        // Вектор заголовка (chunkIdx = -1 означает заголовок/метаданные)
        const headVec = await this.embed('passage: ' + headText + ' ' + chunks[0].slice(0, 200));
        if (headVec) {
          await this.index.insertItem({
            vector: headVec,
            metadata: { id: doc.id + '#head', docId: doc.id, chunkIdx: -1,
                        type: doc.type || '', date: doc.date || '', title: doc.title || '' },
          });
          vecCount++;
        }

        // Вектор каждого чанка (до 10 чанков на документ, чтобы не раздувать индекс)
        const maxChunks = Math.min(chunks.length, 10);
        for (let c = 0; c < maxChunks; c++) {
          const chunkVec = await this.embed('passage: ' + chunks[c].slice(0, 512));
          if (!chunkVec) continue;
          await this.index.insertItem({
            vector: chunkVec,
            metadata: { id: doc.id + '#' + c, docId: doc.id, chunkIdx: c,
                        type: doc.type || '', date: doc.date || '', title: doc.title || '' },
          });
          vecCount++;
        }
      } catch (_) {}
      if ((i+1) % 100 === 0) console.log(`   ... ${i+1}/${toAdd.length} док (${vecCount} векторов)`);
    }
    } finally {
      this.indexing = false;
    }
    console.log(`   ✅ Векторизация завершена: ${vecCount} векторов из ${toAdd.length} документов`);
  }

  async search(query, { topK = 10, docType = null } = {}) {
    if (!this.ready || !this.index) return [];
    try {
      const vector  = await this.embed('query: ' + query);
      if (!vector) return [];
      // Берём больше кандидатов т.к. на документ несколько чанков
      const results = await this.index.queryItems(vector, topK * 4);

      // Группируем по docId, берём лучший чанк каждого документа
      const byDoc = new Map();
      for (const r of results) {
        const m = r.item.metadata;
        if (docType && m.type !== docType) continue;
        const docId = m.docId || m.id;
        if (!byDoc.has(docId) || byDoc.get(docId).score < r.score) {
          byDoc.set(docId, { id: docId, score: r.score, chunkIdx: m.chunkIdx });
        }
      }
      return [...byDoc.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    } catch (_) { return []; }
  }

  // ── Локальный cross-encoder reranker (bge-reranker-v2-m3) ──
  async initReranker() {
    if (this.reranker) return true;
    try {
      const { pipeline } = require('@xenova/transformers');
      console.log('   🔄 Загружаю локальный reranker (bge-reranker)...');
      // Xenova предоставляет bge-reranker-base; v2-m3 тяжелее, base достаточно
      this.reranker = await pipeline(
        'text-classification',
        'Xenova/bge-reranker-base',
        { progress_callback: null }
      );
      console.log('   ✅ Reranker загружен');
      return true;
    } catch (e) {
      console.warn('   ⚠️  Локальный reranker недоступен: ' + e.message.slice(0, 60));
      console.warn('   Реранк останется через LLM. Для локального: модель скачается при первом запуске');
      this.reranker = null;
      return false;
    }
  }

  // Реранк пар (запрос, документ) локальной моделью. Возвращает массив score
  async rerank(query, docs) {
    if (!this.reranker) {
      const ok = await this.initReranker();
      if (!ok) return null;
    }
    try {
      const scores = [];
      for (const doc of docs) {
        const text = (doc.title || '') + ' ' + (doc.relevantChunk || (doc.body || '').slice(0, 400));
        // cross-encoder принимает пару через разделитель
        const out = await this.reranker({ text: query, text_pair: text });
        // Результат: [{label, score}] — берём score релевантности
        const score = Array.isArray(out) ? (out[0] && out[0].score) : (out && out.score);
        scores.push(typeof score === 'number' ? score : 0);
      }
      return scores;
    } catch (e) {
      console.warn('   ⚠️  Ошибка реранка: ' + e.message.slice(0, 50));
      return null;
    }
  }
}
// Singleton
const embeddingSearch = new EmbeddingSearch();

// ──────────────────────────────────────────────
//  FUZZY TITLE SEARCH (триграммы)
// ──────────────────────────────────────────────

// Разбивает строку на триграммы для fuzzy-поиска
function trigrams(str) {
  const s = ' ' + (str || '').toLowerCase().replace(/[^а-яёa-z0-9 ]/g, '') + ' ';
  const grams = new Set();
  for (let i = 0; i < s.length - 2; i++) {
    grams.add(s.slice(i, i + 3));
  }
  return grams;
}

// Коэффициент схожести по триграммам (Jaccard / Dice)
function trigramSimilarity(a, b) {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const g of ta) if (tb.has(g)) intersection++;
  // Dice coefficient
  return (2 * intersection) / (ta.size + tb.size);
}

// ──────────────────────────────────────────────
//  VAULT INDEX
// ──────────────────────────────────────────────

class VaultIndex {
  constructor(vaultPath, opts = {}) {
    this.vaultPath  = vaultPath;
    this.docs       = [];
    this.invIndex   = new Map();   // token → [{idx, weight}]
    this.tfidf      = null;        // TF-IDF scores per doc
    this.skipEmbeddings = opts.skipEmbeddings || false;
    this._build();
  }

  _typeFromPath(relPath) {
    if (relPath.startsWith('01_Email'))       return 'email';
    if (relPath.startsWith('02_Messenger'))   return 'messenger_chat';
    if (relPath.startsWith('03_YandexDisk'))  return 'disk_file';
    if (relPath.startsWith('04_Plaud'))       return 'voice_transcript';
    if (relPath.startsWith('Contacts'))       return 'contact';
    return 'unknown';
  }

  _build() {
    const vault = this.vaultPath;
    if (!fs.existsSync(vault)) {
      console.warn(`⚠️  Vault не найден: ${vault}`);
      return;
    }

    console.log('📚 Индексирую vault...');
    const mdFiles   = this._findMd(vault);
    const typeCounts = {};

    // TF-IDF данные
    const corpus = [];

    for (const fpath of mdFiles) {
      try {
        const raw       = fs.readFileSync(fpath, 'utf8');
        const { meta, body } = parseFrontmatter(raw);
        const rel       = path.relative(vault, fpath);
        const dtype     = meta.type || this._typeFromPath(rel);
        const subject   = meta.subject || path.basename(fpath, '.md');
        const from      = meta.from || '';
        const folder    = meta.folder || meta.mailbox || path.dirname(rel);
        const chatName  = meta.chat_name || meta.chat || path.basename(fpath, '.md');
        const docDate   = meta.date || '';
        let   dateObj   = null;
        try { if (docDate && docDate !== 'unknown') dateObj = new Date(docDate.slice(0, 10)); }
        catch (_) {}

        // Взвешенный текст
        let weighted = '';
        if (dtype === 'messenger_chat') {
          weighted = `${chatName} `.repeat(5) + `${path.basename(fpath, '.md')} `.repeat(3) + body.slice(0, 5000);
        } else {
          weighted = `${subject} `.repeat(3) + `${from} `.repeat(2) + `${folder} ` + body.slice(0, 3000);
        }

        const tokens = tokenize(weighted);
        corpus.push(tokens);

        const idx = this.docs.length;

        // Chunking — разбиваем длинные документы на чанки
        const CHUNK_SIZE    = 800;
        const CHUNK_OVERLAP = 150;
        const bodyText      = body || '';
        const chunks        = [];
        if (bodyText.length > CHUNK_SIZE) {
          for (let ci = 0; ci < bodyText.length; ci += CHUNK_SIZE - CHUNK_OVERLAP) {
            chunks.push(bodyText.slice(ci, ci + CHUNK_SIZE));
            if (ci + CHUNK_SIZE >= bodyText.length) break;
          }
        }

        this.docs.push({
          id:       crypto.createHash('md5').update(fpath).digest('hex'),
          path:     rel,
          title:    dtype === 'messenger_chat' ? chatName : subject,
          body,
          chunks:   chunks.length > 0 ? chunks : [bodyText.slice(0, CHUNK_SIZE)],
          type:     dtype,
          date:     docDate,
          dateObj,
          folder,
          from,
          subject,
          chatName,
          // Автотеги из frontmatter
          tags:       (meta.tags || meta.topic || '').split(',').map(t => t.trim()).filter(Boolean),
          people:     (meta.people || meta.from || '').split(',').map(t => t.trim()).filter(Boolean),
          priority:   meta.priority || meta.importance || 'normal',
          aliases:    (meta.aliases || meta.alias || '').split(',').map(t => t.trim()).filter(Boolean),
          // Visibility — читаем из frontmatter напрямую
          visibility: meta.visibility || null,
        });

        // Инвертированный индекс
        const seen = new Map();
        const fields = dtype === 'messenger_chat'
          ? [[chatName, 5], [path.basename(fpath, '.md'), 3], [body.slice(0, 3000), 1]]
          : [[subject, 5], [from, 3], [folder, 2], [body.slice(0, 2000), 1]];

        for (const [field, w] of fields) {
          for (const tok of tokenize(field)) {
            if (!seen.has(tok) || seen.get(tok) < w) seen.set(tok, w);
          }
        }
        for (const [tok, w] of seen) {
          if (!this.invIndex.has(tok)) this.invIndex.set(tok, []);
          this.invIndex.get(tok).push({ idx, weight: w });
        }

        typeCounts[dtype] = (typeCounts[dtype] || 0) + 1;
      } catch (_) {}
    }

    // Строим TF-IDF
    this.tfidf = this._buildTfIdf(corpus);

    const summary = Object.entries(typeCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`).join(', ');
    console.log(`   ✅ ${this.docs.length} заметок | ${summary}`);

    // Инициализируем векторный поиск асинхронно (не блокируем запуск)
    if (this.skipEmbeddings) {
      // Инкрементальный режим: только обновляем маппинг id→doc, не трогаем векторизацию
      if (embeddingSearch.ready) {
        embeddingSearch.idToDoc.clear();
        for (const doc of this.docs) embeddingSearch.idToDoc.set(doc.id, doc);
      }
    } else {
      this._initEmbeddings();
    }
  }

  async _initEmbeddings() {
    // Защита от параллельного запуска (watcher + первичная индексация)
    if (embeddingSearch.indexing) {
      console.log('   ⏳ Векторизация уже идёт, пропускаю повторную инициализацию');
      for (const doc of this.docs) embeddingSearch.idToDoc.set(doc.id, doc);
      return;
    }
    await embeddingSearch.init();
    if (embeddingSearch.ready) {
      try {
        const stats = await embeddingSearch.index.listItems();
        const count = stats.length;
        // Считаем уникальные документы в индексе (на документ много чанков)
        const uniqueDocs = new Set(stats.map(s => (s.metadata && s.metadata.docId) || (s.metadata && s.metadata.id))).size;
        if (uniqueDocs < this.docs.length * 0.9) {
          console.log(`   🔄 Векторный индекс устарел (${uniqueDocs} док < ${this.docs.length}), перестраиваю...`);
          const { LocalIndex } = require('vectra');
          embeddingSearch.index = new LocalIndex(embeddingSearch.indexPath);
          if (await embeddingSearch.index.isIndexCreated()) {
            await embeddingSearch.index.deleteIndex();
          }
          await embeddingSearch.index.createIndex();
          await embeddingSearch.addDocs(this.docs);
        } else {
          for (const doc of this.docs) embeddingSearch.idToDoc.set(doc.id, doc);
          console.log(`   ✅ Vectra: ${count} векторов / ${uniqueDocs} документов`);
        }
      } catch (e) {
        await embeddingSearch.addDocs(this.docs);
      }
    }
  }

  _buildTfIdf(corpus) {
    // Упрощённый TF-IDF
    const N = corpus.length;
    const df = new Map();
    for (const tokens of corpus) {
      for (const tok of new Set(tokens)) {
        df.set(tok, (df.get(tok) || 0) + 1);
      }
    }
    return { corpus, df, N };
  }

  _tfidfScore(tokens, idx) {
    if (!this.tfidf) return 0;
    const { corpus, df, N } = this.tfidf;
    const docTokens = corpus[idx];
    if (!docTokens || docTokens.length === 0) return 0;
    const tf = new Map();
    for (const t of docTokens) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const tok of tokens) {
      const tfVal  = (tf.get(tok) || 0) / docTokens.length;
      const idf    = Math.log((N + 1) / ((df.get(tok) || 0) + 1));
      score += tfVal * idf;
    }
    return score;
  }

  _findMd(dir, results = []) {
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.'))
        this._findMd(full, results);
      else if (entry.isFile() && entry.name.endsWith('.md'))
        results.push(full);
    }
    return results;
  }

  // BM25 + TF-IDF поиск (синхронный)
  _lexicalSearch(tokens, { docType, folders, dateFrom, dateTo }) {
    const scores = new Map();

    for (let i = 0; i < this.docs.length; i++) {
      const sc = this._tfidfScore(tokens, i);
      if (sc > 0) scores.set(i, (scores.get(i) || 0) + sc * 2);
    }

    for (const tok of tokens) {
      for (const { idx, weight } of (this.invIndex.get(tok) || [])) {
        scores.set(idx, (scores.get(idx) || 0) + weight);
      }
      if (tok.length >= 4) {
        for (const [token, postings] of this.invIndex) {
          if (token !== tok && token.startsWith(tok)) {
            for (const { idx, weight } of postings) {
              scores.set(idx, (scores.get(idx) || 0) + weight * 0.5);
            }
          }
        }
      }
    }

    const filtered = new Map();
    for (const [idx, sc] of scores) {
      const doc = this.docs[idx];
      if (docType && doc.type !== docType) continue;
      if (folders && folders.length > 0) {
        const fl = folders.map(f => f.toLowerCase());
        if (!fl.some(f => doc.folder.toLowerCase().includes(f) || doc.path.toLowerCase().includes(f))) continue;
      }
      if (dateFrom && doc.dateObj && doc.dateObj < dateFrom) continue;
      if (dateTo   && doc.dateObj && doc.dateObj > dateTo)   continue;
      filtered.set(idx, sc);
    }

    return [...filtered.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([idx, score]) => ({ ...this.docs[idx], score }));
  }

  // Reciprocal Rank Fusion — объединяет результаты BM25 и векторного поиска
  // Fuzzy поиск по заголовкам/aliases через триграммы
  _fuzzyTitleSearch(query, { topK = 20 } = {}) {
    const results = [];
    for (const doc of this.docs) {
      const title = doc.title || doc.subject || '';
      if (!title) continue;
      const sim = trigramSimilarity(query, title);
      // Также проверяем aliases если есть
      let bestSim = sim;
      if (doc.aliases && Array.isArray(doc.aliases)) {
        for (const alias of doc.aliases) {
          const aSim = trigramSimilarity(query, alias);
          if (aSim > bestSim) bestSim = aSim;
        }
      }
      if (bestSim > 0.2) {
        results.push({ ...doc, fuzzyScore: bestSim });
      }
    }
    return results
      .sort((a, b) => b.fuzzyScore - a.fuzzyScore)
      .slice(0, topK);
  }

  _rrfFuse(bm25Results, vectorResults, fuzzyResults = [], k = 60) {
    const scores   = new Map();
    const matchedBy = new Map();

    const addList = (list, label) => {
      for (let i = 0; i < list.length; i++) {
        const id = list[i].id;
        scores.set(id, (scores.get(id) || 0) + 1 / (k + i + 1));
        if (!matchedBy.has(id)) matchedBy.set(id, []);
        matchedBy.get(id).push(label);
      }
    };

    addList(bm25Results, 'bm25');
    addList(vectorResults, 'semantic');
    addList(fuzzyResults, 'fuzzy_title');

    const idToDoc = new Map(this.docs.map(d => [d.id, d]));
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, score]) => ({ ...idToDoc.get(id), score, matchedBy: matchedBy.get(id) || [] }))
      .filter(d => d.id);
  }

  // Главный метод поиска — Hybrid (BM25 + Embeddings + RRF)
  search(query, { topK = 7, docType = null, folders = null, dateFrom = null, dateTo = null, visibility = null } = {}) {
    const tokens = tokenize(query);
    if (!tokens.length) return [];
    const bm25 = this._lexicalSearch(tokens, { docType, folders, dateFrom, dateTo });
    // Фильтр по visibility если указан
    const filtered = visibility
      ? bm25.filter(d => {
          const v = d.visibility || 'private';
          if (visibility === 'public') return v === 'public';
          if (visibility === 'team')   return v === 'public' || v === 'team';
          return true; // private видит всё
        })
      : bm25;
    return filtered.slice(0, topK);
  }

  // Найти лучший чанк документа для запроса
  _getBestChunk(doc, queryTokens) {
    if (!doc.chunks || doc.chunks.length <= 1) return null;
    let bestChunk = doc.chunks[0];
    let bestScore = 0;
    for (const chunk of doc.chunks) {
      const chunkTokens = tokenize(chunk);
      const score = queryTokens.filter(t => chunkTokens.includes(t)).length;
      if (score > bestScore) { bestScore = score; bestChunk = chunk; }
    }
    return bestScore > 0 ? bestChunk : doc.chunks[0];
  }

  // Temporal scoring — свежие документы получают бонус
  _temporalScore(doc) {
    if (!doc.dateObj) return 0;
    const daysAgo = (Date.now() - doc.dateObj.getTime()) / 86400000;
    if (daysAgo < 7)   return 0.3;
    if (daysAgo < 30)  return 0.15;
    if (daysAgo < 90)  return 0.05;
    return 0;
  }

  // Асинхронный гибридный поиск (BM25 + Vectra + Fuzzy + RRF + temporal + опц. локальный реранк)
  async searchHybrid(query, { topK = 7, docType = null, folders = null, dateFrom = null, dateTo = null, visibility = null, useReranker = false } = {}) {
    const tokens  = tokenize(query);
    const bm25    = this._lexicalSearch(tokens, { docType, folders, dateFrom, dateTo });

    let fused = bm25;

    // Fuzzy поиск по заголовкам (триграммы) — всегда
    const fuzzyResults = this._fuzzyTitleSearch(query, { topK: 20 });

    if (embeddingSearch.ready) {
      const vectorHits = await embeddingSearch.search(query, { topK: 20, docType, dateFrom, dateTo });
      const idToIdx    = new Map(this.docs.map((d, i) => [d.id, i]));
      const vectorDocs = vectorHits.map(({ id, score }) => {
        const idx = idToIdx.get(id);
        if (idx === undefined) return null;
        const doc = this.docs[idx];
        if (folders && folders.length > 0) {
          const fl = folders.map(f => f.toLowerCase());
          if (!fl.some(f => doc.folder.toLowerCase().includes(f) || doc.path.toLowerCase().includes(f))) return null;
        }
        return { ...doc, score };
      }).filter(Boolean);
      // RRF слияние трёх списков: BM25 + Semantic + Fuzzy
      fused = this._rrfFuse(bm25, vectorDocs, fuzzyResults);
    } else {
      // Без эмбеддингов — BM25 + Fuzzy
      fused = this._rrfFuse(bm25, [], fuzzyResults);
    }

    // Temporal boost — поднимаем свежие документы
    fused = fused.map(doc => ({
      ...doc,
      score: (doc.score || 0) + this._temporalScore(doc),
    })).sort((a, b) => b.score - a.score);

    // Фильтр по visibility
    const visFiltered = visibility
      ? fused.filter(d => {
          const v = d.visibility || 'private';
          if (visibility === 'public') return v === 'public';
          if (visibility === 'team')   return v === 'public' || v === 'team';
          return true;
        })
      : fused;

    // Находим лучший чанк для каждого документа
    let results = visFiltered.slice(0, Math.max(topK, useReranker ? 15 : topK)).map(doc => ({
      ...doc,
      relevantChunk: this._getBestChunk(doc, tokens),
    }));

    // Опциональный локальный реранк (cross-encoder bge-reranker)
    if (useReranker && results.length > 1) {
      const scores = await embeddingSearch.rerank(query, results);
      if (scores) {
        results = results
          .map((doc, i) => ({ ...doc, rerankScore: scores[i] }))
          .sort((a, b) => b.rerankScore - a.rerankScore);
      }
    }

    return results.slice(0, topK);
  }

  searchByPerson(name) {
    const nl = name.toLowerCase();
    const matches = new Set();
    for (let i = 0; i < this.docs.length; i++) {
      const doc = this.docs[i];
      if (doc.from?.toLowerCase().includes(nl))      matches.add(i);
      if (doc.subject?.toLowerCase().includes(nl))   matches.add(i);
      if (doc.chatName?.toLowerCase().includes(nl))  matches.add(i);
      if (doc.title?.toLowerCase().includes(nl))     matches.add(i);
      if (doc.path?.toLowerCase().includes(nl))      matches.add(i);
    }
    return [...matches]
      .map(i => this.docs[i])
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, 15);
  }

  getRecent(docType = null, days = 7) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    return this.docs
      .filter(d => (!docType || d.type === docType) && d.dateObj && d.dateObj >= cutoff)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, 20);
  }

  getTopContacts(n = 20) {
    const counter = new Map();
    for (const doc of this.docs) {
      if (doc.type !== 'email' || !doc.from) continue;
      const m     = doc.from.match(/<(.+?)>/);
      const email = m ? m[1] : doc.from;
      const name  = doc.from.replace(/<.+?>/, '').trim().replace(/"/g, '') || email;
      const key   = `${name}|||${email}`;
      counter.set(key, (counter.get(key) || 0) + 1);
    }
    return [...counter.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([key, cnt]) => {
        const [name, email] = key.split('|||');
        return { name, email, count: cnt };
      });
  }

  getFolders() {
    const result = { email: new Set(), messenger: new Set(), plaud: new Set(), disk: new Set() };
    for (const doc of this.docs) {
      const parts = doc.path.split(path.sep);
      if (doc.path.startsWith('01_Email') && parts.length > 2)     result.email.add(parts[1]);
      if (doc.path.startsWith('02_Messenger') && parts.length > 2) result.messenger.add(parts[1]);
      if (doc.path.startsWith('04_Plaud'))                         result.plaud.add('Все записи');
      if (doc.path.startsWith('03_YandexDisk'))                    result.disk.add('Все файлы');
    }
    return {
      '📧 Почта':      [...result.email].sort(),
      '💬 Мессенджер': [...result.messenger].sort(),
      '🎙️ Plaud':      [...result.plaud].sort(),
      '💾 Диск':       [...result.disk].sort(),
    };
  }

  stats() {
    const by_type = {}, by_visibility = {};
    for (const doc of this.docs) {
      by_type[doc.type] = (by_type[doc.type] || 0) + 1;
      const v = doc.visibility || 'private';
      by_visibility[v] = (by_visibility[v] || 0) + 1;
    }
    return { total: this.docs.length, by_type, by_visibility };
  }

  getActivityStats() {
    const byMonth = {}, byFolder = {}, topics = {};
    for (const doc of this.docs) {
      if (doc.date && doc.date.length >= 7) {
        const m = doc.date.slice(0, 7);
        byMonth[m] = (byMonth[m] || 0) + 1;
      }
      if (doc.folder) byFolder[doc.folder] = (byFolder[doc.folder] || 0) + 1;
      for (const w of tokenize(doc.subject || '')) {
        if (w.length > 4) topics[w] = (topics[w] || 0) + 1;
      }
    }
    const sortedMonths  = Object.entries(byMonth).sort().slice(-12);
    const sortedFolders = Object.entries(byFolder).sort((a,b) => b[1]-a[1]).slice(0, 10);
    const sortedTopics  = Object.entries(topics).sort((a,b) => b[1]-a[1]).slice(0, 15);
    return {
      byMonth:  Object.fromEntries(sortedMonths),
      byFolder: Object.fromEntries(sortedFolders),
      topTopics: Object.fromEntries(sortedTopics),
    };
  }
}

// ──────────────────────────────────────────────
//  ИНКРЕМЕНТАЛЬНАЯ ИНДЕКСАЦИЯ (chokidar)
// ──────────────────────────────────────────────

// Следит за изменениями .md в vault и обновляет только их.
// onUpdate(stats) вызывается после каждого изменения с {action, file}.
function watchVault(vaultPath, getIndex, setIndex, onUpdate) {
  let chokidar;
  try {
    chokidar = require('chokidar');
  } catch (e) {
    console.warn('   ⚠️  chokidar не установлен — инкрементальная индексация выключена');
    console.warn('   Установите: npm install chokidar');
    return null;
  }

  let debounceTimer = null;
  let reindexing    = false;   // блокировка от параллельной переиндексации
  const pending = new Set();

  const flush = async () => {
    if (!pending.size) return;
    // Не запускаем переиндексацию пока идёт векторизация или предыдущая ещё не завершилась
    if (reindexing || embeddingSearch.indexing) {
      // Откладываем ещё на 10 секунд
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flush, 10000);
      return;
    }
    reindexing = true;
    const changed = [...pending];
    pending.clear();
    console.log(`   🔄 Инкрементальная переиндексация (${changed.length} изменений)...`);
    try {
      // Текстовый индекс (BM25/fuzzy) пересобираем сразу, векторы — отдельно
      const fresh = new VaultIndex(vaultPath, { skipEmbeddings: true });
      setIndex(fresh);
      if (onUpdate) onUpdate({ changed: changed.length, total: fresh.stats().total });
      console.log(`   ✅ Текстовый индекс обновлён: ${fresh.stats().total} заметок`);

      // Добавляем только новые документы в векторный индекс (не перестраивая весь)
      if (embeddingSearch.ready && !embeddingSearch.indexing) {
        embeddingSearch.addDocs(fresh.docs).catch(() => {});
      }
    } catch (e) {
      console.warn('   ⚠️  Ошибка инкрементальной индексации: ' + e.message);
    } finally {
      reindexing = false;
    }
  };

  const schedule = (file, action) => {
    pending.add(action + ':' + file);
    if (debounceTimer) clearTimeout(debounceTimer);
    // Ждём 15 секунд тишины — пакетная синхронизация добавляет много файлов сразу
    debounceTimer = setTimeout(flush, 15000);
  };

  const watcher = chokidar.watch(vaultPath, {
    ignored: [
      /(^|[\/\\])\../,           // скрытые файлы
      /\.vectra_index/,          // не реагируем на файлы векторного индекса
      /node_modules/,
    ],
    persistent: true,
    ignoreInitial: true,         // не реагируем на существующие при старте
    awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 300 },
  });

  watcher
    .on('add',    f => f.endsWith('.md') && schedule(f, 'add'))
    .on('change', f => f.endsWith('.md') && schedule(f, 'change'))
    .on('unlink', f => f.endsWith('.md') && schedule(f, 'unlink'));

  console.log('   👁️  Слежу за изменениями vault (chokidar)');
  return watcher;
}

// ──────────────────────────────────────────────
//  ЭКСПОРТ
// ──────────────────────────────────────────────

module.exports = { VaultIndex, parseTimeExpression, tokenize, embeddingSearch, watchVault };

// CLI: node indexer.js --rebuild
if (require.main === module) {
  const idx = new VaultIndex(cfg.VAULT_PATH);
  console.log('\n📊 Статистика:');
  const s = idx.stats();
  console.log(`   Всего: ${s.total}`);
  for (const [t, n] of Object.entries(s.by_type).sort((a,b) => b[1]-a[1]))
    console.log(`   ${t}: ${n}`);
}
