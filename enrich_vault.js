'use strict';
/**
 * enrich_vault.js — обогащение метаданных существующих заметок в vault
 *
 * Что делает:
 * 1. Проходит по всем .md файлам
 * 2. Добавляет автотеги (тема письма)
 * 3. Извлекает людей из текста
 * 4. Ставит приоритет (срочно/обычно)
 * 5. Пересоздаёт векторный индекс
 *
 * Запуск: node enrich_vault.js
 * Тест:   node enrich_vault.js --dry-run  (не изменяет файлы)
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const fs   = require('fs');
const path = require('path');
const cfg  = require('./config');

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT   = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '9999');

// ── Теги по ключевым словам ──
const PROC_KW = {
  'продажи':     ['продажа','заказ','клиент','счёт','сделка','offer','sale','order'],
  'закупки':     ['закупка','поставщик','тендер','контракт','vendor','supply'],
  'hr':          ['найм','кандидат','отпуск','увольнение','hr','вакансия','сотрудник'],
  'финансы':     ['бюджет','оплата','счёт','платёж','invoice','budget','payment'],
  'it':          ['сервер','база','api','баг','деплой','система','software','код'],
  'иб':          ['безопасность','инцидент','пароль','security','breach','утечка'],
  'юридические': ['договор','нда','nda','юрист','legal','суд','претензия','соглашение'],
};

// ── Парсинг frontmatter ──
function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { meta: {}, body: text, hasFM: false };
  const end = text.indexOf('---', 3);
  if (end < 0) return { meta: {}, body: text, hasFM: false };
  const fm = text.slice(3, end);
  const meta = {};
  for (const line of fm.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const k = line.slice(0, colon).trim();
    const v = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
    if (k) meta[k] = v;
  }
  return { meta, body: text.slice(end + 3).trim(), hasFM: true };
}

function buildFrontmatter(meta) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    // Экранируем значения с кавычками
    const val = String(v).includes(':') || String(v).includes('"')
      ? `"${String(v).replace(/"/g, "'")}"`
      : String(v);
    lines.push(`${k}: ${val}`);
  }
  lines.push('---');
  return lines.join('\n');
}

// ── Обогащение метаданных ──
function enrichMeta(meta, body) {
  const enriched = { ...meta };
  const text     = (meta.subject || '') + ' ' + body.slice(0, 2000);
  const textLow  = text.toLowerCase();
  const changed  = [];

  // 1. Автотеги
  if (!meta.tags || meta.tags === 'general') {
    const tags = [];
    for (const [tag, kws] of Object.entries(PROC_KW)) {
      if (kws.some(kw => textLow.includes(kw))) tags.push(tag);
    }
    if (tags.length > 0) {
      enriched.tags = tags.join(', ');
      changed.push('tags: ' + enriched.tags);
    }
  }

  // 2. Приоритет
  if (!meta.priority) {
    const isUrgent = /срочно|urgent|critical|немедленно|asap|важно|важн/i.test(text);
    enriched.priority = isUrgent ? 'high' : 'normal';
    if (isUrgent) changed.push('priority: high');
  }

  // 3. Извлечение людей
  if (!meta.people) {
    const peopleRaw = text.match(/[А-ЯA-Z][а-яёa-z]+\s+[А-ЯA-Z][а-яёa-z]+/g) || [];
    const people    = [...new Set(peopleRaw)].slice(0, 5).join(', ');
    if (people) {
      enriched.people = people;
      changed.push('people: ' + people.slice(0, 50));
    }
  }

  // 4. Язык контента
  if (!meta.language) {
    const cyrCount = (text.match(/[а-яёА-ЯЁ]/g) || []).length;
    const latCount = (text.match(/[a-zA-Z]/g) || []).length;
    enriched.language = cyrCount > latCount ? 'ru' : 'en';
  }

  return { enriched, changed };
}

// ── Рекурсивный поиск .md файлов ──
function findMd(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.'))
      findMd(full, results);
    else if (entry.isFile() && entry.name.endsWith('.md'))
      results.push(full);
  }
  return results;
}

// ── MAIN ──
async function main() {
  const vaultPath = cfg.VAULT_PATH || './ObsidianVault';
  console.log(`\n🔄 Обогащение метаданных vault: ${vaultPath}`);
  console.log(DRY_RUN ? '   ⚠️  DRY-RUN режим — файлы не изменяются\n' : '');

  const files   = findMd(vaultPath).slice(0, LIMIT);
  console.log(`   Найдено файлов: ${files.length}\n`);

  let processed = 0, enriched = 0, skipped = 0, errors = 0;
  const enrichedFiles = [];

  for (const fpath of files) {
    try {
      const raw = fs.readFileSync(fpath, 'utf8');
      const { meta, body, hasFM } = parseFrontmatter(raw);

      if (!hasFM) { skipped++; continue; }

      const { enriched: newMeta, changed } = enrichMeta(meta, body);

      if (changed.length === 0) { skipped++; processed++; continue; }

      // Записываем обновлённый файл
      const newContent = buildFrontmatter(newMeta) + '\n\n' + body;

      if (!DRY_RUN) {
        fs.writeFileSync(fpath, newContent, 'utf8');
      }

      enriched++;
      processed++;
      enrichedFiles.push({
        file: path.relative(vaultPath, fpath),
        changes: changed,
      });

      if (enriched % 100 === 0)
        console.log(`   ✏️  Обогащено: ${enriched}/${files.length}`);

    } catch (e) {
      errors++;
      console.error(`   ❌ ${path.basename(fpath)}: ${e.message}`);
    }
  }

  // Итог
  console.log('\n✅ Результат обогащения:');
  console.log(`   Обработано:  ${processed}`);
  console.log(`   Обогащено:   ${enriched}`);
  console.log(`   Без изменений: ${skipped}`);
  console.log(`   Ошибок:      ${errors}`);

  // Показываем примеры
  if (enrichedFiles.length > 0) {
    console.log('\n📋 Примеры изменений (первые 5):');
    for (const f of enrichedFiles.slice(0, 5)) {
      console.log(`   ${f.file}`);
      for (const c of f.changes) console.log(`     + ${c}`);
    }
  }

  if (!DRY_RUN && enriched > 0) {
    console.log('\n🔄 Пересоздаю векторный индекс...');
    try {
      // Удаляем старый индекс
      const vectraPath = '.vectra_index';
      if (fs.existsSync(vectraPath)) {
        fs.rmSync(vectraPath, { recursive: true });
        console.log('   ✅ Старый индекс удалён');
      }
      console.log('   ℹ️  Запустите node bot.js — индекс пересоздастся автоматически');
    } catch (e) {
      console.error('   ❌ Ошибка удаления индекса:', e.message);
    }
  }

  console.log('\nГотово! Следующие шаги:');
  console.log('  1. node bot.js              — запустить бота (индекс пересоздастся)');
  console.log('  2. /refresh                 — переиндексировать в боте');
  console.log('  3. /search продажи          — проверить что теги работают\n');
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
