'use strict';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
/**
 * query_rf.js — интерактивный анализ РФ-файла через LLM
 *
 * Логика:
 *  1. Читает TESTing.xlsx, показывает список РФ-файлов с оценкой токенов
 *  2. Пользователь выбирает файл (по номеру строки или IP)
 *  3. Скрипт загружает весь документ
 *  4. Пользователь задаёт любые вопросы — отвечает LLM по всему документу
 *
 * Запуск:
 *   node query_rf.js                      # список файлов + выбор
 *   node query_rf.js --ip 10.156.1.40     # сразу выбрать по IP
 *   node query_rf.js --list               # только показать список
 */

const fs       = require('fs');
const readline = require('readline');
const axios    = require('axios');
const XLSX     = require('xlsx');
const cfg      = require('./config');

const TESTING_PATH = (process.argv.find(a => a.startsWith('--path=')) || '').split('=')[1]
  || '/00_Project_IS/TESTing.xlsx';
const PRESET_IP = (process.argv.find(a => a.startsWith('--ip=')) || '').split('=')[1]
  || (process.argv.includes('--ip') ? process.argv[process.argv.indexOf('--ip')+1] : '');
const LIST_ONLY = process.argv.includes('--list');
// --ask "вопрос" — задать один вопрос без интерактива (надёжнее в некоторых терминалах)
const ASK_IDX = process.argv.indexOf('--ask');
const SINGLE_QUESTION = ASK_IDX >= 0 ? process.argv[ASK_IDX + 1] : null;

const agent = new (require('https').Agent)({ rejectUnauthorized: false, keepAlive: false });
const diskAx = axios.create({
  baseURL: 'https://cloud-api.yandex.net/v1/disk',
  headers: { Authorization: 'OAuth ' + cfg.YANDEX_DISK_TOKEN },
  httpsAgent: agent,
  timeout: 30000,
});

async function downloadFromDisk(p) {
  const { data: dl } = await diskAx.get('/resources/download', { params: { path: p } });
  const { data: buf } = await axios.get(dl.href, { responseType: 'arraybuffer', httpsAgent: agent, timeout: 60000, maxRedirects: 5 });
  return Buffer.from(buf);
}
async function downloadFromPublicLink(url) {
  const { data: dl } = await diskAx.get('/public/resources/download', { params: { public_key: url } });
  const { data: buf } = await axios.get(dl.href, { responseType: 'arraybuffer', httpsAgent: agent, timeout: 60000, maxRedirects: 5 });
  return Buffer.from(buf);
}
async function downloadFile(s) {
  s = (s || '').trim();
  if (!s) throw new Error('пустая ссылка');
  if (s.includes('disk.yandex.ru') || s.includes('yadi.sk')) {
    const m = s.match(/\/client\/disk(\/.+?)(?:\?|$)/);
    if (m) return downloadFromDisk(decodeURIComponent(m[1]));
    return downloadFromPublicLink(s);
  }
  return downloadFromDisk(s.startsWith('/') ? s : '/' + s);
}

function estimateTokens(text) {
  if (!text) return 0;
  const chars = text.length;
  const cyr = (text.match(/[а-яёА-ЯЁ]/g) || []).length;
  const lat = (text.match(/[a-zA-Z]/g) || []).length;
  const cyrRatio = chars > 0 ? cyr / (cyr + lat + 1) : 0;
  return Math.ceil(chars / (2.5 + (1 - cyrRatio) * 1.5));
}

function buildFullFileText(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  let text = '';
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
    text += '## Лист: ' + name + '\n';
    text += rows.map(r => r.join(' | ')).join('\n') + '\n\n';
  }
  return text;
}

