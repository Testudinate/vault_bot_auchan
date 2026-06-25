'use strict';
const fs   = require('fs');
const path = require('path');
const cfg  = require('./config');
const vault = cfg.VAULT_PATH || './ObsidianVault';

function findMd(dir, res) {
  if (!res) res = [];
  if (!fs.existsSync(dir)) return res;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const f = path.join(dir, e.name);
    if (e.isDirectory() && e.name[0] !== '.') findMd(f, res);
    else if (e.isFile() && e.name.endsWith('.md')) res.push(f);
  }
  return res;
}

const files = findMd(vault);
const stats = { private: 0, team: 0, public: 0, none: 0 };
const examples = { public: [], team: [] };

for (const f of files) {
  const content = fs.readFileSync(f, 'utf8');
  const m = content.match(/\nvisibility:\s*(\w+)/);
  const v = m ? m[1] : 'none';
  stats[v] = (stats[v] || 0) + 1;
  if ((v === 'public' || v === 'team') && examples[v].length < 3) {
    examples[v].push(path.relative(vault, f));
  }
}

console.log('\nСтатистика visibility:');
console.log('  private: ' + stats.private);
console.log('  team:    ' + stats.team);
console.log('  public:  ' + stats.public);
console.log('  none:    ' + stats.none);
console.log('  ВСЕГО:   ' + files.length);

console.log('\nПримеры public файлов:');
if (examples.public.length) {
  for (const f of examples.public) console.log('  ' + f);
} else {
  console.log('  НЕТ public файлов!');
}

console.log('\nПримеры team файлов:');
if (examples.team.length) {
  for (const f of examples.team) console.log('  ' + f);
} else {
  console.log('  НЕТ team файлов!');
}
