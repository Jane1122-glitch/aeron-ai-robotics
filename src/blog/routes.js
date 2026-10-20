import { randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { BlogProviderError } from './providers/gemini.js';

const STATUSES = new Set(['draft', 'scheduled', 'published']);

class BlogError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function text(value, field, { min = 0, max = 1000, optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string') throw new BlogError(400, `${field} must be text.`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) throw new BlogError(400, `${field} must be between ${min} and ${max} characters.`);
  return normalized;
}

function keywords(value, optional = false) {
  if (optional && value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 12) throw new BlogError(400, 'keywords must be a list of up to 12 items.');
  return value.map((item) => text(item, 'Each keyword', { min: 2, max: 40 }));
}

function boolean(value, field, optional = false) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new BlogError(400, `${field} must be true or false.`);
  return value;
}

function integer(value, field, min, max, fallback) {
  const input = value === undefined ? fallback : value;
  if (!Number.isInteger(input) || input < min || input > max) throw new BlogError(400, `${field} must be a whole number between ${min} and ${max}.`);
  return input;
}

function date(value, field, { optional = false, allowPast = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) {
    throw new BlogError(400, `${field} must be a UTC date and time in ISO format (for example, 2026-10-15T12:00:00Z).`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new BlogError(400, `${field} is not a valid date.`);
  if (!allowPast && parsed.getTime() <= Date.now()) throw new BlogError(400, `${field} must be in the future.`);
  return parsed.toISOString();
}

function slugify(value) {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72) || 'article';
}

function requireAdminToken(adminToken) {
  return (req, res, next) => {
    if (!adminToken || adminToken.length < 32) {
      return res.status(503).json({ error: 'Blog management is disabled until BLOG_ADMIN_TOKEN is set to a secret of at least 32 characters.' });
    }
    const header = req.get('authorization') || '';
    const candidate = header.startsWith('Bearer ') ? header.slice(7) : '';
    const expectedBuffer = Buffer.from(adminToken);
    const candidateBuffer = Buffer.from(candidate);
    if (candidateBuffer.length !== expectedBuffer.length || !timingSafeEqual(candidateBuffer, expectedBuffer)) {
      return res.status(401).json({ error: 'A valid blog admin bearer token is required.' });
    }
    next();
  };
}

function sendDatabaseConflict(res, error) {
  if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) {
    return res.status(409).json({ error: 'That item conflicts with existing blog data. Check for a duplicate topic automation or article slug.' });
  }
  return res.status(500).json({ error: 'The blog request could not be completed.' });
}

export function createBlogRouter({ database, provider, adminToken, scheduler }) {
  const router = express.Router();
  const now = () => new Date().toISOString();

  // Published posts are public; their management routes below require a bearer token.
  router.get('/public/articles', (req, res) => {
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    res.json({ articles: database.listPublicArticles(limit) });
  });
  router.get('/public/articles/:slug', (req, res) => {
    const article = database.getArticleBySlug(req.params.slug);
    if (!article) return res.status(404).json({ error: 'Published article not found.' });
    res.json({ article });
  });

  router.use(requireAdminToken(adminToken));

  router.get('/status', (_req, res) => {
    const connection = database.connection;
    const counts = connection.prepare(`SELECT
      (SELECT COUNT(*) FROM topics) AS topics,
      (SELECT COUNT(*) FROM articles WHERE status = 'draft') AS drafts,
      (SELECT COUNT(*) FROM articles WHERE status = 'scheduled') AS scheduled,
      (SELECT COUNT(*) FROM articles WHERE status = 'published') AS published,
      (SELECT COUNT(*) FROM automations WHERE enabled = 1) AS active_automations`).get();
    const lastDailyRun = connection.prepare('SELECT run_date, status, attempts, finished_at, message FROM daily_blog_runs ORDER BY run_date DESC LIMIT 1').get() || null;
    res.json({ database: 'sqlite', generator: provider.id, aiConfigured: Boolean(provider.configured), publisher: 'local-json-api', scheduler: scheduler.isRunning ? 'active' : 'stopped', dailyAutomation: { time: '14:30', timeZone: 'Asia/Karachi', articlesPerRun: 2, lastRun: lastDailyRun }, counts });
  });

  router.get('/topics', (_req, res) => res.json({ topics: database.listTopics() }));
  router.post('/topics', (req, res) => {
    const title = text(req.body?.title, 'title', { min: 3, max: 140 });
    const brief = text(req.body?.brief ?? '', 'brief', { max: 1200 });
    const topicKeywords = keywords(req.body?.keywords ?? []);
    const active = boolean(req.body?.active, 'active', true) ?? true;
    const timestamp = now();
    const topic = database.createTopic({ id: randomUUID(), title, brief, keywords: topicKeywords, active, createdAt: timestamp, updatedAt: timestamp });
    res.status(201).json({ topic });
  });
  router.get('/topics/:id', (req, res) => {
    const topic = database.getTopic(req.params.id);
    if (!topic) throw new BlogError(404, 'Topic not found.');
    res.json({ topic });
  });
  router.patch('/topics/:id', (req, res) => {
    const current = database.getTopic(req.params.id);
    if (!current) throw new BlogError(404, 'Topic not found.');
    const topic = database.updateTopic(current.id, {
      title: text(req.body?.title, 'title', { min: 3, max: 140, optional: true }) ?? current.title,
      brief: text(req.body?.brief, 'brief', { max: 1200, optional: true }) ?? current.brief,
      keywords: keywords(req.body?.keywords, true) ?? current.keywords,
      active: boolean(req.body?.active, 'active', true) ?? current.active,
      updatedAt: now(),
    });
    res.json({ topic });
  });
  router.delete('/topics/:id', (req, res) => {
    const topic = database.getTopic(req.params.id);
    if (!topic) throw new BlogError(404, 'Topic not found.');
    if (database.countTopicArticles(topic.id) > 0) throw new BlogError(409, 'This topic has articles. Archive it by setting active to false instead of deleting its history.');
    database.deleteTopic(topic.id);
    res.status(204).end();
  });

  router.get('/articles', (req, res) => {
    const status = req.query.status;
    if (status && !STATUSES.has(status)) throw new BlogError(400, 'status must be draft, scheduled, or published.');
    const limitInput = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limitInput) || limitInput < 1 || limitInput > 100) throw new BlogError(400, 'limit must be between 1 and 100.');
    const topicId = req.query.topicId ? text(req.query.topicId, 'topicId', { min: 1, max: 80 }) : undefined;
    res.json({ articles: database.listArticles({ status, topicId, limit: limitInput }) });
  });
  router.post('/articles/ingest', (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      throw new BlogError(400, 'The request body must be a JSON object.');
    }
    const acceptedFields = new Set(['topicId', 'title', 'excerpt', 'body', 'metaDescription', 'suggestedKeywords', 'imageAltText']);
    if (Object.keys(req.body).some((field) => !acceptedFields.has(field))) {
      throw new BlogError(400, 'Only topicId, title, excerpt, body, metaDescription, and suggestedKeywords are accepted. Publishing and scheduling fields are not allowed.');
    }
    const topicId = text(req.body?.topicId, 'topicId', { min: 1, max: 80 });
    const topic = database.getTopic(topicId);
    if (!topic) throw new BlogError(404, 'Topic not found.');

    const title = text(req.body?.title, 'title', { min: 3, max: 140 });
    const excerpt = text(req.body?.excerpt, 'excerpt', { min: 10, max: 500 });
    const body = text(req.body?.body, 'body', { min: 30, max: 10_000 });
    const metaDescription = req.body.metaDescription === undefined
      ? excerpt.slice(0, 320)
      : text(req.body.metaDescription, 'metaDescription', { min: 10, max: 320 });
    const suggestedKeywords = req.body.suggestedKeywords === undefined ? [] : keywords(req.body.suggestedKeywords);
    const id = randomUUID();
    const timestamp = now();
    const article = database.createArticle({
      id,
      topicId,
      title,
      slug: `${slugify(title)}-${id.slice(0, 8)}`,
      excerpt,
      body,
      metaDescription,
      suggestedKeywords,
      imageAltText: req.body.imageAltText === undefined ? '' : text(req.body.imageAltText, 'imageAltText', { max: 240 }),
      status: 'draft',
      generatedBy: 'n8n-ingest',
      scheduledAt: null,
      publishedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    res.status(201).json({ article, note: 'Article received from n8n and saved as a draft.' });
  });
  router.post('/articles/generate', async (req, res) => {
    const topicId = text(req.body?.topicId, 'topicId', { min: 1, max: 80 });
    const topic = database.getTopic(topicId);
    if (!topic) throw new BlogError(404, 'Topic not found.');
    if (!topic.active) throw new BlogError(409, 'This topic is inactive. Activate it before generating a draft.');
    const title = text(req.body?.title, 'title', { min: 3, max: 140, optional: true });
    const draft = await provider.generate({ topic, title });
    const id = randomUUID();
    const timestamp = now();
    const article = database.createArticle({
      id, topicId, title: draft.title, slug: `${slugify(draft.slug || draft.title)}-${id.slice(0, 8)}`,
      excerpt: draft.excerpt, body: draft.body, status: 'draft', generatedBy: draft.generatedBy,
      metaDescription: draft.metaDescription || draft.excerpt,
      suggestedKeywords: draft.suggestedKeywords || [],
      imageAltText: draft.imageAltText || '',
      scheduledAt: null, publishedAt: null, createdAt: timestamp, updatedAt: timestamp,
    });
    res.status(201).json({ article });
  });
  router.get('/articles/:id', (req, res) => {
    const article = database.getArticle(req.params.id);
    if (!article) throw new BlogError(404, 'Article not found.');
    res.json({ article });
  });
  router.patch('/articles/:id', (req, res) => {
    const current = database.getArticle(req.params.id);
    if (!current) throw new BlogError(404, 'Article not found.');
    if (current.status === 'published') throw new BlogError(409, 'Published articles are read-only. Create a new draft to revise this article.');
    const title = text(req.body?.title, 'title', { min: 3, max: 140, optional: true }) ?? current.title;
    const excerpt = text(req.body?.excerpt, 'excerpt', { min: 10, max: 500, optional: true }) ?? current.excerpt;
    const body = text(req.body?.body, 'body', { min: 30, max: 10_000, optional: true }) ?? current.body;
    const metaDescription = text(req.body?.metaDescription, 'metaDescription', { min: 10, max: 320, optional: true })
      ?? (req.body?.excerpt === undefined ? current.meta_description : excerpt);
    const suggestedKeywords = keywords(req.body?.suggestedKeywords, true) ?? current.suggested_keywords;
    const imageAltText = text(req.body?.imageAltText, 'imageAltText', { max: 240, optional: true }) ?? current.image_alt_text;
    const article = database.updateArticle(current.id, {
      title, slug: `${slugify(title)}-${current.id.slice(0, 8)}`, excerpt, body, imageAltText,
      metaDescription, suggestedKeywords, updatedAt: now(),
    });
    res.json({ article });
  });
  router.post('/articles/:id/schedule', (req, res) => {
    const current = database.getArticle(req.params.id);
    if (!current) throw new BlogError(404, 'Article not found.');
    if (current.status === 'published') throw new BlogError(409, 'A published article cannot be scheduled again.');
    const scheduledAt = date(req.body?.scheduledAt, 'scheduledAt');
    const article = database.scheduleArticle(current.id, scheduledAt, now());
    res.json({ article, note: 'The local scheduler will publish this article through the public blog API when it is due.' });
  });
  router.post('/articles/:id/publish', (req, res) => {
    const current = database.getArticle(req.params.id);
    if (!current) throw new BlogError(404, 'Article not found.');
    if (current.status === 'published') throw new BlogError(409, 'This article has already been published.');
    const article = database.publishArticle(current.id, now());
    res.json({ article, note: 'Published to this app’s local public article API. No external CMS is connected.' });
  });
  router.post('/articles/:id/unschedule', (req, res) => {
    const article = database.unscheduleArticle(req.params.id, now());
    if (!article) {
      if (!database.getArticle(req.params.id)) throw new BlogError(404, 'Article not found.');
      throw new BlogError(409, 'Only a scheduled article can be returned to draft status.');
    }
    res.json({ article });
  });
  router.delete('/articles/:id', (req, res) => {
    const article = database.getArticle(req.params.id);
    if (!article) throw new BlogError(404, 'Article not found.');
    if (!database.deleteArticle(article.id)) throw new BlogError(409, 'Only draft articles can be deleted.');
    res.status(204).end();
  });

  router.get('/automations', (_req, res) => res.json({ automations: database.listAutomations() }));
  router.post('/automations/run-due', async (_req, res) => {
    const outcome = await scheduler.tick();
    res.json({ outcome });
  });
  router.post('/automations', (req, res) => {
    const topicId = text(req.body?.topicId, 'topicId', { min: 1, max: 80 });
    const topic = database.getTopic(topicId);
    if (!topic) throw new BlogError(404, 'Topic not found.');
    if (!topic.active) throw new BlogError(409, 'Activate this topic before creating an automation.');
    const cadenceDays = integer(req.body?.cadenceDays, 'cadenceDays', 1, 365, 7);
    const publishDelayHours = integer(req.body?.publishDelayHours, 'publishDelayHours', 1, 720, 24);
    const nextRunAt = req.body?.nextRunAt === undefined ? new Date(Date.now() + 60_000).toISOString() : date(req.body.nextRunAt, 'nextRunAt');
    const timestamp = now();
    const automation = database.createAutomation({
      id: randomUUID(), topicId, cadenceDays, publishDelayHours, enabled: boolean(req.body?.enabled, 'enabled', true) ?? true,
      nextRunAt, createdAt: timestamp, updatedAt: timestamp,
    });
    res.status(201).json({ automation, note: 'When due, this automation generates an AI draft and schedules it for local publication.' });
  });
  router.patch('/automations/:id', (req, res) => {
    const current = database.getAutomation(req.params.id);
    if (!current) throw new BlogError(404, 'Automation not found.');
    const automation = database.updateAutomation(current.id, {
      cadenceDays: integer(req.body?.cadenceDays, 'cadenceDays', 1, 365, current.cadence_days),
      publishDelayHours: integer(req.body?.publishDelayHours, 'publishDelayHours', 1, 720, current.publish_delay_hours),
      enabled: boolean(req.body?.enabled, 'enabled', true) ?? current.enabled,
      nextRunAt: req.body?.nextRunAt === undefined ? current.next_run_at : date(req.body.nextRunAt, 'nextRunAt', { allowPast: !current.enabled }),
      updatedAt: now(),
    });
    res.json({ automation });
  });
  router.delete('/automations/:id', (req, res) => {
    if (!database.deleteAutomation(req.params.id)) throw new BlogError(404, 'Automation not found.');
    res.status(204).end();
  });

  router.use((error, _req, res, _next) => {
    if (error instanceof BlogError) return res.status(error.status).json({ error: error.message });
    if (error instanceof BlogProviderError) return res.status(error.status).json({ error: error.message });
    return sendDatabaseConflict(res, error);
  });
  return router;
}