// Одиночный запрос к Auchan LLM (Qwen)
async function callAuchanRaw(messages, maxTokens = 800) {
  const { data } = await axios.post(cfg.AUCHAN_LLM_URL,
    { messages, max_tokens: maxTokens, temperature: 0.3, stream: false },
    { headers: {
        'X-Gravitee-Api-Key': cfg.AUCHAN_API_KEY,
        'Authorization': 'Bearer ' + cfg.AUCHAN_BEARER,
        'Content-Type': 'application/json',
      }, httpsAgent: agent, timeout: 120000 }
  );
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content)
    || 'Нет ответа от LLM';
}

// Разбивка документа на чанки по символам
function chunkText(text, maxChars = 40000, overlap = 2000) {
  if (text.length <= maxChars) return [text];
  const chunks = [];
  for (let i = 0; i < text.length; i += maxChars - overlap) {
    chunks.push(text.slice(i, i + maxChars));
    if (i + maxChars >= text.length) break;
  }
  return chunks;
}

// Простой scoring чанка по словам запроса
function scoreChunk(chunk, question) {
  const words = question.toLowerCase().match(/[а-яёa-z0-9]{3,}/g) || [];
  const lower = chunk.toLowerCase();
  let score = 0;
  for (const w of words) {
    const matches = lower.split(w).length - 1;
    score += matches;
  }
  return score;
}

// Запрос к Auchan LLM с обработкой больших документов
async function askAuchan(documentText, question) {
  const system = 'Ты помощник для анализа документов (Request Form на ИС). ' +
    'Отвечай на вопросы пользователя ТОЛЬКО на основе предоставленного документа. ' +
    'Если информации нет — скажи об этом. Отвечай конкретно, на русском.';

  // Лимит безопасного размера для Qwen (символов на вход)
  const SAFE_CHARS = 40000;  // ~16K токенов — безопасно для большинства контекстов

  // Документ помещается целиком
  if (documentText.length <= SAFE_CHARS) {
    return callAuchanRaw([
      { role: 'system', content: system },
      { role: 'user', content: 'ДОКУМЕНТ:\n' + documentText + '\n\nВОПРОС: ' + question },
    ]);
  }

  // Документ большой — мини-RAG: режем на чанки, берём релевантные
  console.log('   📑 Документ большой, ищу по частям...');
  const chunks = chunkText(documentText, SAFE_CHARS, 2000);

  // Ранжируем чанки по релевантности вопросу
  const scored = chunks
    .map((c, i) => ({ chunk: c, score: scoreChunk(c, question), idx: i }))
    .sort((a, b) => b.score - a.score);

  // Берём топ-2 самых релевантных чанка (или первый если все по нулям)
  const relevant = scored.filter(s => s.score > 0).slice(0, 2);
  const selected = relevant.length > 0 ? relevant : [scored[0]];

  console.log('   📑 Анализирую ' + selected.length + ' из ' + chunks.length + ' частей');

  // Если один чанк — простой запрос
  if (selected.length === 1) {
    return callAuchanRaw([
      { role: 'system', content: system },
      { role: 'user', content: 'ДОКУМЕНТ (фрагмент):\n' + selected[0].chunk + '\n\nВОПРОС: ' + question },
    ]);
  }

  // Несколько чанков — спрашиваем по каждому, потом объединяем
  const partial = [];
  for (const s of selected) {
    try {
      const ans = await callAuchanRaw([
        { role: 'system', content: system },
        { role: 'user', content: 'ДОКУМЕНТ (фрагмент):\n' + s.chunk + '\n\nВОПРОС: ' + question +
          '\n\nЕсли в этом фрагменте нет ответа — напиши "нет данных".' },
      ], 400);
      if (ans && !/^нет данных/i.test(ans.trim())) partial.push(ans);
    } catch (_) {}
  }

  if (!partial.length) return 'В документе не найдено информации по этому вопросу.';
  if (partial.length === 1) return partial[0];

  // Объединяем ответы из разных частей
  return callAuchanRaw([
    { role: 'user', content: 'Объедини эти ответы из разных частей документа в один связный ответ на вопрос "' +
      question + '":\n\n' + partial.join('\n\n---\n\n') },
  ], 600);
}

