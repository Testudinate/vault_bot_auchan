'use strict';
/**
 * graph_rag.js — граф знаний (GraphRAG)
 *
 * Из семинара: "переход от свалки фрагментов к структуре:
 * какие сущности есть, как они связаны, какие документы относятся к каким объектам"
 *
 * Извлекает сущности и связи:
 *  - Люди (из писем, чатов)
 *  - Документы (файлы, письма)
 *  - Проекты/темы
 *  - Связи: автор→письмо, письмо→тема, человек→проект
 */

// Извлечение сущностей из документа
function extractEntities(doc) {
  const entities = { people: [], orgs: [], projects: [], topics: [] };
  const text = ((doc.subject || doc.title || '') + ' ' + (doc.body || '').slice(0, 2000));

  // Люди — паттерн "Имя Фамилия" (с заглавных)
  const people = text.match(/[А-ЯA-Z][а-яёa-z]+\s+[А-ЯA-Z][а-яёa-z]+/g) || [];
  entities.people = [...new Set(people)].slice(0, 10);

  // Email-адреса как идентификаторы людей
  const emails = text.match(/[\w._%+\-]+@[\w.\-]+\.[a-zA-Z]{2,}/g) || [];
  entities.emails = [...new Set(emails)].slice(0, 10);

  // Проекты/темы — ключевые слова
  const PROJECT_KW = ['bigdata','big data','ml','machine learning','airflow','spark',
    'kafka','hadoop','dashboard','дашборд','pipeline','платформа','проект',
    'миграция','внедрение','интеграция','аналитика','отчёт','модель'];
  const lower = text.toLowerCase();
  entities.projects = PROJECT_KW.filter(kw => lower.includes(kw));

  return entities;
}

/**
 * Построение графа знаний из всех документов
 */
class KnowledgeGraph {
  constructor(docs) {
    this.nodes = new Map();  // id -> {type, label, count}
    this.edges = new Map();  // "from→to" -> {type, count, docs:[]}
    this.build(docs);
  }

  _addNode(id, type, label) {
    if (!id) return;
    if (!this.nodes.has(id)) {
      this.nodes.set(id, { id, type, label: label || id, count: 0 });
    }
    this.nodes.get(id).count++;
  }

  _addEdge(from, to, type, docId) {
    if (!from || !to || from === to) return;
    const key = from + '→' + to;
    if (!this.edges.has(key)) {
      this.edges.set(key, { from, to, type, count: 0, docs: [] });
    }
    const e = this.edges.get(key);
    e.count++;
    if (docId && e.docs.length < 10) e.docs.push(docId);
  }

  build(docs) {
    for (const doc of docs) {
      const ent = extractEntities(doc);

      // Узел документа
      const docId = 'doc:' + (doc.id || doc.path || '').slice(0, 30);
      this._addNode(docId, 'document', (doc.title || '').slice(0, 40));

      // Автор письма → документ
      if (doc.from) {
        const author = (doc.from.match(/([\w._%+\-]+@[\w.\-]+)/)||[])[1] || doc.from.slice(0, 30);
        const authorId = 'person:' + author.toLowerCase();
        this._addNode(authorId, 'person', author);
        this._addEdge(authorId, docId, 'автор', doc.id);
      }

      // Люди упомянутые в документе
      for (const person of ent.people) {
        const pid = 'person:' + person.toLowerCase();
        this._addNode(pid, 'person', person);
        this._addEdge(pid, docId, 'упомянут', doc.id);
      }

      // Проекты/темы
      for (const proj of ent.projects) {
        const projId = 'project:' + proj.toLowerCase();
        this._addNode(projId, 'project', proj);
        this._addEdge(docId, projId, 'относится', doc.id);
      }
    }
  }

  // Найти связи для сущности
  getConnections(entityQuery) {
    const q = entityQuery.toLowerCase();
    const matched = [...this.nodes.values()].filter(n =>
      n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)
    );

    if (!matched.length) return null;

    const results = [];
    for (const node of matched.slice(0, 3)) {
      const connections = { node, related: [] };
      for (const edge of this.edges.values()) {
        if (edge.from === node.id) {
          const target = this.nodes.get(edge.to);
          if (target) connections.related.push({ rel: edge.type, node: target, count: edge.count });
        } else if (edge.to === node.id) {
          const source = this.nodes.get(edge.from);
          if (source) connections.related.push({ rel: edge.type + ' (входящая)', node: source, count: edge.count });
        }
      }
      connections.related.sort((a, b) => b.count - a.count);
      results.push(connections);
    }
    return results;
  }

  // Статистика графа
  stats() {
    const byType = {};
    for (const n of this.nodes.values())
      byType[n.type] = (byType[n.type] || 0) + 1;
    return {
      nodes: this.nodes.size,
      edges: this.edges.size,
      byType,
    };
  }

  // Топ сущностей по связям
  topEntities(type, limit = 10) {
    return [...this.nodes.values()]
      .filter(n => !type || n.type === type)
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }
}

// Форматирование связей для ответа
function formatConnections(connections) {
  if (!connections || !connections.length) return 'Связи не найдены в графе знаний.';

  const lines = ['🕸️ Граф знаний\n'];
  const icons = { person: '👤', document: '📄', project: '📁', org: '🏢' };

  for (const conn of connections) {
    const icon = icons[conn.node.type] || '•';
    lines.push(icon + ' ' + conn.node.label + ' (упоминаний: ' + conn.node.count + ')');

    const grouped = {};
    for (const r of conn.related.slice(0, 12)) {
      if (!grouped[r.rel]) grouped[r.rel] = [];
      grouped[r.rel].push(r.node.label);
    }

    for (const [rel, items] of Object.entries(grouped)) {
      lines.push('   ' + rel + ': ' + items.slice(0, 5).join(', '));
    }
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = { KnowledgeGraph, extractEntities, formatConnections };
