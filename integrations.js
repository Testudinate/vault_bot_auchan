'use strict';
/**
 * integrations.js — Confluence и JIRA интеграции
 *
 * Confluence:
 *   - createPage(title, body, parentId?) — создать страницу
 *   - searchPages(query) — поиск страниц
 *   - getPage(pageId) — получить страницу
 *
 * JIRA:
 *   - logWork(issueKey, hours, comment, date?) — списать время
 *   - getIssue(issueKey) — получить задачу
 *   - searchIssues(jql) — поиск задач
 *   - getMyIssues() — мои задачи
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const axios = require('axios');
const cfg   = require('./config');

const agent = new (require('https').Agent)({
  rejectUnauthorized: false,
  keepAlive:          false,
});

// Экранирование пользовательского ввода для CQL/JQL (защита от инъекций):
// внутри строки в кавычках спецсимволы — обратный слеш и двойная кавычка.
function escCQL(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ──────────────────────────────────────────────
//  CONFLUENCE
// ──────────────────────────────────────────────

class Confluence {
  constructor() {
    if (!cfg.CONFLUENCE_URL || !cfg.CONFLUENCE_USER) {
      throw new Error('Укажите CONFLUENCE_URL, CONFLUENCE_USER, CONFLUENCE_PASSWORD в .env');
    }
    this.ax = axios.create({
      baseURL:    `${cfg.CONFLUENCE_URL.replace(/\/$/, '')}/rest/api`,
      auth:       { username: cfg.CONFLUENCE_USER, password: cfg.CONFLUENCE_PASSWORD },
      httpsAgent: agent,
      timeout:    30000,
      headers:    { 'Content-Type': 'application/json' },
    });
    this.defaultProject = cfg.JIRA_PROJECT || 'BITASK';
  }

  // Создать страницу в пространстве
  async createPage(title, content, parentId = null) {
    const body = {
      type:  'page',
      title,
      space: { key: cfg.CONFLUENCE_SPACE },
      body:  {
        storage: {
          value:          content,
          representation: 'storage', // Confluence XML storage format
        },
      },
    };

    if (parentId) {
      body.ancestors = [{ id: parentId }];
    }

    const { data } = await this.ax.post('/content', body);
    return {
      id:    data.id,
      title: data.title,
      url:   `${cfg.CONFLUENCE_URL}/pages/viewpage.action?pageId=${data.id}`,
    };
  }

  // Создать страницу из markdown (конвертируем в HTML)
  async createPageFromMarkdown(title, markdown, parentId = null) {
    // Простая конвертация markdown → HTML для Confluence
    const html = markdown
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm,  '<h2>$1</h2>')
      .replace(/^# (.+)$/gm,   '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g,    '<em>$1</em>')
      .replace(/`(.+?)`/g,      '<code>$1</code>')
      .replace(/^- (.+)$/gm,    '<li>$1</li>')
      .replace(/\n\n/g,         '</p><p>')
      .replace(/^(?!<[h|l|p|u])/gm, '');

    const storage = `<p>${html}</p>`;
    return this.createPage(title, storage, parentId);
  }

  // Поиск страниц
  async searchPages(query, limit = 10) {
    const { data } = await this.ax.get('/content/search', {
      params: {
        cql:    `space="${escCQL(cfg.CONFLUENCE_SPACE)}" AND text ~ "${escCQL(query)}"`,
        limit,
        expand: 'metadata.labels',
      },
    });
    return (data.results || []).map(p => ({
      id:      p.id,
      title:   p.title,
      url:     `${cfg.CONFLUENCE_URL}/pages/viewpage.action?pageId=${p.id}`,
      space:   p.space?.key,
      updated: p.version?.when?.slice(0, 10),
    }));
  }

  // Получить содержимое страницы
  async getPage(pageId) {
    const { data } = await this.ax.get(`/content/${pageId}`, {
      params: { expand: 'body.storage,version,space' },
    });
    return {
      id:      data.id,
      title:   data.title,
      url:     `${cfg.CONFLUENCE_URL}/pages/viewpage.action?pageId=${data.id}`,
      body:    data.body?.storage?.value || '',
      version: data.version?.number,
      updated: data.version?.when?.slice(0, 10),
    };
  }

  // Обновить страницу
  async updatePage(pageId, title, content, currentVersion) {
    const { data } = await this.ax.put(`/content/${pageId}`, {
      type:    'page',
      title,
      version: { number: currentVersion + 1 },
      body:    { storage: { value: content, representation: 'storage' } },
    });
    return {
      id:  data.id,
      url: `${cfg.CONFLUENCE_URL}/pages/viewpage.action?pageId=${data.id}`,
    };
  }

  // Получить дочерние страницы
  async getChildren(pageId) {
    const { data } = await this.ax.get(`/content/${pageId}/child/page`);
    return (data.results || []).map(p => ({
      id:    p.id,
      title: p.title,
      url:   `${cfg.CONFLUENCE_URL}/pages/viewpage.action?pageId=${p.id}`,
    }));
  }

  // Получить корневые страницы пространства
  async getSpacePages(limit = 20) {
    const { data } = await this.ax.get('/content', {
      params: {
        spaceKey: cfg.CONFLUENCE_SPACE,
        type:     'page',
        limit,
        expand:   'version',
      },
    });
    return (data.results || []).map(p => ({
      id:      p.id,
      title:   p.title,
      url:     `${cfg.CONFLUENCE_URL}/pages/viewpage.action?pageId=${p.id}`,
      updated: p.version?.when?.slice(0, 10),
    }));
  }
}

// ──────────────────────────────────────────────
//  JIRA
// ──────────────────────────────────────────────

class JIRA {
  constructor() {
    if (!cfg.JIRA_URL || !cfg.JIRA_USER) {
      throw new Error('Укажите JIRA_URL и JIRA_USER в .env');
    }
    this.ax = axios.create({
      baseURL:    `${cfg.JIRA_URL.replace(/\/$/, '')}/rest/api/2`,
      auth:       { username: cfg.JIRA_USER, password: cfg.JIRA_PASSWORD || cfg.JIRA_TOKEN },
      httpsAgent: agent,
      timeout:    30000,
      headers:    { 'Content-Type': 'application/json' },
    });
    this.defaultProject = cfg.JIRA_PROJECT || 'BITASK';
  }

  // Списать время на задачу
  async logWork(issueKey, hours, comment = '', date = null) {
    const seconds     = Math.round(hours * 3600);
    const started     = date
      ? new Date(date).toISOString().replace('Z', '+0000')
      : new Date().toISOString().replace('Z', '+0000');

    // Конвертируем часы в строку Jira формата
    const h   = Math.floor(hours);
    const m   = Math.round((hours - h) * 60);
    const ts  = h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
    const payload2 = { timeSpent: ts, comment };
    if (date) payload2.started = new Date(date).toISOString().replace('Z', '+0000');

    const { data } = await this.ax.post(`/issue/${issueKey}/worklog`, payload2);
    return {
      id:        data.id,
      issueKey,
      timeSpent: data.timeSpent || ts,
      hours,
      comment,
      date:      (date || new Date().toISOString()).slice(0, 10),
    };
  }

  // Получить задачу
  async getIssue(issueKey) {
    const { data } = await this.ax.get(`/issue/${issueKey}`, {
      params: { fields: 'summary,status,assignee,priority,timespent,timeestimate,worklog,description' },
    });
    const f = data.fields;
    return {
      key:         data.key,
      summary:     f.summary,
      status:      f.status?.name,
      assignee:    f.assignee?.displayName,
      priority:    f.priority?.name,
      timeSpent:   f.timespent ? Math.round(f.timespent / 3600) + 'h' : '0h',
      timeLeft:    f.timeestimate ? Math.round(f.timeestimate / 3600) + 'h' : '—',
      url:         `${cfg.JIRA_URL}/browse/${data.key}`,
    };
  }

  // Поиск задач по JQL
  async searchIssues(jql, maxResults = 10) {
    const { data } = await this.ax.post('/search', {
      jql,
      maxResults,
      fields: ['summary','status','assignee','priority','timespent','updated'],
    });
    return (data.issues || []).map(i => ({
      key:      i.key,
      summary:  i.fields.summary,
      status:   i.fields.status?.name,
      assignee: i.fields.assignee?.displayName,
      priority: i.fields.priority?.name,
      url:      `${cfg.JIRA_URL}/browse/${i.key}`,
    }));
  }

  // Мои задачи
  async getMyIssues(status = 'In Progress') {
    const jql = `assignee = currentUser() AND status = "${escCQL(status)}" ORDER BY updated DESC`;
    return this.searchIssues(jql, 15);
  }

  // Задачи проекта
  async getProjectIssues(project = null, status = null) {
    const proj = project || cfg.JIRA_PROJECT;
    let jql    = `project = "${escCQL(proj)}"`;
    if (status) jql += ` AND status = "${escCQL(status)}"`;
    jql += ' ORDER BY updated DESC';
    return this.searchIssues(jql, 15);
  }

  // История worklogs за период
  async getMyWorklogs(days = 7) {
    const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const jql  = `worklogAuthor = currentUser() AND worklogDate >= "${from}" ORDER BY updated DESC`;
    const issues = await this.searchIssues(jql, 20);

    // Для каждой задачи получаем worklogs
    const result = [];
    for (const issue of issues.slice(0, 10)) {
      try {
        const { data } = await this.ax.get(`/issue/${issue.key}/worklog`);
        const myLogs = (data.worklogs || []).filter(w =>
          w.author?.name === cfg.JIRA_USER ||
          w.author?.emailAddress === cfg.JIRA_USER
        );
        const totalH = myLogs.reduce((s, w) => s + (w.timeSpentSeconds || 0), 0) / 3600;
        if (totalH > 0) result.push({ ...issue, loggedHours: Math.round(totalH * 10) / 10 });
      } catch (_) {}
    }
    return result;
  }

  // Получить статусы проекта
  async getStatuses() {
    const { data } = await this.ax.get(`/project/${cfg.JIRA_PROJECT}/statuses`);
    return data.flatMap(t => t.statuses.map(s => s.name));
  }
}

// ──────────────────────────────────────────────
//  SINGLETON HELPERS
// ──────────────────────────────────────────────

let _confluence = null;
let _jira       = null;

function getConfluence() {
  if (!_confluence) _confluence = new Confluence();
  return _confluence;
}

function getJIRA() {
  if (!_jira) _jira = new JIRA();
  return _jira;
}

// ──────────────────────────────────────────────
//  УМНЫЕ КОМАНДЫ (для бота)
// ──────────────────────────────────────────────

// Создать страницу Confluence из RAG контекста
async function createConfluencePage(title, context, vaultIndex) {
  const confluence = getConfluence();

  // Ищем релевантные документы в vault
  const docs    = vaultIndex.search(title, { topK: 5 });
  const vaultCtx = docs.map((d, i) =>
    `**[${i+1}] ${d.title}** (${d.date || ''})\n${(d.body || '').slice(0, 300)}`
  ).join('\n\n---\n\n');

  // Формируем контент страницы
  const pageContent = `
<h1>${title}</h1>
<p><em>Создано автоматически ${new Date().toLocaleDateString('ru')}</em></p>
<h2>Контекст</h2>
<p>${context || 'Нет описания'}</p>
${vaultCtx ? `<h2>Связанные документы из базы знаний</h2><p>${vaultCtx.replace(/\n/g, '<br/>')}</p>` : ''}
`;

  return confluence.createPage(title, pageContent);
}

// Списать время с пониманием естественного языка
// "2 часа на BD-123 по встрече с командой"
function parseWorklog(text) {
  const result = { hours: null, issueKey: null, comment: '', date: null };

  // Часы
  const hoursMatch = text.match(/(\d+(?:[.,]\d+)?)\s*(?:час|ч\b|h\b)/i);
  if (hoursMatch) result.hours = parseFloat(hoursMatch[1].replace(',', '.'));

  // Ключ задачи (BITASK-123 или просто 123 → BITASK-123)
  const keyMatch = text.match(/([A-Z][A-Z0-9]+-\d+)/i);
  if (keyMatch) {
    result.issueKey = keyMatch[1].toUpperCase();
  } else {
    // Просто номер → добавляем префикс проекта
    const numMatch = text.match(/\b(\d{3,6})\b/);
    if (numMatch) result.issueKey = `BITASK-${numMatch[1]}`;
  }

  // Дата
  const dateMatch = text.match(/(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/);
  if (dateMatch) {
    const y = dateMatch[3] ? (dateMatch[3].length === 2 ? '20' + dateMatch[3] : dateMatch[3]) : new Date().getFullYear();
    result.date = `${y}-${dateMatch[2].padStart(2,'0')}-${dateMatch[1].padStart(2,'0')}`;
  }

  // Комментарий — всё остальное
  result.comment = text
    .replace(/\d+(?:[.,]\d+)?\s*(?:час|ч\b|h\b)/gi, '')
    .replace(/[A-Z][A-Z0-9]+-\d+/gi, '')
    .replace(/\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return result;
}

module.exports = {
  Confluence,
  JIRA,
  getConfluence,
  getJIRA,
  createConfluencePage,
  parseWorklog,
};
