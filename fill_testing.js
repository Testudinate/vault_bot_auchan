'use strict';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
/**
 * fill_testing.js — заполнение TESTing.xlsx данными из РФ-файлов (Request form)
 *
 * Гибридный подход:
 *  C (DNS Name)     — прямой парсинг: строка с IP в листе "Request", столбец [3]
 *  D (Название ИС)  — из шапки формы (строка 7) или LLM
 *  E (SoluQiq)      — из шапки формы (строка 6) или LLM
 *  F (Ответственный)— LLM (из RACI / шапки)
 *  G (CODIR IT)     — LLM
 *
 * Запуск:
 *   node fill_testing.js --dry-run --limit=3   # тест
 *   node fill_testing.js                       # полный прогон
 *   node fill_testing.js --no-llm              # только парсинг (C,D,E)
 */

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const XLSX  = require('xlsx');
const cfg   = require('./config');

const DRY_RUN = process.argv.includes('--dry-run');
const NO_LLM  = process.argv.includes('--no-llm');
const LIMIT   = parseInt((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '99999');
const TESTING_PATH = (process.argv.find(a => a.startsWith('--path=')) || '').split('=')[1]
  || '/00_Project_IS/TESTing.xlsx';
// По умолчанию создаём отдельный файл TESTing_filled.xlsx (не трогаем оригинал)
// --overwrite перезаписывает исходный файл
const OVERWRITE = process.argv.includes('--overwrite');
// --tokens только считает токены по каждому файлу, ничего не заполняет
const TOKENS_MODE = process.argv.includes('--tokens');
// --full считает токены всего файла (все листы), иначе только то что идёт в LLM
const FULL_TOKENS = process.argv.includes('--full');
const UPLOAD_PATH = OVERWRITE
  ? TESTING_PATH
  : TESTING_PATH.replace(/\.xlsx$/, '_filled.xlsx');

const agent = new (require('https').Agent)({ rejectUnauthorized: false, keepAlive: false });
const diskAx = axios.create({
  baseURL: 'https://cloud-api.yandex.net/v1/disk',
  headers: { Authorization: 'OAuth ' + cfg.YANDEX_DISK_TOKEN },
  httpsAgent: agent,
  timeout: 30000,
});

// ── Скачивание ──
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
  const s = (linkOrPath || '').trim();
  if (!s) throw new Error('пустая ссылка');
  if (s.includes('disk.yandex.ru') || s.includes('yadi.sk')) {
    const clientMatch = s.match(/\/client\/disk(\/.+?)(?:\?|$)/);
    if (clientMatch) return downloadFromDisk(decodeURIComponent(clientMatch[1]));
    return downloadFromPublicLink(s);
  }
  return downloadFromDisk(s.startsWith('/') ? s : '/' + s);
}

