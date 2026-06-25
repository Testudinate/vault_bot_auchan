'use strict';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
/**
 * debug_rf.js — отладка: что в TESTing.xlsx и что по ссылке РФ
 * Запуск: node debug_rf.js
 */

const axios = require('axios');
const XLSX  = require('xlsx');
const cfg   = require('./config');

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
  const s = (linkOrPath || '').trim();
  if (!s) throw new Error('пустая ссылка');
  if (s.includes('disk.yandex.ru') || s.includes('yadi.sk')) {
    const clientMatch = s.match(/\/client\/disk(\/.+?)(?:\?|$)/);
    if (clientMatch) {
      const diskPath = decodeURIComponent(clientMatch[1]);
      console.log('      → приватный путь: ' + diskPath);
      return downloadFromDisk(diskPath);
    }
    console.log('      → публичная ссылка');
    return downloadFromPublicLink(s);
  }
  return downloadFromDisk(s.startsWith('/') ? s : '/' + s);
}

async function main() {
  console.log('📥 Скачиваю TESTing.xlsx\n');
  const buf = await downloadFile('/00_Project_IS/TESTing.xlsx');
  const wb  = XLSX.read(buf, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  // 1. Показываем заголовки TESTing
  console.log('═══ ЗАГОЛОВКИ TESTing.xlsx (строка 1) ═══');
  rows[0].forEach((cell, i) => {
    const colLetter = String.fromCharCode(65 + i);
    console.log(`   ${colLetter} [${i}]: "${cell}"`);
  });

  // 2. Показываем первую строку данных
  console.log('\n═══ ПЕРВАЯ СТРОКА ДАННЫХ (строка 2) ═══');
  rows[1].forEach((cell, i) => {
    const colLetter = String.fromCharCode(65 + i);
    console.log(`   ${colLetter} [${i}]: "${String(cell).slice(0,80)}"`);
  });

  // 3. Берём ссылку из столбца H первой строки данных
  const link = String(rows[1][7] || '').trim();
  console.log('\n═══ ССЫЛКА РФ (столбец H, строка 2) ═══');
  console.log('   "' + link + '"');

  if (!link) {
    console.log('   ⚠️  Ссылка пустая! Проверьте номер столбца H');
    return;
  }

  // 4. Пробуем скачать РФ-файл
  console.log('\n═══ СКАЧИВАНИЕ РФ-ФАЙЛА ═══');
  try {
    const rfBuf = await downloadFile(link);
    console.log('   ✅ Скачан, размер: ' + rfBuf.length + ' байт');

    // 5. Показываем структуру РФ-файла
    const rfWb = XLSX.read(rfBuf, { type: 'buffer' });
    console.log('\n═══ ЛИСТЫ РФ-ФАЙЛА ═══');
    console.log('   ' + rfWb.SheetNames.join(', '));

    for (const sheetName of rfWb.SheetNames.slice(0, 2)) {
      const rfSheet = rfWb.Sheets[sheetName];
      const rfRows  = XLSX.utils.sheet_to_json(rfSheet, { header: 1, defval: '' });
      console.log(`\n   ── Лист "${sheetName}" (${rfRows.length} строк) ──`);

      // Первые 15 строк
      for (let r = 0; r < Math.min(rfRows.length, 15); r++) {
        const preview = rfRows[r].map(c => String(c).slice(0, 25)).join(' | ');
        console.log(`   [${r}] ${preview.slice(0, 150)}`);
      }
    }

    // 6. Ищем IP первой строки в РФ-файле
    const targetIP = String(rows[1][1] || '').trim();
    console.log('\n═══ ПОИСК IP "' + targetIP + '" в РФ-файле ═══');
    let found = false;
    for (const sheetName of rfWb.SheetNames) {
      const rfRows = XLSX.utils.sheet_to_json(rfWb.Sheets[sheetName], { header: 1, defval: '' });
      for (let r = 0; r < rfRows.length; r++) {
        const rowText = rfRows[r].map(c => String(c)).join(' ');
        if (rowText.includes(targetIP)) {
          console.log(`   ✅ Найден на листе "${sheetName}", строка ${r}:`);
          console.log('   ' + rfRows[r].map((c,i) => `[${i}]"${String(c).slice(0,30)}"`).join(' '));
          found = true;
        }
      }
    }
    if (!found) {
      console.log('   ❌ IP "' + targetIP + '" НЕ найден в РФ-файле');
      console.log('   Возможно IP в другом формате или в другом файле');
    }

  } catch (e) {
    console.log('   ❌ Ошибка скачивания: ' + e.message);
    if (e.response) console.log('   HTTP ' + e.response.status + ': ' + JSON.stringify(e.response.data).slice(0,200));
  }
}

main().catch(e => { console.error('Fatal:', e.message); });
