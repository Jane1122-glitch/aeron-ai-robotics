import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const schema = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    brief TEXT NOT NULL DEFAULT '',
    keywords TEXT NOT NULL DEFAULT '[]',
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE RESTRICT,
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    excerpt TEXT NOT NULL,
    body TEXT NOT NULL,
    image_alt_text TEXT NOT NULL DEFAULT '',
    meta_description TEXT NOT NULL DEFAULT '',
    suggested_keywords TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'published')),
    generated_by TEXT NOT NULL,
    scheduled_at TEXT,
    published_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS automations (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL UNIQUE REFERENCES topics(id) ON DELETE CASCADE,
    cadence_days INTEGER NOT NULL CHECK (cadence_days BETWEEN 1 AND 365),
    publish_delay_hours INTEGER NOT NULL CHECK (publish_delay_hours BETWEEN 1 AND 720),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    next_run_at TEXT NOT NULL,
    last_run_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS automation_runs (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    article_id TEXT REFERENCES articles(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
    message TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS daily_blog_runs (
    run_date TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('running', 'partial', 'completed', 'failed')),
    topics_json TEXT NOT NULL DEFAULT '[]',
    attempts INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    next_retry_at TEXT,
    message TEXT NOT NULL DEFAULT ''
  ) STRICT;

  CREATE TABLE IF NOT EXISTS daily_blog_items (
    run_date TEXT NOT NULL REFERENCES daily_blog_runs(run_date) ON DELETE CASCADE,
    slot INTEGER NOT NULL CHECK (slot IN (1, 2)),
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE RESTRICT,
    article_id TEXT NOT NULL UNIQUE REFERENCES articles(id) ON DELETE RESTRICT,
    published_at TEXT NOT NULL,
    PRIMARY KEY (run_date, slot)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS articles_schedule_idx ON articles(status, scheduled_at);
  CREATE INDEX IF NOT EXISTS articles_topic_idx ON articles(topic_id, created_at);
  CREATE INDEX IF NOT EXISTS automations_due_idx ON automations(enabled, next_run_at);
`;

const parseTopic = (row) => row && ({ ...row, keywords: JSON.parse(row.keywords), active: Boolean(row.active) });
const parseArticle = (row) => row && ({ ...row, suggested_keywords: JSON.parse(row.suggested_keywords || '[]') });
const parseAutomation = (row) => row && ({ ...row, enabled: Boolean(row.enabled) });

export function createBlogDatabase(databasePath) {
  if (databasePath !== ':memory:') mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  const connection = new DatabaseSync(databasePath);
  connection.exec(schema);

  // Safely migrate existing SQLite files while preserving saved articles.
  const articleColumns = new Set(connection.prepare('PRAGMA table_info(articles)').all().map((column) => column.name));
  if (!articleColumns.has('meta_description')) connection.exec("ALTER TABLE articles ADD COLUMN meta_description TEXT NOT NULL DEFAULT ''");
  if (!articleColumns.has('suggested_keywords')) connection.exec("ALTER TABLE articles ADD COLUMN suggested_keywords TEXT NOT NULL DEFAULT '[]'");
  if (!articleColumns.has('image_alt_text')) connection.exec("ALTER TABLE articles ADD COLUMN image_alt_text TEXT NOT NULL DEFAULT ''");
  const dailyRunColumns = new Set(connection.prepare('PRAGMA table_info(daily_blog_runs)').all().map((column) => column.name));
  if (!dailyRunColumns.has('next_retry_at')) connection.exec('ALTER TABLE daily_blog_runs ADD COLUMN next_retry_at TEXT');

  const statements = {
    topicById: connection.prepare('SELECT * FROM topics WHERE id = ?'),
    topics: connection.prepare('SELECT * FROM topics ORDER BY created_at DESC'),
    articleById: connection.prepare('SELECT a.*, t.title AS category FROM articles a JOIN topics t ON t.id = a.topic_id WHERE a.id = ?'),
    articles: connection.prepare('SELECT a.*, t.title AS category FROM articles a JOIN topics t ON t.id = a.topic_id ORDER BY a.created_at DESC LIMIT ?'),
    publicArticles: connection.prepare("SELECT a.id, a.topic_id, t.title AS category, a.title, a.slug, a.excerpt, a.body, a.image_alt_text, a.meta_description, a.suggested_keywords, a.published_at FROM articles a JOIN topics t ON t.id = a.topic_id WHERE a.status = 'published' ORDER BY a.published_at DESC LIMIT ?"),
    automationById: connection.prepare('SELECT * FROM automations WHERE id = ?'),
    automations: connection.prepare('SELECT a.*, t.title AS topic_title FROM automations a JOIN topics t ON t.id = a.topic_id ORDER BY a.created_at DESC'),
  };

  return {
    connection,
    close: () => connection.close(),
    getTopic(id) { return parseTopic(statements.topicById.get(id)); },
    listTopics() { return statements.topics.all().map(parseTopic); },
    countTopicArticles(id) { return connection.prepare('SELECT COUNT(*) AS count FROM articles WHERE topic_id = ?').get(id).count; },
    createTopic(topic) {
      connection.prepare('INSERT INTO topics (id, title, brief, keywords, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(topic.id, topic.title, topic.brief, JSON.stringify(topic.keywords), Number(topic.active), topic.createdAt, topic.updatedAt);
      return this.getTopic(topic.id);
    },
    updateTopic(id, topic) {
      connection.prepare('UPDATE topics SET title = ?, brief = ?, keywords = ?, active = ?, updated_at = ? WHERE id = ?')
        .run(topic.title, topic.brief, JSON.stringify(topic.keywords), Number(topic.active), topic.updatedAt, id);
      return this.getTopic(id);
    },
    deleteTopic(id) { return connection.prepare('DELETE FROM topics WHERE id = ?').run(id).changes > 0; },
    getArticle(id) { return parseArticle(statements.articleById.get(id)); },
    getArticleBySlug(slug) { return parseArticle(connection.prepare("SELECT a.*, t.title AS category FROM articles a JOIN topics t ON t.id = a.topic_id WHERE a.slug = ? AND a.status = 'published'").get(slug)); },
    listPublicArticles(limit = 20) { return statements.publicArticles.all(limit).map(parseArticle); },
    listArticles({ status, topicId, limit = 50 } = {}) {
      const filters = [];
      const values = [];
      if (status) { filters.push('a.status = ?'); values.push(status); }
      if (topicId) { filters.push('a.topic_id = ?'); values.push(topicId); }
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      return connection.prepare(`SELECT a.*, t.title AS category FROM articles a JOIN topics t ON t.id = a.topic_id ${where} ORDER BY a.created_at DESC LIMIT ?`)
        .all(...values, limit).map(parseArticle);
    },
    createArticle(article) {
      connection.prepare(`INSERT INTO articles
        (id, topic_id, title, slug, excerpt, body, image_alt_text, meta_description, suggested_keywords, status, generated_by, scheduled_at, published_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        article.id, article.topicId, article.title, article.slug, article.excerpt, article.body,
        article.imageAltText || '', article.metaDescription || article.excerpt, JSON.stringify(article.suggestedKeywords || []), article.status,
        article.generatedBy, article.scheduledAt, article.publishedAt, article.createdAt, article.updatedAt,
      );
      return this.getArticle(article.id);
    },
    updateArticle(id, values) {
      connection.prepare('UPDATE articles SET title = ?, slug = ?, excerpt = ?, body = ?, image_alt_text = ?, meta_description = ?, suggested_keywords = ?, updated_at = ? WHERE id = ?')
        .run(values.title, values.slug, values.excerpt, values.body, values.imageAltText || '', values.metaDescription,
          JSON.stringify(values.suggestedKeywords), values.updatedAt, id);
      return this.getArticle(id);
    },
    scheduleArticle(id, scheduledAt, updatedAt) {
      const result = connection.prepare("UPDATE articles SET status = 'scheduled', scheduled_at = ?, published_at = NULL, updated_at = ? WHERE id = ? AND status IN ('draft', 'scheduled')")
        .run(scheduledAt, updatedAt, id);
      return result.changes ? this.getArticle(id) : null;
    },
    publishArticle(id, publishedAt) {
      const result = connection.prepare("UPDATE articles SET status = 'published', scheduled_at = NULL, published_at = ?, updated_at = ? WHERE id = ? AND status IN ('draft', 'scheduled')")
        .run(publishedAt, publishedAt, id);
      return result.changes ? this.getArticle(id) : null;
    },
    unscheduleArticle(id, updatedAt) {
      const result = connection.prepare("UPDATE articles SET status = 'draft', scheduled_at = NULL, updated_at = ? WHERE id = ? AND status = 'scheduled'")
        .run(updatedAt, id);
      return result.changes ? this.getArticle(id) : null;
    },
    deleteArticle(id) { return connection.prepare("DELETE FROM articles WHERE id = ? AND status = 'draft'").run(id).changes > 0; },
    getAutomation(id) { return parseAutomation(statements.automationById.get(id)); },
    listAutomations() { return statements.automations.all().map(parseAutomation); },
    createAutomation(automation) {
      connection.prepare(`INSERT INTO automations
        (id, topic_id, cadence_days, publish_delay_hours, enabled, next_run_at, last_run_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`).run(
        automation.id, automation.topicId, automation.cadenceDays, automation.publishDelayHours,
        Number(automation.enabled), automation.nextRunAt, automation.createdAt, automation.updatedAt,
      );
      return this.getAutomation(automation.id);
    },
    updateAutomation(id, automation) {
      connection.prepare(`UPDATE automations SET cadence_days = ?, publish_delay_hours = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?`)
        .run(automation.cadenceDays, automation.publishDelayHours, Number(automation.enabled), automation.nextRunAt, automation.updatedAt, id);
      return this.getAutomation(id);
    },
    deleteAutomation(id) { return connection.prepare('DELETE FROM automations WHERE id = ?').run(id).changes > 0; },
  };
}