// ── Загрузка файла обратно на Яндекс Диск (перезапись) ──
async function uploadToDisk(diskPath, buffer) {
  // 1. Получаем URL для загрузки (overwrite=true перезаписывает)
  const { data: up } = await diskAx.get('/resources/upload', {
    params: { path: diskPath, overwrite: 'true' },
  });
  // 2. Загружаем файл PUT-запросом
  await axios.put(up.href, buffer, {
    httpsAgent: agent,
    timeout: 120000,
    maxRedirects: 5,
    headers: { 'Content-Type': 'application/octet-stream' },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
}

// ── Прямой парсинг РФ-файла ──
function parseRfFile(buffer, targetIP) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const result = { dns: '', is: '', solution: '', responsible: '', codir: '', found: false };

  const requestSheet = wb.Sheets['Request'] || wb.Sheets[wb.SheetNames[0]];
  if (!requestSheet) return result;

  const rows = XLSX.utils.sheet_to_json(requestSheet, { header: 1, defval: '' });
  const ipClean = String(targetIP).trim();

  // 1. DNS Name — строка с IP в столбце [8], берём столбец [3]
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    // IP может быть в разных столбцах — ищем точное совпадение
    for (let ci = 0; ci < row.length; ci++) {
      if (String(row[ci]).trim() === ipClean) {
        // Нашли строку с IP. DNS обычно в столбце [3]
        const dns = String(row[3] || '').trim();
        // Проверяем что это похоже на DNS (есть буквы, не пусто, не сам IP)
        if (dns && dns !== ipClean && /[a-zа-я_]/i.test(dns)) {
          result.dns = dns;
          result.found = true;
        }
        // Если в [3] пусто, пробуем [2] (App / All in one) как запасной
        if (!result.dns) {
          const alt = String(row[2] || '').trim();
          if (alt && alt !== ipClean && /[a-zа-я_]/i.test(alt)) result.dns = alt;
        }
        break;
      }
    }
    if (result.dns) break;
  }

  // 2. SoluQiq — ищем в шапке "Код проекта / SoluQiq:" или "SoluQiq"
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const rowText = rows[r].map(c => String(c)).join(' ');
    const m = rowText.match(/Solu[QО]iq[:\s]*([A-ZА-Я0-9\-_]+)/i)
           || rowText.match(/Код проекта[:\s\/]*([A-ZА-Я0-9\-_]{3,})/i);
    if (m) {
      // Берём значение из соседних ячеек если в тексте нет
      result.solution = m[1].trim();
      // Часто значение в следующих столбцах той же строки
      const idx = rows[r].findIndex(c => /Solu[QО]iq|Код проекта/i.test(String(c)));
      if (idx >= 0) {
        for (let ci = idx + 1; ci < rows[r].length; ci++) {
          const val = String(rows[r][ci]).trim();
          if (val && val.length > 1) { result.solution = val; break; }
        }
      }
      break;
    }
  }

  // 3. Название ИС — ищем "Название ИС на английском" и берём значение
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const idx = rows[r].findIndex(c => /Название ИС|Name of.*system|IS name/i.test(String(c)));
    if (idx >= 0) {
      for (let ci = idx + 1; ci < rows[r].length; ci++) {
        const val = String(rows[r][ci]).trim();
        if (val && val.length > 1 && !/название/i.test(val)) { result.is = val; break; }
      }
      if (result.is) break;
    }
  }

  // 4. Ответственный (F) — поле "Руководитель проекта (РП)"
  //    CODIR IT (G)    — поле "Начальник РП"
  const findFieldValue = (labelRegex, excludeRegex) => {
    for (let r = 0; r < Math.min(rows.length, 80); r++) {
      const idx = rows[r].findIndex(c => labelRegex.test(String(c)));
      if (idx >= 0) {
        for (let ci = idx + 1; ci < rows[r].length; ci++) {
          const val = String(rows[r][ci]).trim();
          if (val && val.length > 2 && !excludeRegex.test(val)) return val;
        }
      }
    }
    return '';
  };

  // Значение считаем "меткой" (не данными) если это сам заголовок поля
  const isLabel = (v) => /^(руководитель проекта|начальник рп|начальник проекта|рп)\s*\(?.*\)?$/i.test(v.trim());

  // F: "Руководитель проекта (РП)"
  result.responsible = findFieldValue(
    /Руководитель проекта|\(РП\)/i,
    /^\s*$/  // исключаем только пустое
  );
  if (isLabel(result.responsible)) result.responsible = '';

  // G: "Начальник РП"
  result.codir = findFieldValue(
    /Начальник РП|Начальник проекта/i,
    /^\s*$/
  );
  if (isLabel(result.codir)) result.codir = '';

  // Сохраняем сырьё для LLM (шапка + RACI)
  result.rawHead = rows.slice(0, 60);
  const raciSheet = wb.Sheets['RACI'];
  if (raciSheet) {
    result.rawRaci = XLSX.utils.sheet_to_json(raciSheet, { header: 1, defval: '' }).slice(0, 30);
  }

  return result;
}

