'use strict';
/**
 * fill_from_rflist.js — заполнение TESTing.xlsx по списку РФ-файлов rf_list.xlsx
 *
 * ОТЛИЧИЕ от fill_testing.js:
 *   В fill_testing.js ссылка на РФ уже была в каждой строке TESTing (столбец 7),
 *   и для каждого IP качался файл из той же строки.
 *   Здесь ссылка НЕИЗВЕСТНА — её нужно НАЙТИ, перебрав файлы из rf_list.xlsx,
 *   и сама найденная ссылка записывается в столбец «Ссылка на РФ».
 *
 * Алгоритм (эффективный, без N×M скачиваний):
 *   1. rf_list.xlsx → список ссылок на РФ-файлы.
 *   2. Каждый РФ скачиваем ОДИН раз и строим индекс:
 *        IP → { dns, is, solution, responsible, codir, link }
 *      (IP и DNS — из раздела «Компоненты и адреса», метаданные ИС — из «Описание ИС»;
 *       поиск ведём по всем листам, поля добираем LLM при необходимости).
 *   3. TESTing.xlsx: на каждом листе находим колонки ПО ЗАГОЛОВКУ
 *      (раскладка PUB DMZ и PRIVATE DMZ разная) и заполняем по индексу.
 *   4. Сохраняем TESTing_filled.xlsx (оригинал не трогаем) + опц. загрузка на Диск.
 *
 * Использование как модуль (из бота):
 *   const { run } = require('./fill_from_rflist');
 *   const summary = await run({ dryRun, limit, noLlm, noUpload, multi }, onProgress);
 *
 * Запуск из CLI:
 *   node fill_from_rflist.js --inspect="<ссылка на РФ>"   # выгрузить структуру одного РФ
 *   node fill_from_rflist.js --dry-run --limit=20         # тест без записи
 *   node fill_from_rflist.js --no-llm                     # только прямой парсинг
 *   node fill_from_rflist.js                              # полный прогон
 *   node fill_from_rflist.js --no-upload                  # не заливать на Диск
 *
 * Зависимости: npm install   (нужен xlsx, axios — уже в package.json)
 * Требует .env: YANDEX_DISK_TOKEN, и (для добора полей) AUCHAN_* для LLM.
 */

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const XLSX  = require('xlsx');
const cfg   = require('./config');

// ── HTTP / Яндекс Диск ──
// Точечное отключение проверки TLS только для внутренних эндпоинтов (корп. сертификаты)
const agent = new (require('https').Agent)({ rejectUnauthorized: false, keepAlive: false });
const diskAx = axios.create({
  baseURL: 'https://cloud-api.yandex.net/v1/disk',
  headers: { Authorization: 'OAuth ' + cfg.YANDEX_DISK_TOKEN },
  httpsAgent: agent,
  timeout: 30000,
});

async function downloadFromDisk(diskPath) {
  const { data: dl } = await diskAx.get('/resources/download', { params: { path: diskPath } });
  const { data: buf } = await axios.get(dl.href, { responseType: 'arraybuffer', httpsAgent: agent, timeout: 60000, maxRedirects: 5 });
  return Buffer.from(buf);
}
async function downloadFromPublicLink(url) {
  const { data: dl } = await diskAx.get('/public/resources/download', { params: { public_key: url } });
  const { data: buf } = await axios.get(dl.href, { responseType: 'arraybuffer', httpsAgent: agent, timeout: 60000, maxRedirects: 5 });
  return Buffer.from(buf);
}
async function downloadFile(linkOrPath) {
  const s = cleanLink(linkOrPath);
  if (!s) throw new Error('пустая ссылка');
  if (s.includes('disk.yandex.ru') || s.includes('yadi.sk')) {
    const m = s.match(/\/client\/disk(\/.+?)(?:\?|$)/);
    if (m) return downloadFromDisk(decodeURIComponent(m[1]));
    return downloadFromPublicLink(s);
  }
  return downloadFromDisk(s.startsWith('/') ? s : '/' + s);
}
async function uploadToDisk(diskPath, buffer) {
  const { data: up } = await diskAx.get('/resources/upload', { params: { path: diskPath, overwrite: 'true' } });
  await axios.put(up.href, buffer, {
    httpsAgent: agent, timeout: 120000, maxRedirects: 5,
    headers: { 'Content-Type': 'application/octet-stream' },
    maxBodyLength: Infinity, maxContentLength: Infinity,
  });
}