async function main() {
  if (!cfg.YANDEX_DISK_TOKEN) { console.error('❌ YANDEX_DISK_TOKEN не задан'); process.exit(1); }
  if (!cfg.AUCHAN_BEARER)     { console.error('❌ AUCHAN_BEARER не задан (нужен для вопросов к LLM)'); process.exit(1); }

  console.log('📥 Читаю TESTing.xlsx...');
  const buf = await downloadFile(TESTING_PATH);
  const wb  = XLSX.read(buf, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });

  const COL = { ip: 1, is: 3, link: 7 };

  // Собираем уникальные файлы
  const files = [];
  const seenLinks = new Set();
  for (let r = 1; r < rows.length; r++) {
    const ip   = String(rows[r][COL.ip]   || '').trim();
    const is   = String(rows[r][COL.is]   || '').trim();
    const link = String(rows[r][COL.link] || '').trim();
    if (!link || seenLinks.has(link)) continue;
    seenLinks.add(link);
    files.push({ row: r, ip, is, link });
  }

  console.log('\n📋 Уникальных РФ-файлов: ' + files.length + '\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(res => rl.question(q, res));

  // Выбор файла
  let selected = null;

  if (PRESET_IP) {
    selected = files.find(f => f.ip === PRESET_IP) || files.find(f => f.ip.includes(PRESET_IP));
    if (selected) console.log('Выбран по IP: ' + PRESET_IP);
  }

  if (!selected) {
    // Показываем список
    console.log('Доступные файлы:');
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      console.log('  ' + String(i+1).padStart(3) + '. IP ' + f.ip.padEnd(15) +
                  ' ' + (f.is || '—').slice(0, 30));
    }

    if (LIST_ONLY) { rl.close(); return; }

    const choice = await ask('\nВыберите номер файла (или IP): ');
    const num = parseInt(choice.trim());
    if (!isNaN(num) && num >= 1 && num <= files.length) {
      selected = files[num - 1];
    } else {
      selected = files.find(f => f.ip === choice.trim() || f.ip.includes(choice.trim()));
    }
  }

  if (!selected) { console.log('Файл не выбран.'); rl.close(); return; }

  // Загружаем документ
  console.log('\n📥 Загружаю документ для IP ' + selected.ip + '...');
  const rfBuf = await downloadFile(selected.link);
  const docText = buildFullFileText(rfBuf);
  const tokens = estimateTokens(docText);

  console.log('✅ Документ загружен:');
  console.log('   IP:       ' + selected.ip);
  console.log('   ИС:       ' + (selected.is || '—'));
  console.log('   Символов: ' + docText.length.toLocaleString());
  console.log('   Токенов:  ~' + tokens.toLocaleString());

  if (tokens > 30000) {
    console.log('   ⚠️  Большой документ — может превысить контекст LLM');
  }

  // Режим одного вопроса (без интерактивного цикла)
  if (SINGLE_QUESTION) {
    console.log('\n❓ Вопрос: ' + SINGLE_QUESTION);
    try {
      const answer = await askAuchan(docText, SINGLE_QUESTION);
      console.log('💡 Ответ: ' + answer + '\n');
    } catch (e) {
      console.log('❌ Ошибка: ' + e.message + '\n');
    }
    rl.close();
    return;
  }

  console.log('\n💬 Задавайте вопросы по документу (exit для выхода):\n');

  // Интерактивный цикл вопросов
  const askLoop = () => {
    rl.question('❓ Вопрос: ', async (question) => {
      question = (question || '').trim();
      if (question === 'exit' || question === 'выход') { rl.close(); return; }
      if (!question) { askLoop(); return; }
      try {
        process.stdout.write('   🤔 Думаю...\r');
        const answer = await askAuchan(docText, question);
        console.log('   💡 ' + answer + '\n');
      } catch (e) {
        console.log('   ❌ Ошибка: ' + e.message.slice(0, 80) + '\n');
      }
      askLoop();
    });
  };
  askLoop();
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