// ── LLM для F (Ответственный) и G (CODIR IT) ──
async function askLLM(targetIP, dns, rawHead, rawRaci) {
  const headText = (rawHead || []).map(r => r.join(' | ')).join('\n').slice(0, 4000);
  const raciText = (rawRaci || []).map(r => r.join(' | ')).join('\n').slice(0, 3000);

  const prompt = `Это форма-заявка (Request form) на информационную систему. Найди данные для сервера с IP "${targetIP}" (DNS: ${dns || 'неизвестен'}).

ШАПКА ФОРМЫ:
${headText}

МАТРИЦА RACI (ответственные):
${raciText}

Верни СТРОГО JSON без пояснений:
{"is":"название ИС","solution":"код проекта SoluQiq","responsible":"ФИО из поля Руководитель проекта (РП)","codir":"ФИО из поля Начальник РП"}

ВАЖНО:
- responsible — значение из поля "Руководитель проекта (РП)"
- codir — значение из поля "Начальник РП"
Это ДВА РАЗНЫХ поля, не путай их.
Если значение не найдено — пустая строка. Только JSON.`;

  // Auchan LLM
  if (cfg.AUCHAN_BEARER) {
    try {
      const { data } = await axios.post(cfg.AUCHAN_LLM_URL,
        { messages: [{ role: 'user', content: prompt }], max_tokens: 400, temperature: 0, stream: false },
        { headers: {
            'X-Gravitee-Api-Key': cfg.AUCHAN_API_KEY,
            'Authorization': 'Bearer ' + cfg.AUCHAN_BEARER,
            'Content-Type': 'application/json',
          }, httpsAgent: agent, timeout: 90000 }
      );
      const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
      const parsed = parseJsonAnswer(text);
      if (parsed) return parsed;
    } catch (e) { console.log('      (Auchan LLM недоступен: ' + e.message.slice(0,40) + ')'); }
  }

  return null;
}

function parseJsonAnswer(text) {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
  } catch (_) {}
  return null;
}

// ── Оценка токенов ──
// Приблизительно: для русского ~2.5 символа/токен, английского ~4 символа/токен
// Берём консервативную оценку с учётом смешанного текста и таблиц
function estimateTokens(text) {
  if (!text) return 0;
  const chars   = text.length;
  const cyrillic = (text.match(/[а-яёА-ЯЁ]/g) || []).length;
  const latin    = (text.match(/[a-zA-Z]/g) || []).length;
  const cyrRatio = chars > 0 ? cyrillic / (cyrillic + latin + 1) : 0;
  // Кириллица ~2.5 симв/токен, латиница ~4 симв/токен
  const charsPerToken = 2.5 + (1 - cyrRatio) * 1.5;
  return Math.ceil(chars / charsPerToken);
}

// Собирает весь текст который реально уйдёт в LLM для одного РФ-файла
function buildLlmInputText(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  let fullText = '';
  // Шапка из Request (первые 60 строк) + RACI (первые 30) — как в askLLM
  const requestSheet = wb.Sheets['Request'] || wb.Sheets[wb.SheetNames[0]];
  if (requestSheet) {
    const rows = XLSX.utils.sheet_to_json(requestSheet, { header: 1, defval: '' });
    fullText += rows.slice(0, 60).map(r => r.join(' | ')).join('\n');
  }
  const raciSheet = wb.Sheets['RACI'];
  if (raciSheet) {
    const rows = XLSX.utils.sheet_to_json(raciSheet, { header: 1, defval: '' });
    fullText += '\n' + rows.slice(0, 30).map(r => r.join(' | ')).join('\n');
  }
  return fullText;
}

// Собирает ПОЛНЫЙ текст всего файла (все листы целиком)
function buildFullFileText(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  let fullText = '';
  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
    fullText += '## ' + sheetName + '\n';
    fullText += rows.map(r => r.join(' | ')).join('\n') + '\n\n';
  }
  return fullText;
}

