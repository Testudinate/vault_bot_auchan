'use strict';
/**
 * mark_visibility.js — авто-разметка заметок по уровням доступа
 *
 * Правила:
 *   private  — письма, голосовые, личные чаты (дефолт)
 *   team     — файлы с диска с рабочими темами, групповые чаты
 *   public   — Confluence, технические документы, инструкции
 *
 * Запуск:
 *   node mark_visibility.js --dry-run   (посмотреть без изменений)
 *   node mark_visibility.js             (применить)
 *   node mark_visibility.js --public ObsidianVault/03_YandexDisk/docs/
 */

const fs   = require('fs');
const path = require('path');
const cfg  = require('./config');

const DRY_RUN   = process.argv.includes('--dry-run');
const FORCE_PUB = process.argv.find(a => a.startsWith('--public'));

// ── Правила определения visibility ──
const VISIBILITY_RULES = [

  // PRIVATE — всегда приватное
  { match: (meta, body, relPath) =>
      relPath.startsWith('01_Email') ||
      meta.type === 'email',
    visibility: 'private',
    reason: 'Письма всегда приватные' },

  { match: (meta) => meta.type === 'voice_transcript' || meta.type === 'plaud_digest',
    visibility: 'private',
    reason: 'Голосовые записи приватные' },

  { match: (meta, body, relPath) =>
      relPath.includes('02_Messenger') && relPath.includes('Личные'),
    visibility: 'private',
    reason: 'Личные чаты приватные' },

  { match: (meta, body) => {
      const text = (body || '').toLowerCase();
      return /зарплат|оклад|премия|уволь|конфликт|личн|интим|медицин|паспорт|снилс/i.test(text);
    },
    visibility: 'private',
    reason: 'Содержит приватные данные' },

  // TEAM — для команды BigData
  { match: (meta, body, relPath) =>
      relPath.includes('02_Messenger') && relPath.includes('Групп'),
    visibility: 'team',
    reason: 'Групповые чаты для команды' },

  { match: (meta, body) => {
      const text = ((meta.subject || '') + ' ' + (body || '')).toLowerCase();
      return /bigdata|big data|ml|machine learning|airflow|spark|kafka|hadoop|python|jupyter|дашборд|dashboard|метрик|pipeline/i.test(text);
    },
    visibility: 'team',
    reason: 'Технический контент команды' },

  // ВСЕ файлы с диска — team по умолчанию
  { match: (meta, body, relPath) =>
      relPath.startsWith('03_YandexDisk') ||
      meta.type === 'disk_file',
    visibility: 'team',
    reason: 'Файлы с Яндекс Диска — командные' },

  // PUBLIC — открытые знания
  { match: (meta, body, relPath) =>
      relPath.startsWith('03_YandexDisk') &&
      /инструкц|readme|guide|howto|как|туториал|tutorial|документац/i.test(
        (meta.title || '') + ' ' + relPath
      ),
    visibility: 'public',
    reason: 'Инструкции и документация' },

  { match: (meta) => meta.type === 'section_index' || meta.type === 'moc',
    visibility: 'public',
    reason: 'Индексные страницы' },
];

// Дефолт по типу документа
const TYPE_DEFAULT = {
  email:            'private',   // письма всегда приватные
  voice_transcript: 'private',   // голосовые приватные
  plaud_digest:     'private',   // дайджесты приватные
  messenger_chat:   'team',      // чаты для команды
  disk_file:        'team',      // файлы с диска для команды
  contact:          'team',      // контакты для команды
  section_index:    'public',    // индексы публичные
  moc:              'public',    // карты публичные
};

function determineVisibility(meta, body, relPath) {
  // Явно указано — не меняем
  if (meta.visibility) return { visibility: meta.visibility, reason: 'уже размечено' };

  // Проходим правила по порядку
  for (const rule of VISIBILITY_RULES) {
    if (rule.match(meta, body, relPath)) {
      return { visibility: rule.visibility, reason: rule.reason };
    }
  }

  // Дефолт по типу
  const def = TYPE_DEFAULT[meta.type] || 'private';
  return { visibility: def, reason: 'дефолт для типа ' + (meta.type || 'unknown') };
}

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
    const val = String(v).includes(':') || String(v).includes('"')
      ? '"' + String(v).replace(/"/g, "'") + '"'
      : String(v);
    lines.push(k + ': ' + val);
  }
  lines.push('---');
  return lines.join('\n');
}

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

async function main() {
  const vaultPath = cfg.VAULT_PATH || './ObsidianVault';
  console.log('\n🏷️  Авто-разметка visibility: ' + vaultPath);
  console.log(DRY_RUN ? '   ⚠️  DRY-RUN — файлы не изменяются\n' : '\n');

  const files = findMd(vaultPath);
  console.log('Найдено файлов: ' + files.length + '\n');

  const stats = { private: 0, team: 0, public: 0, skip: 0, error: 0 };
  const examples = { private: [], team: [], public: [] };

  for (const fpath of files) {
    try {
      const raw     = fs.readFileSync(fpath, 'utf8');
      const relPath = path.relative(vaultPath, fpath);
      const { meta, body, hasFM } = parseFrontmatter(raw);

      if (!hasFM) { stats.skip++; continue; }

      const { visibility, reason } = determineVisibility(meta, body, relPath);

      if (meta.visibility === visibility) { stats.skip++; continue; }

      // Обновляем метаданные
      const newMeta = { ...meta, visibility };
      const newContent = buildFrontmatter(newMeta) + '\n\n' + body;

      if (!DRY_RUN) {
        fs.writeFileSync(fpath, newContent, 'utf8');
      }

      stats[visibility]++;
      if (examples[visibility] && examples[visibility].length < 3) {
        examples[visibility].push({ file: relPath.slice(0, 60), reason });
      }

    } catch (e) {
      stats.error++;
    }
  }

  // Итог
  console.log('✅ Результат разметки:');
  console.log('   🔴 private: ' + stats.private + ' файлов (только вы)');
  console.log('   🟡 team:    ' + stats.team    + ' файлов (команда BigData)');
  console.log('   🟢 public:  ' + stats.public  + ' файлов (все коллеги)');
  console.log('   ⏭️  пропущено: ' + stats.skip);
  if (stats.error) console.log('   ❌ ошибок: ' + stats.error);

  console.log('\n📋 Примеры:');
  for (const [vis, list] of Object.entries(examples)) {
    if (!list.length) continue;
    const icon = { private:'🔴', team:'🟡', public:'🟢' }[vis];
    for (const ex of list)
      console.log('   ' + icon + ' ' + ex.file + '\n      причина: ' + ex.reason);
  }

  console.log('\n📌 Следующий шаг: node enrich_vault.js && node bot.js');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