// Чистим ссылку от эмодзи/пробелов/NBSP (в rf_list ссылки вида " 🔗 https://...")
function cleanLink(s) {
  return String(s == null ? '' : s)
    .replace(/ /g, ' ')
    .replace(/🔗/g, '')
    .trim();
}

// ── Утилиты xlsx ──
const IP_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
const isIp = (s) => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(String(s).trim());

function sheetRows(ws) {
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
}
function normHeader(s) {
  return String(s || '').replace(/ /g, ' ').trim().toLowerCase();
}

// Находим индексы колонок по заголовку (раскладка листов TESTing разная)
function mapColumns(headerRow) {
  const find = (...subs) => headerRow.findIndex(h => {
    const n = normHeader(h);
    return subs.some(s => n.includes(s));
  });
  return {
    ip:          find('ip adress', 'ip address', 'ip adr', 'ip '),
    dns:         find('dns'),
    is:          find('название ис', 'name of', 'is name'),
    solution:    find('soluqiq', 'soluqip', 'код проекта'),
    responsible: find('ответствен', 'responsible'),
    codir:       find('codir'),
    link:        find('ссылка на рф', 'ссылка'),
  };
}

// Очистка кандидата в DNS: берём часть до " - ", переноса строки, ';'
function cleanDns(v) {
  return String(v == null ? '' : v).split(/\n|;|\s-\s/)[0].replace(/ /g, ' ').trim();
}

// Значения, которые НЕ являются DNS (тип/протокол/роль/заголовки разделов)
const DNS_BLOCK = new Set([
  'https', 'http', 'web', 'app', 'app / all in one', 'all in one', 'file server',
  'kafka transfer', 'src nat', 'dst nat', 'balancer', 'nat', 'n/a', 'na', '-', '—',
]);

// Похоже ли значение на DNS-имя сервера (буквы+цифры без пробелов, либо домен с точкой)
function looksLikeDns(v) {
  const s = cleanDns(v);
  if (!s || isIp(s) || s.includes('@')) return false;
  const low = s.toLowerCase();
  if (DNS_BLOCK.has(low)) return false;
  if (/^\d+[.)]\s/.test(s)) return false;                 // «2. ...» — заголовок раздела
  if (/компоненты и адреса|описание ис/i.test(s)) return false;
  const core = s.replace(/\s+/g, '');
  // hostname: буквы И цифры, длина >= 5 (proxy_dmz_240_0, lnxcrud157ap173, csru262ap119)
  if (/^[a-z0-9._-]+$/i.test(core) && /[a-z]/i.test(core) && /\d/.test(core) && core.length >= 5) return true;
  // либо доменное имя с точкой и TLD
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(core)) return true;
  return false;
}

