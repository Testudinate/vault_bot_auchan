#!/usr/bin/env node
'use strict';
/**
 * visibility_manager.js — управление видимостью папок vault
 *
 * Использование:
 *   node visibility_manager.js list              — показать все папки
 *   node visibility_manager.js set <папка> <уровень>  — изменить папку
 *   node visibility_manager.js disk team         — все папки диска → team
 *   node visibility_manager.js email private     — все письма → private
 *   node visibility_manager.js apply             — применить к файлам
 *   node visibility_manager.js stats             — итог по уровням
 *   node visibility_manager.js auto              — авто-настройка (рекомендуется)
 */

const fs   = require('fs');
const path = require('path');
const cfg  = require('./config');

const VAULT_PATH    = cfg.VAULT_PATH || './ObsidianVault';
const SETTINGS_FILE = '.visibility_settings.json';

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch (_) { return { folders: {} }; }
}
function saveSettings(s) {
  s.lastUpdated = new Date().toISOString();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
  console.log('💾 Сохранено в ' + SETTINGS_FILE);
}

function getFolders() {
  const folders = {};
  function scan(dir, depth) {
    if (depth > 3) return;
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const mdCount = entries.filter(function(e) { return e.isFile() && e.name.endsWith('.md'); }).length;
    const rel = path.relative(VAULT_PATH, dir);
    if (rel && mdCount > 0) folders[rel] = mdCount;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.'))
        scan(path.join(dir, e.name), depth + 1);
    }
  }
  scan(VAULT_PATH, 0);
  return folders;
}

function applyToFolder(folderRel, visibility) {
  const folderPath = path.join(VAULT_PATH, folderRel);
  if (!fs.existsSync(folderPath)) return 0;
  let count = 0;
  const files = fs.readdirSync(folderPath).filter(function(f) { return f.endsWith('.md'); });
  for (const file of files) {
    const fpath = path.join(folderPath, file);
    try {
      let content = fs.readFileSync(fpath, 'utf8');
      if (!content.startsWith('---')) continue;
      const end = content.indexOf('---', 3);
      if (end < 0) continue;
      if (content.slice(0, end).includes('\nvisibility:')) {
        content = content.replace(/\nvisibility:[^\n]*/, '\nvisibility: ' + visibility);
      } else {
        content = content.slice(0, end) + '\nvisibility: ' + visibility + '\n' + content.slice(end);
      }
      fs.writeFileSync(fpath, content, 'utf8');
      count++;
    } catch (_) {}
  }
  return count;
}

const ICONS = { private: '🔴', team: '🟡', public: '🟢' };
const args  = process.argv.slice(2);
const cmd   = args[0] || 'help';

const settings = loadSettings();
const folders  = getFolders();

if (cmd === 'list') {
  console.log('\nПапки vault:\n');
  const sorted = Object.entries(folders).sort(function(a,b) { return a[0].localeCompare(b[0]); });
  for (const [rel, count] of sorted) {
    const vis  = settings.folders[rel] || '—';
    const icon = ICONS[vis] || '⬜';
    const pad  = rel.padEnd(50);
    console.log('  ' + icon + ' ' + pad + ' (' + count + ' файлов)  ' + vis);
  }
  console.log('\nВсего папок: ' + sorted.length);
}

else if (cmd === 'set') {
  const folder = args[1];
  const vis    = args[2];
  if (!folder || !vis) {
    console.log('Использование: node visibility_manager.js set <папка> <private|team|public>');
    console.log('Пример: node visibility_manager.js set "03_YandexDisk/docs" team');
    process.exit(1);
  }
  if (!['private','team','public'].includes(vis)) {
    console.log('Уровень должен быть: private, team или public');
    process.exit(1);
  }
  // Ищем папку (частичное совпадение)
  const matches = Object.keys(folders).filter(function(f) {
    return f.toLowerCase().includes(folder.toLowerCase());
  });
  if (!matches.length) {
    console.log('Папка не найдена: ' + folder);
    console.log('Запустите list чтобы увидеть все папки');
    process.exit(1);
  }
  for (const m of matches) {
    settings.folders[m] = vis;
    console.log('  ' + ICONS[vis] + ' ' + m + ' → ' + vis);
  }
  saveSettings(settings);
  console.log('\nДля применения к файлам запустите: node visibility_manager.js apply');
}

