'use strict';
/**
 * syncer.js — синхронизация всех источников данных в Obsidian vault
 *
 *  • IMAP почта (Яндекс) — инкрементально по UID
 *  • Яндекс Диск REST API — инкрементально по md5+modified
 *  • Яндекс Мессенджер Bot API — polling
 *  • Plaud транскрипции — из локальной папки
 */

'use strict';

const fs      = require('fs-extra');
const path    = require('path');
const crypto  = require('crypto');
const axios   = require('axios');
const cfg     = require('./config');

// ──────────────────────────────────────────────
//  УТИЛИТЫ
// ──────────────────────────────────────────────

function safeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 200);
}

function loadJson(filePath, def = {}) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { return def; }
}

function saveJson(filePath, data) {
  fs.ensureDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function dateStr(d) {
  if (!d) return 'unknown';
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 10);
}

// ──────────────────────────────────────────────
//  IMAP — ПОЧТА
// ──────────────────────────────────────────────

async function syncEmail(vaultPath, { onProgress } = {}) {
  const { ImapFlow }  = require('imapflow');
  const { simpleParser } = require('mailparser');

  if (!cfg.YANDEX_LOGIN || !cfg.YANDEX_PASSWORD) {
    console.warn('⚠️  YANDEX_LOGIN или YANDEX_PASSWORD не заданы');
    return { new: 0, errors: 0 };
  }

  const client = new ImapFlow({
    host:   'imap.yandex.ru',
    port:   993,
    secure: true,
    auth:   { user: cfg.YANDEX_LOGIN, pass: cfg.YANDEX_PASSWORD },
    logger: false,
  });

  const emailDir   = path.join(vaultPath, '01_Email');
  const stateFile  = path.join(emailDir, '.downloaded.json');
  const downloaded = loadJson(stateFile, {});

  let newCount = 0, errors = 0;

  await client.connect();
  const mailboxes = await client.list();

  for (const mb of mailboxes) {
    const mbName = mb.path;
    try {
      await client.mailboxOpen(mbName);
      const lock = await client.getMailboxLock(mbName);
      try {
        const seenUids = new Set(downloaded[mbName] || []);
        const messages = await client.search({ seen: false }, { uid: true });
        const newUids  = messages.filter(uid => !seenUids.has(uid));

        if (!newUids.length) continue;

        const mbFolder = path.join(emailDir, safeFilename(mbName));
        fs.ensureDirSync(mbFolder);

        for (const uid of newUids.slice(0, 50)) {
          try {
            const msg    = await client.fetchOne(uid, { source: true }, { uid: true });
            const parsed = await simpleParser(msg.source);
            const subject = parsed.subject || '(без темы)';
            const from    = parsed.from?.text || '';
            const date    = parsed.date ? dateStr(parsed.date) : dateStr(new Date());
            const body    = parsed.text || parsed.html?.replace(/<[^>]+>/g, '') || '';
            const fname   = `${date}_${safeFilename(subject).slice(0, 60)}.md`;

            // Автотеги — извлекаем entities из письма
      const bodyLower = body.toLowerCase();
      const autoTags  = [];
      const PROC_KW   = {
        'продажи':    ['продажа','заказ','клиент','счёт'],
        'закупки':    ['закупка','поставщик','тендер'],
        'hr':         ['найм','кандидат','отпуск','увольнение'],
        'финансы':    ['бюджет','оплата','счёт','платёж'],
        'it':         ['сервер','api','баг','деплой'],
        'ИБ':         ['безопасность','инцидент','пароль'],
      };
      for (const [tag, kws] of Object.entries(PROC_KW)) {
        if (kws.some(kw => bodyLower.includes(kw))) autoTags.push(tag);
      }
      // Определяем приоритет
      const isUrgent  = /срочно|urgent|critical|немедленно|asap/i.test(body);
      const priority  = isUrgent ? 'high' : 'normal';
      // Извлекаем упомянутых людей (имена с заглавной)
      const peopleRaw = (body + ' ' + subject).match(/[А-ЯA-Z][а-яёa-z]+\s+[А-ЯA-Z][а-яёa-z]+/g) || [];
      const people    = [...new Set(peopleRaw)].slice(0, 5).join(', ');

      const md = `---
type: email
subject: "${subject.replace(/"/g, "'")}"
from: "${from.replace(/"/g, "'")}"
date: ${date}
folder: "${mbName}"
source: imap
priority: ${priority}
tags: ${autoTags.join(', ')||'general'}
people: "${people}"
---

# ${subject}

**От:** ${from}
**Дата:** ${date}
**Папка:** ${mbName}
${isUrgent ? '\n⚡ СРОЧНО\n' : ''}
---

${body.slice(0, 10000)}
`;
            fs.writeFileSync(path.join(mbFolder, fname), md, 'utf8');
            seenUids.add(uid);
            newCount++;
            console.log(`   📧 Почта: +${newCount} — ${(subject||'').slice(0,40)}`);
            if (onProgress) await onProgress(newCount, subject);
          } catch (e) {
            errors++;
          }
        }
        downloaded[mbName] = [...seenUids];
      } finally {
        lock.release();
      }
    } catch (_) {}
  }

  await client.logout();
  saveJson(stateFile, downloaded);
  return { new: newCount, errors };
}