// ── Индексация одного РФ-файла: IP → данные ──
// Возвращает { ips:Set, dnsByIp:Map, is, solution, responsible, codir, rawHead, rawRaci }
function indexRfFile(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const out = { ips: new Set(), dnsByIp: new Map(), is: '', solution: '', responsible: '', codir: '', rawHead: [], rawRaci: [] };

  // Перебираем все листы (раздел «Компоненты и адреса» с IP может быть отдельным листом
  // или секцией внутри листа — поэтому ищем по всем).
  for (const sheetName of wb.SheetNames) {
    const rows = sheetRows(wb.Sheets[sheetName]);
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      for (let ci = 0; ci < row.length; ci++) {
        const cell = String(row[ci]);
        const matches = cell.match(IP_RE);
        if (!matches) continue;
        for (const ip of matches) {
          out.ips.add(ip);
          // DNS того же сервера — ищем hostname-подобную ячейку в этой же строке
          if (!out.dnsByIp.has(ip)) {
            let dns = '';
            // приоритет: соседняя ячейка слева/справа, затем любая hostname-подобная
            const candidates = [row[ci - 1], row[ci + 1], row[3], row[2], ...row];
            for (const c of candidates) {
              if (looksLikeDns(c)) { dns = cleanDns(c); break; }
            }
            if (dns) out.dnsByIp.set(ip, dns);
          }
        }
      }
    }
  }

  // Метаданные ИС («Описание ИС») — по меткам, через все листы.
  // Эвристики совпадают с проверенным parseRfFile из fill_testing.js.
  const allRows = [];
  for (const sheetName of wb.SheetNames) {
    for (const row of sheetRows(wb.Sheets[sheetName])) allRows.push(row);
  }

  // Значение является заголовком раздела (не данными)?
  const isSectionHeader = (v) => /^\s*\d+[.)]\s|компоненты и адреса|описание ис|общие сведения|сетев(ые|ое)/i.test(v);

  const valueAfterLabel = (labelRe, maxRows = 120) => {
    for (let r = 0; r < Math.min(allRows.length, maxRows); r++) {
      const idx = allRows[r].findIndex(c => labelRe.test(String(c)));
      if (idx >= 0) {
        for (let ci = idx + 1; ci < allRows[r].length; ci++) {
          const val = String(allRows[r][ci]).replace(/ /g, ' ').trim();
          if (val && val.length > 1 && !labelRe.test(val) && !isSectionHeader(val)) return val;
        }
      }
    }
    return '';
  };

  // Название ИС — БЕЗ метки «Описание ИС» (это раздел, а не поле)
  out.is          = valueAfterLabel(/Название ИС|Наименование ИС|Name of.*system|IS name/i);
  // SoluQiq / SoliQiq / Код проекта — срезаем префикс-метку из значения
  out.solution    = valueAfterLabel(/Sol[uio]Qi[qp]|Код проекта|Код ИС/i)
                      .replace(/^Sol[uio]Qi[qp]\s*[:\-]?\s*/i, '').trim();
  out.responsible = valueAfterLabel(/Руководитель проекта|Ответственн|\(РП\)/i);
  out.codir       = valueAfterLabel(/Начальник РП|Начальник проекта|Руководитель ИТ|CODIR/i);

  // Фолбэк для SoluQiq: если ровно один код RU_APP_### во всём файле — берём его
  if (!out.solution) {
    const wholeText = allRows.map(r => r.join(' ')).join('\n');
    const codes = [...new Set((wholeText.match(/\bRU_APP_\d+\b/gi) || []).map(s => s.toUpperCase()))];
    if (codes.length === 1) out.solution = codes[0];
  }

  out.rawHead = allRows.slice(0, 60);
  const raci = wb.Sheets['RACI'];
  if (raci) out.rawRaci = sheetRows(raci).slice(0, 30);

  return out;
}

// ── LLM-добор недостающих метаданных (Auchan Qwen) ──
function parseJsonAnswer(text) {
  try { const m = String(text).match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); } catch (_) {}
  return null;
}
async function askLLMMeta(rawHead, rawRaci) {
  if (!cfg.AUCHAN_BEARER) return null;
  const headText = (rawHead || []).map(r => r.join(' | ')).join('\n').slice(0, 4000);
  const raciText = (rawRaci || []).map(r => r.join(' | ')).join('\n').slice(0, 3000);
  const prompt = `Это форма-заявка (Request form) на информационную систему. Из раздела «Описание ИС» извлеки данные.

ШАПКА ФОРМЫ:
${headText}

МАТРИЦА RACI (ответственные):
${raciText}

Верни СТРОГО JSON без пояснений:
{"is":"Название ИС","solution":"код проекта SoluQiq","responsible":"ФИО из поля Руководитель проекта (РП)","codir":"ФИО из поля Начальник РП"}
Если значение не найдено — пустая строка. Только JSON.`;
  try {
    const { data } = await axios.post(cfg.AUCHAN_LLM_URL,
      { messages: [{ role: 'user', content: prompt }], max_tokens: 400, temperature: 0, stream: false },
      { headers: {
          'X-Gravitee-Api-Key': cfg.AUCHAN_API_KEY,
          'Authorization': 'Bearer ' + cfg.AUCHAN_BEARER,
          'Content-Type': 'application/json',
        }, httpsAgent: agent, timeout: 90000 });
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    return parseJsonAnswer(text);
  } catch (e) {
    return null;
  }
}