else if (cmd === 'disk') {
  const vis = args[1] || 'team';
  let changed = 0;
  for (const rel of Object.keys(folders)) {
    if (rel.startsWith('03_YandexDisk') || rel.toLowerCase().includes('disk')) {
      settings.folders[rel] = vis;
      console.log('  ' + ICONS[vis] + ' ' + rel + ' → ' + vis);
      changed++;
    }
  }
  saveSettings(settings);
  console.log('\n✅ ' + changed + ' папок диска → ' + vis);
  console.log('Для применения: node visibility_manager.js apply');
}

else if (cmd === 'email') {
  const vis = args[1] || 'private';
  let changed = 0;
  for (const rel of Object.keys(folders)) {
    if (rel.startsWith('01_Email') || rel.toLowerCase().includes('email')) {
      settings.folders[rel] = vis;
      changed++;
    }
  }
  saveSettings(settings);
  console.log('✅ ' + changed + ' папок писем → ' + vis);
  console.log('Для применения: node visibility_manager.js apply');
}

else if (cmd === 'apply') {
  console.log('\nПрименяю настройки к файлам...\n');
  let totalUpdated = 0;
  const entries = Object.entries(settings.folders);
  if (!entries.length) {
    console.log('Нет сохранённых настроек. Сначала задайте уровни.');
    process.exit(0);
  }
  for (const [rel, vis] of entries) {
    const count = applyToFolder(rel, vis);
    if (count > 0) {
      console.log('  ' + ICONS[vis] + ' ' + rel.padEnd(50) + ' ' + count + ' файлов');
      totalUpdated += count;
    }
  }
  console.log('\n✅ Обновлено: ' + totalUpdated + ' файлов');
  console.log('ℹ️  Перезапустите бота или напишите /refresh');
}

else if (cmd === 'stats') {
  const counts = { private: 0, team: 0, public: 0, none: 0 };
  let total = 0;
  for (const [rel, count] of Object.entries(folders)) {
    const vis = settings.folders[rel] || 'none';
    counts[vis] = (counts[vis] || 0) + count;
    total += count;
  }
  console.log('\nИтог по уровням доступа:');
  console.log('  🔴 private:   ' + counts.private  + ' файлов — только вы');
  console.log('  🟡 team:      ' + counts.team     + ' файлов — команда BigData');
  console.log('  🟢 public:    ' + counts.public   + ' файлов — все коллеги');
  console.log('  ⬜ без метки: ' + counts.none     + ' файлов');
  console.log('  Всего:        ' + total);
}

else if (cmd === 'auto') {
  // Авто-настройка рекомендуемая
  console.log('\n🔄 Авто-настройка visibility...\n');
  let changed = 0;

  for (const rel of Object.keys(folders)) {
    let vis = null;

    // Письма → private
    if (rel.startsWith('01_Email') || rel.toLowerCase().includes('inbox'))
      vis = 'private';

    // Диск → team
    else if (rel.startsWith('03_YandexDisk'))
      vis = 'team';

    // Мессенджер личные → private, группы → team
    else if (rel.includes('Личные'))
      vis = 'private';
    else if (rel.includes('Групп'))
      vis = 'team';

    // Голосовые → private
    else if (rel.startsWith('04_Plaud') || rel.toLowerCase().includes('plaud'))
      vis = 'private';

    // Контакты → team
    else if (rel.toLowerCase().includes('contact'))
      vis = 'team';

    // Остальное → team
    else
      vis = 'team';

    if (vis) {
      settings.folders[rel] = vis;
      console.log('  ' + ICONS[vis] + ' ' + rel);
      changed++;
    }
  }

  saveSettings(settings);
  console.log('\n✅ Настроено ' + changed + ' папок');
  console.log('\nПрименить к файлам? Запустите:');
  console.log('  node visibility_manager.js apply');
}

else {
  console.log('\nВозможности:');
  console.log('  node visibility_manager.js list              — показать все папки и уровни');
  console.log('  node visibility_manager.js set <папка> <уровень>  — изменить папку');
  console.log('  node visibility_manager.js disk team         — все папки диска → team');
  console.log('  node visibility_manager.js email private     — все письма → private');
  console.log('  node visibility_manager.js stats             — итог по уровням');
  console.log('  node visibility_manager.js apply             — применить к файлам vault');
  console.log('  node visibility_manager.js auto              — авто-настройка (рекомендуется)');
  console.log('\nПример быстрого старта:');
  console.log('  node visibility_manager.js auto');
  console.log('  node visibility_manager.js list');
  console.log('  node visibility_manager.js set "03_YandexDisk/docs" public');
  console.log('  node visibility_manager.js apply');
}