// ──────────────────────────────────────────────
//  ЯНДЕКС ДИСК
// ──────────────────────────────────────────────

async function syncDisk(vaultPath, { force = false, onProgress } = {}) {
  if (!cfg.YANDEX_DISK_TOKEN) {
    console.warn('⚠️  YANDEX_DISK_TOKEN не задан');
    return { new: 0, updated: 0, skipped: 0, errors: 0 };
  }

  const diskDir   = path.join(vaultPath, '03_YandexDisk');
  const stateFile = path.join(process.cwd(), '.disk_sync_state.json');
  const state     = force ? { files: {} } : loadJson(stateFile, { files: {} });

  const headers = { Authorization: `OAuth ${cfg.YANDEX_DISK_TOKEN}` };
  const stats   = { new: 0, updated: 0, skipped: 0, errors: 0 };

  const https   = require('https');
  const axInst  = axios.create({
    baseURL:    cfg.DISK_API,
    headers,
    timeout:    30000,
    httpsAgent: new https.Agent({ rejectUnauthorized: false, keepAlive: false }),
  });

  // Рекурсивный обход папок
  async function listAll(folder) {
    const files = [];
    const queue = [folder];
    while (queue.length) {
      const current = queue.shift();
      try {
        let offset = 0;
        while (true) {
          const { data } = await axInst.get('/resources', {
            params: { path: current, limit: 100, offset,
                      fields: 'name,path,type,size,modified,md5,_embedded' },
          });
          const items = data._embedded?.items || [];
          for (const item of items) {
            if (item.type === 'dir') queue.push(item.path);
            else if (isReadable(item.name) && (item.size || 0) <= cfg.MAX_FILE_MB * 1024 * 1024)
              files.push(item);
          }
          if (items.length < 100) break;
          offset += 100;
        }
      } catch (_) {}
    }
    return files;
  }

  const TEXT_EXT = new Set(['.txt','.md','.json','.csv','.html','.xml','.yaml','.yml']);
  const DOC_EXT  = new Set(['.docx','.pdf','.xlsx','.xls','.pptx']);

  function isReadable(name) {
    const ext = path.extname(name).toLowerCase();
    return TEXT_EXT.has(ext) || DOC_EXT.has(ext);
  }

  async function extractText(name, buffer) {
    const ext = path.extname(name).toLowerCase();
    if (TEXT_EXT.has(ext)) return buffer.toString('utf8');
    if (ext === '.docx') {
      try {
        const mammoth = require('mammoth');
        const { value } = await mammoth.extractRawText({ buffer });
        return value;
      } catch (_) { return '[docx: ошибка чтения]'; }
    }
    if (ext === '.pdf') {
      try {
        const pdfParse = require('pdf-parse');
        const data     = await pdfParse(buffer);
        return data.text;
      } catch (_) { return '[pdf: ошибка чтения]'; }
    }
    if (ext === '.xlsx' || ext === '.xls') {
      try {
        const XLSX  = require('xlsx');
        const wb    = XLSX.read(buffer, { type: 'buffer' });
        const parts = [];
        for (const sheetName of wb.SheetNames) {
          const ws  = wb.Sheets[sheetName];
          parts.push(`## ${sheetName}\n` + XLSX.utils.sheet_to_csv(ws));
        }
        return parts.join('\n\n');
      } catch (_) { return '[xlsx: ошибка чтения]'; }
    }
    return '[формат не поддерживается]';
  }

  console.log(`📂 Сканирую Яндекс Диск: ${cfg.DISK_ROOT}`);
  const allFiles = await listAll(cfg.DISK_ROOT);
  console.log(`   Найдено: ${allFiles.length} файлов`);

  for (let i = 0; i < allFiles.length; i++) {
    const item    = allFiles[i];
    const dpath   = item.path;
    const cached  = state.files[dpath] || {};

    // Проверяем изменился ли файл
    if (!force && cached.md5 && cached.md5 === item.md5 &&
        cached.modified === item.modified) {
      stats.skipped++;
      continue;
    }

    try {
      if (onProgress) onProgress(i + 1, allFiles.length, item.name);

      // Получаем ссылку на скачивание
      const { data: dlData } = await axInst.get('/resources/download', {
        params: { path: dpath },
      });
      if (onProgress) await onProgress(i + 1, allFiles.length, item.name);
      if ((i + 1) % 10 === 0 || i === 0)
        console.log(`   💾 Диск: ${i+1}/${allFiles.length} — ${item.name.slice(0,40)}`);

      const { data: fileBuffer } = await axios.get(dlData.href, {
        responseType: 'arraybuffer',
        timeout:      60000,
        httpsAgent:   new (require('https').Agent)({
          rejectUnauthorized: false,
          keepAlive:          false,
        }),
        maxRedirects: 5,
      });

      const text    = await extractText(item.name, Buffer.from(fileBuffer));
      const date    = dateStr(item.modified);
      const relPath = dpath.replace(/^\//, '').replace(/\//g, path.sep);
      const outPath = path.join(diskDir, relPath.replace(/\.[^.]+$/, '.md'));

      fs.ensureDirSync(path.dirname(outPath));

      const md = `---
type: disk_file
disk_path: "${dpath}"
original_name: "${item.name}"
date: ${date}
modified: "${item.modified}"
source: yandex_disk_api
---

# 💾 ${item.name}

**Путь:** \`${dpath}\`
**Изменён:** ${date}

---

${(text || '').slice(0, 50000)}
`;
      fs.writeFileSync(outPath, md, 'utf8');
      state.files[dpath] = { md5: item.md5, modified: item.modified, synced: new Date().toISOString() };
      cached.md5 ? stats.updated++ : stats.new++;
    } catch (e) {
      console.error(`   ❌ ${item.name}: ${e.message}`);
      stats.errors++;
    }

    // Сохраняем каждые 10 файлов
    if ((i + 1) % 10 === 0) saveJson(stateFile, state);
  }

  saveJson(stateFile, state);
  return stats;
}

// ──────────────────────────────────────────────
//  ЯНДЕКС МЕССЕНДЖЕР
// ──────────────────────────────────────────────

async function syncMessenger(vaultPath) {
  if (!cfg.YANDEX_BOT_TOKEN) {
    console.warn('⚠️  YANDEX_BOT_TOKEN не задан');
    return { new: 0 };
  }

  const messengerDir = path.join(vaultPath, '02_Messenger', 'Личные');
  const stateFile    = path.join(process.cwd(), '.messenger_state.json');
  const state        = loadJson(stateFile, { offset: 0 });

  fs.ensureDirSync(messengerDir);

  const BASE = 'https://botapi.messenger.yandex.net/bot/v1/messages';
  let newCount = 0;

  try {
    const { data } = await axios.get(`${BASE}/getUpdates/`, {
      headers: { Authorization: `OAuth ${cfg.YANDEX_BOT_TOKEN}` },
      params:  { limit: 100, offset: state.offset },
      timeout: 15000,
    });

    const updates = data.updates || [];
    for (const update of updates) {
      const msg  = update.message;
      if (!msg) continue;

      const sender   = msg.from?.display_name || msg.from?.login || 'Unknown';
      const text     = msg.text || msg.body || '';
      const ts       = msg.timestamp ? new Date(msg.timestamp * 1000) : new Date();
      const dateTime = ts.toISOString().replace('T', ' ').slice(0, 16);
      const date     = ts.toISOString().slice(0, 10);

      const chatFile = path.join(messengerDir, `${safeFilename(sender)}.md`);

      // Читаем существующий или создаём новый
      let content = '';
      if (fs.existsSync(chatFile)) {
        content = fs.readFileSync(chatFile, 'utf8');
        // Обновляем дату в frontmatter
        content = content.replace(/^date: .+/m, `date: ${date}`);
      } else {
        content = `---
type: messenger_chat
chat_type: private
chat_name: "${sender}"
source: yandex_messenger
date: ${date}
---

# 💬 ${sender}
`;
      }

      content += `\n**${sender}** \`${dateTime}\`\n> ${text}\n`;
      fs.writeFileSync(chatFile, content, 'utf8');
      newCount++;
    }

    if (updates.length > 0) {
      state.offset = updates[updates.length - 1].update_id + 1;
      saveJson(stateFile, state);
    }
  } catch (e) {
    console.error(`   ❌ Мессенджер: ${e.message}`);
  }

  return { new: newCount };
}

// ──────────────────────────────────────────────
//  PLAUD ТРАНСКРИПЦИИ
// ──────────────────────────────────────────────

async function syncPlaud(vaultPath, anthropicKey) {
  const plaudDir  = cfg.PLAUD_FOLDER;
  const vaultPlaud = path.join(vaultPath, '04_Plaud_Transcripts');
  const stateFile = path.join(vaultPlaud, '.processed.json');

  if (!fs.existsSync(plaudDir)) {
    console.warn(`⚠️  Папка Plaud не найдена: ${plaudDir}`);
    return { processed: 0 };
  }

  fs.ensureDirSync(vaultPlaud);
  const state = loadJson(stateFile, {});
  const files = fs.readdirSync(plaudDir).filter(f => f.endsWith('.txt'));
  let processed = 0;

  for (const file of files) {
    const fpath = path.join(plaudDir, file);
    const stat  = fs.statSync(fpath);
    const sig   = `${stat.size}_${stat.mtimeMs}`;
    if (state[file] === sig) continue;

    try {
      const text    = fs.readFileSync(fpath, 'utf8');
      const date    = dateStr(stat.mtime);
      const stem    = path.basename(file, '.txt');
      const outPath = path.join(vaultPlaud, `${safeFilename(stem)}.md`);

      let aiSummary = '';
      if (anthropicKey) {
        const Anthropic = require('@anthropic-ai/sdk');
        const client    = new Anthropic({ apiKey: anthropicKey });
        const resp      = await client.messages.create({
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 600,
          messages:   [{ role: 'user', content:
            `Выжимка из голосовой записи:\n${text.slice(0, 4000)}\n\n` +
            'О чём:\nКлючевые моменты:\n- ...\nЗадачи:\n- [ ] ...\nЛюди:' }],
        });
        aiSummary = resp.content[0].text;
      }

      const md = `---
type: voice_transcript
date: ${date}
source: plaud
---

# 🎙️ ${stem}

**Дата:** ${date}

## 🤖 AI Выжимка

${aiSummary || '_Выжимка не создана (нет ANTHROPIC_KEY)_'}

## 📝 Полная транскрипция

${text}
`;
      fs.writeFileSync(outPath, md, 'utf8');
      state[file] = sig;
      processed++;
    } catch (e) {
      console.error(`   ❌ Plaud ${file}: ${e.message}`);
    }
  }

  saveJson(stateFile, state);
  return { processed };
}

// ──────────────────────────────────────────────
//  ГЛАВНАЯ ФУНКЦИЯ — ПОЛНАЯ СИНХРОНИЗАЦИЯ
// ──────────────────────────────────────────────

async function syncAll(vaultPath, options = {}) {
  const { anthropicKey, diskForce } = options;
  console.log('\n🔄 Полная синхронизация...\n');

  const results = {};

  // Email
  console.log('📧 Синхронизирую почту...');
  try {
    results.email = await syncEmail(vaultPath, {});
    console.log(`   ✅ Новых писем: ${results.email.new}`);
  } catch (e) {
    console.error(`   ❌ Почта: ${e.message}`);
    results.email = { new: 0, errors: 1 };
  }

  // Диск
  console.log('💾 Синхронизирую Яндекс Диск...');
  try {
    results.disk = await syncDisk(vaultPath, { force: diskForce });
    console.log(`   ✅ Диск: +${results.disk.new} новых, ${results.disk.skipped} пропущено`);
  } catch (e) {
    console.error(`   ❌ Диск: ${e.message}`);
    results.disk = { new: 0, errors: 1 };
  }

  // Мессенджер
  console.log('💬 Синхронизирую мессенджер...');
  try {
    results.messenger = await syncMessenger(vaultPath);
    console.log(`   ✅ Новых сообщений: ${results.messenger.new}`);
  } catch (e) {
    console.error(`   ❌ Мессенджер: ${e.message}`);
    results.messenger = { new: 0 };
  }

  // Plaud
  console.log('🎙️ Синхронизирую Plaud...');
  try {
    results.plaud = await syncPlaud(vaultPath, anthropicKey);
    console.log(`   ✅ Обработано записей: ${results.plaud.processed}`);
  } catch (e) {
    console.error(`   ❌ Plaud: ${e.message}`);
    results.plaud = { processed: 0 };
  }

  console.log('\n✅ Синхронизация завершена\n');
  return results;
}

module.exports = { syncAll, syncEmail, syncDisk, syncMessenger, syncPlaud };

// CLI
if (require.main === module) {
  const args      = process.argv.slice(2);
  const diskForce = args.includes('--force');
  syncAll(cfg.VAULT_PATH, {
    anthropicKey: cfg.ANTHROPIC_KEY,
    diskForce,
  }).then(r => {
    console.log('Результат:', JSON.stringify(r, null, 2));
  }).catch(console.error);
}