// ── Режим inspect: выгрузить структуру одного РФ (чтобы свериться) ──
async function inspectRf(link) {
  const lines = ['🔎 Inspect РФ: ' + link, ''];
  const buf = await downloadFile(link);
  const wb  = XLSX.read(buf, { type: 'buffer' });
  lines.push('Листы: ' + wb.SheetNames.join(', '), '');
  for (const name of wb.SheetNames) {
    const rows = sheetRows(wb.Sheets[name]);
    lines.push(`=== Лист «${name}» (${rows.length} строк) ===`);
    for (let r = 0; r < Math.min(rows.length, 25); r++) {
      const cells = rows[r].map(c => String(c).replace(/ /g, ' ').slice(0, 22));
      if (cells.some(c => c.trim())) lines.push(`  [${r}] ` + JSON.stringify(cells));
    }
    lines.push('');
  }
  const idx = indexRfFile(buf);
  lines.push('Найдено IP: ' + idx.ips.size);
  lines.push('Пример DNS: ' + [...idx.dnsByIp.entries()].slice(0, 5).map(([k, v]) => k + '→' + v).join(', '));
  lines.push(`Метаданные: ИС="${idx.is}" Solu="${idx.solution}" Отв="${idx.responsible}" CODIR="${idx.codir}"`);
  return lines.join('\n');
}