// ── MAIN ──
async function main() {
  if (!cfg.YANDEX_DISK_TOKEN) { console.error('❌ YANDEX_DISK_TOKEN не задан'); process.exit(1); }

  console.log('📥 Скачиваю TESTing.xlsx: ' + TESTING_PATH);
  const testingBuf = await downloadFile(TESTING_PATH);
  const wb    = XLSX.read(testingBuf, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  const rows  = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });

  console.log('   Строк: ' + rows.length);
  console.log(DRY_RUN ? '   ⚠️  DRY-RUN\n' : '\n');

  const COL = { ip: 1, dns: 2, is: 3, solution: 4, responsible: 5, codir: 6, link: 7 };
  const rfCache = new Map();
  let processed = 0, filled = 0, viaLLM = 0, errors = 0;

  // ── РЕЖИМ ПОДСЧЁТА ТОКЕНОВ ──
  if (TOKENS_MODE) {
    console.log('🔢 Режим подсчёта токенов' + (FULL_TOKENS ? ' (весь файл)' : ' (вход LLM)') + '\n');
    const linkTokens = new Map();   // ссылка → токены
    const linkChars  = new Map();   // ссылка → символы
    const results = [];
    let totalTokens = 0;

    for (let r = 1; r < rows.length && processed < LIMIT; r++) {
      const ip   = String(rows[r][COL.ip]   || '').trim();
      const link = String(rows[r][COL.link] || '').trim();
      if (!ip || !link) continue;
      processed++;

      try {
        let tokens = linkTokens.get(link);
        if (tokens === undefined) {
          let buf = rfCache.get(link);
          if (!buf) { buf = await downloadFile(link); rfCache.set(link, buf); }
          const text = buildFullFileText(buf);  // всегда полный файл для загрузки в LLM
          tokens = estimateTokens(text);
          linkChars.set(link, text.length);
          linkTokens.set(link, tokens);
        }
        const chars = linkChars.get(link);
        totalTokens += tokens;
        results.push({ row: r, ip, link, tokens, chars });
        console.log('  [' + r + '] IP ' + ip.padEnd(15) + ' ' + chars + ' симв, ~' + tokens + ' токенов');
      } catch (e) {
        console.log('  [' + r + '] IP ' + ip + ' — ошибка: ' + e.message.slice(0,50));
      }
    }

    // Итоговая статистика
    const uniqueFiles = linkTokens.size;
    const uniqueTokens = [...linkTokens.values()].reduce((a, b) => a + b, 0);
    const maxFile = Math.max(...linkTokens.values(), 0);
    const avgFile = uniqueFiles ? Math.round(uniqueTokens / uniqueFiles) : 0;

    console.log('\n📊 Статистика токенов:');
    console.log('   Строк обработано:     ' + processed);
    console.log('   Уникальных файлов:    ' + uniqueFiles);
    console.log('   Токенов (все строки): ' + totalTokens.toLocaleString());
    console.log('   Токенов (уник. файлы):' + uniqueTokens.toLocaleString());
    console.log('   Средний файл:         ~' + avgFile + ' токенов');
    console.log('   Самый большой файл:   ~' + maxFile + ' токенов');

    // Оценка стоимости (примерные цены)
    console.log('\n💰 Примерная оценка (вход, уникальные файлы):');
    console.log('   Qwen/Auchan:  зависит от тарифа Ашан');
    console.log('   Для справки ~' + uniqueTokens.toLocaleString() + ' input-токенов');

    // Предупреждение о больших файлах
    const bigFiles = results.filter(x => x.tokens > 8000);
    if (bigFiles.length) {
      console.log('\n⚠️  Файлы > 8000 токенов (могут не влезть в контекст):');
      const seen = new Set();
      for (const f of bigFiles) {
        if (seen.has(f.link)) continue;
        seen.add(f.link);
        console.log('   ~' + f.tokens + ' токенов: ' + f.link.slice(0, 50));
      }
    }

    // Записываем столбцы в TESTing: K=символы, L=токены
    // Заголовки
    if (!rows[0][10]) rows[0][10] = 'Символов в РФ';
    if (!rows[0][11]) rows[0][11] = 'Токенов (оценка)';
    for (const res of results) {
      rows[res.row][10] = res.chars;
      rows[res.row][11] = res.tokens;
    }

    if (!DRY_RUN) {
      // CSV-отчёт
      const csv = ['row,ip,chars,tokens,link']
        .concat(results.map(x => x.row + ',' + x.ip + ',' + x.chars + ',' + x.tokens + ',"' + x.link + '"'))
        .join('\n');
      fs.writeFileSync('token_report.csv', csv);
      console.log('\n📄 CSV-отчёт: token_report.csv');

      // Сохраняем xlsx с новыми столбцами
      const newSheet = XLSX.utils.aoa_to_sheet(rows);
      wb.Sheets[sheetName] = newSheet;
      const outBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      fs.writeFileSync('TESTing_tokens.xlsx', outBuffer);
      console.log('📄 Файл со столбцами символов/токенов: TESTing_tokens.xlsx');

      // Загрузка на Диск
      const uploadPath = TESTING_PATH.replace(/\.xlsx$/, '_tokens.xlsx');
      try {
        await uploadToDisk(uploadPath, outBuffer);
        console.log('📤 Загружено на Диск: ' + uploadPath);
      } catch (e) {
        console.log('⚠️  Не загружено на Диск: ' + e.message.slice(0,50));
      }
    }
    return;
  }

  for (let r = 1; r < rows.length && processed < LIMIT; r++) {
    const row  = rows[r];
    const ip   = String(row[COL.ip]   || '').trim();
    const link = String(row[COL.link] || '').trim();
    if (!ip) continue;
    processed++;

    if (!link) { console.log(`  [${r}] IP ${ip} — нет ссылки`); continue; }

    try {
      let rfBuf = rfCache.get(link);
      if (!rfBuf) { rfBuf = await downloadFile(link); rfCache.set(link, rfBuf); }

      // Прямой парсинг: DNS, ИС, SoluQiq
      const data = parseRfFile(rfBuf, ip);

      // LLM добирает: Ответственный, CODIR, + уточняет ИС/SoluQiq если пусто
      if (!NO_LLM) {
        const llm = await askLLM(ip, data.dns, data.rawHead, data.rawRaci);
        if (llm) {
          if (!data.is && llm.is)             data.is = llm.is;
          if (!data.solution && llm.solution) data.solution = llm.solution;
          if (!data.responsible && llm.responsible) data.responsible = llm.responsible;
          if (!data.codir && llm.codir)             data.codir = llm.codir;
          viaLLM++;
        }
      }

      // Записываем (только непустые)
      if (data.dns)         row[COL.dns]         = data.dns;
      if (data.is)          row[COL.is]          = data.is;
      if (data.solution)    row[COL.solution]    = data.solution;
      if (data.responsible) row[COL.responsible] = data.responsible;
      if (data.codir)       row[COL.codir]       = data.codir;

      if (data.dns || data.is || data.solution || data.responsible || data.codir) {
        filled++;
        console.log(`  [${r}] ✅ IP ${ip}`);
        console.log(`        C(DNS): ${(data.dns||'—').slice(0,30)}`);
        console.log(`        D(ИС):  ${(data.is||'—').slice(0,30)}`);
        console.log(`        E(Sol): ${(data.solution||'—').slice(0,30)}`);
        console.log(`        F(Отв): ${(data.responsible||'—').slice(0,30)}`);
        console.log(`        G(CDR): ${(data.codir||'—').slice(0,30)}`);
      } else {
        console.log(`  [${r}] ❌ IP ${ip} — ничего не извлечено`);
      }

    } catch (e) {
      errors++;
      console.log(`  [${r}] ⚠️  IP ${ip} — ${e.message.slice(0,60)}`);
    }
  }

  if (!DRY_RUN && filled > 0) {
    // Обновляем лист данными
    const newSheet = XLSX.utils.aoa_to_sheet(rows);
    // Сохраняем ширину столбцов и формат из оригинала если были
    if (wb.Sheets[sheetName]['!cols']) newSheet['!cols'] = wb.Sheets[sheetName]['!cols'];
    wb.Sheets[sheetName] = newSheet;

    // Генерируем буфер xlsx
    const outBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    // Локальная копия для бэкапа
    const localPath = path.join(process.cwd(), 'TESTing_filled.xlsx');
    fs.writeFileSync(localPath, outBuffer);
    console.log('\n💾 Локальная копия: ' + localPath);

    // Загружаем обратно на Яндекс Диск (перезапись исходного)
    console.log('📤 Загружаю на Яндекс Диск: ' + UPLOAD_PATH);
    let uploaded = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await uploadToDisk(UPLOAD_PATH, outBuffer);
        console.log('   ✅ Исходный файл TESTing.xlsx обновлён на Диске');
        uploaded = true;
        break;
      } catch (e) {
        const status = e.response && e.response.status;
        if (status === 423) {
          console.log('   🔒 Файл заблокирован (423) — попытка ' + attempt + '/3');
          console.log('      ЗАКРОЙТЕ TESTing.xlsx в Яндекс Диске/браузере!');
          if (attempt < 3) {
            console.log('      Жду 10 секунд...');
            await new Promise(r => setTimeout(r, 10000));
          }
        } else {
          console.log('   ⚠️  Ошибка загрузки: ' + e.message);
          break;
        }
      }
    }
    if (!uploaded) {
      console.log('\n   📁 Файл НЕ загружен на Диск. Варианты:');
      console.log('      1. Закройте TESTing.xlsx везде (браузер, приложение Диск, Excel)');
      console.log('      2. Запустите снова: node fill_testing.js');
      console.log('      ИЛИ загрузите вручную локальную копию:');
      console.log('      ' + localPath);
    }
  }

  console.log('\n✅ Итог: обработано ' + processed + ', заполнено ' + filled + ', через LLM ' + viaLLM + ', ошибок ' + errors);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