// ── Основной процесс (вызывается из бота и из CLI) ──
// opts: { dryRun, limit, noLlm, noUpload, multi, testingPath, rflistPath }
// onProgress(text): колбэк прогресса (необязательный)
async function run(opts = {}, onProgress = () => {}) {
  const {
    dryRun = false, noLlm = false, noUpload = false,
    limit = Infinity, multi = 'first',
    testingPath = '/00_Project_IS/TESTing.xlsx',
    rflistPath  = '/00_Project_IS/rf_list.xlsx',
  } = opts;

  if (!cfg.YANDEX_DISK_TOKEN) throw new Error('YANDEX_DISK_TOKEN не задан в .env');

  const prog = (t) => { try { onProgress(t); } catch (_) {} };

  // 1. Список РФ-ссылок из rf_list.xlsx
  prog('📥 Читаю rf_list.xlsx...');
  const rfListBuf = await downloadFile(rflistPath);
  const rfWb = XLSX.read(rfListBuf, { type: 'buffer' });
  const rfRows = sheetRows(rfWb.Sheets[rfWb.SheetNames[0]]);
  const rfLinks = [];
  for (const row of rfRows) {
    for (const cell of row) {
      const s = cleanLink(cell);
      if (/^https?:\/\//i.test(s) || s.startsWith('/')) { rfLinks.push(s); break; }
    }
  }
  prog(`📋 РФ-файлов в списке: ${rfLinks.length}\n🔧 Индексирую...`);

  // 2. Строим индекс IP → данные
  const index = new Map();
  let rfOk = 0, rfErr = 0;
  const errLinks = [];
  for (let i = 0; i < rfLinks.length; i++) {
    const link = rfLinks[i];
    try {
      const buf = await downloadFile(link);
      const idx = indexRfFile(buf);

      if (!noLlm && (!idx.is || !idx.solution || !idx.responsible || !idx.codir)) {
        const llm = await askLLMMeta(idx.rawHead, idx.rawRaci);
        if (llm) {
          idx.is          = idx.is          || llm.is          || '';
          idx.solution    = idx.solution    || llm.solution    || '';
          idx.responsible = idx.responsible || llm.responsible || '';
          idx.codir       = idx.codir       || llm.codir       || '';
        }
      }

      for (const ip of idx.ips) {
        const rec = { dns: idx.dnsByIp.get(ip) || '', is: idx.is, solution: idx.solution, responsible: idx.responsible, codir: idx.codir, link };
        if (!index.has(ip)) index.set(ip, [rec]);
        else index.get(ip).push(rec);
      }
      rfOk++;
    } catch (e) {
      rfErr++;
      errLinks.push(link + '  (' + e.message.slice(0, 40) + ')');
    }
    prog(`🔧 Индексирую РФ: ${i + 1}/${rfLinks.length}\n   уникальных IP: ${index.size}, ошибок: ${rfErr}`);
  }

  // 3. TESTing.xlsx — заполняем оба листа по заголовкам
  prog(`✅ Индекс готов: ${index.size} IP из ${rfOk} РФ.\n📥 Читаю TESTing.xlsx...`);
  const testBuf = await downloadFile(testingPath);
  const testWb  = XLSX.read(testBuf, { type: 'buffer' });

  let totalFilled = 0, totalRows = 0, notFound = 0;
  const perSheet = [];

  for (const sheetName of testWb.SheetNames) {
    const rows = sheetRows(testWb.Sheets[sheetName]);
    if (!rows.length) continue;
    const col = mapColumns(rows[0]);
    if (col.ip < 0) { perSheet.push(`«${sheetName}»: нет колонки IP — пропуск`); continue; }

    let filled = 0;
    for (let r = 1; r < rows.length && totalRows < limit; r++) {
      const row = rows[r];
      const ips = (String(row[col.ip] || '').match(IP_RE) || []);
      if (!ips.length) continue;
      totalRows++;

      let recs = null;
      for (const ip of ips) { if (index.has(ip)) { recs = index.get(ip); break; } }
      if (!recs) { notFound++; continue; }

      const rec = recs[0];
      const links = multi === 'all' ? [...new Set(recs.map(x => x.link))].join(' ; ') : rec.link;

      const setIf = (ci, val) => { if (ci >= 0 && val && !String(row[ci]).trim()) { row[ci] = val; return true; } return false; };
      let any = false;
      any = setIf(col.dns,         rec.dns)         || any;
      any = setIf(col.is,          rec.is)          || any;
      any = setIf(col.solution,    rec.solution)    || any;
      any = setIf(col.responsible, rec.responsible) || any;
      any = setIf(col.codir,       rec.codir)       || any;
      if (col.link >= 0 && links && !/^https?:|disk\.yandex/i.test(String(row[col.link]))) { row[col.link] = links; any = true; }

      if (any) { filled++; totalFilled++; }
    }

    if (!dryRun) {
      const newSheet = XLSX.utils.aoa_to_sheet(rows);
      if (testWb.Sheets[sheetName]['!cols']) newSheet['!cols'] = testWb.Sheets[sheetName]['!cols'];
      testWb.Sheets[sheetName] = newSheet;
    }
    perSheet.push(`«${sheetName}»: заполнено ${filled}`);
    prog(`📝 ${perSheet.join('\n')}`);
  }

  // 4. Сохранение
  let savedPath = '', uploaded = false, uploadPath = '';
  if (!dryRun && totalFilled) {
    const outBuffer = XLSX.write(testWb, { type: 'buffer', bookType: 'xlsx' });
    savedPath = path.join(process.cwd(), 'TESTing_filled.xlsx');
    fs.writeFileSync(savedPath, outBuffer);

    if (!noUpload) {
      uploadPath = testingPath.replace(/\.xlsx$/, '_filled.xlsx');
      for (let attempt = 1; attempt <= 3; attempt++) {
        try { await uploadToDisk(uploadPath, outBuffer); uploaded = true; break; }
        catch (e) { if (attempt < 3) await new Promise(r => setTimeout(r, 5000)); }
      }
    }
  }

  // Итоговый отчёт
  const summary = [
    dryRun ? '✅ DRY-RUN завершён (без записи)' : '✅ Заполнение завершено',
    `РФ проиндексировано: ${rfOk} (ошибок: ${rfErr}), уникальных IP: ${index.size}`,
    errLinks.length ? '⚠️ Не скачались РФ:\n  ' + errLinks.slice(0, 5).join('\n  ') : '',
    ...perSheet,
    `Строк обработано: ${totalRows}, заполнено: ${totalFilled}, IP не найден в РФ: ${notFound}`,
    savedPath ? `💾 Локально: ${savedPath}` : '',
    uploaded ? `📤 Загружено на Диск: ${uploadPath}` : (savedPath && !noUpload ? '⚠️ На Диск не загружено (см. логи)' : ''),
  ].filter(Boolean).join('\n');

  return { summary, totalFilled, totalRows, notFound, indexedIps: index.size, rfOk, rfErr };
}

module.exports = { run, inspectRf, indexRfFile, mapColumns, downloadFile };

// ── CLI ──
if (require.main === module) {
  const arg = (prefix) => { const a = process.argv.find(x => x.startsWith(prefix)); return a ? a.slice(prefix.length) : null; };
  const INSPECT = arg('--inspect=');
  (async () => {
    if (INSPECT) { console.log(await inspectRf(INSPECT)); return; }
    const res = await run({
      dryRun:   process.argv.includes('--dry-run'),
      noLlm:    process.argv.includes('--no-llm'),
      noUpload: process.argv.includes('--no-upload'),
      limit:    parseInt(arg('--limit=') || '999999', 10),
      multi:    arg('--multi=') || 'first',
      testingPath: arg('--testing=') || '/00_Project_IS/TESTing.xlsx',
      rflistPath:  arg('--rflist=')  || '/00_Project_IS/rf_list.xlsx',
    }, (t) => console.log(t.split('\n')[0]));
    console.log('\n' + res.summary);
  })().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}
