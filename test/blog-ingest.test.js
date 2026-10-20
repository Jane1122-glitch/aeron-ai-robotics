import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createBlogDatabase } from '../src/blog/database.js';
import { createBlogRouter } from '../src/blog/routes.js';

const adminToken = 'blog-ingest-test-token-at-least-32-characters';
const tempDirectory = mkdtempSync(path.join(os.tmpdir(), 'aeron-blog-ingest-test-'));
const database = createBlogDatabase(path.join(tempDirectory, 'ingest.sqlite'));
const timestamp = new Date().toISOString();
const topic = database.createTopic({
  id: randomUUID(),
  title: 'Robotics in shared workspaces',
  brief: 'Practical robotics guidance for teams.',
  keywords: ['robotics'],
  active: true,
  createdAt: timestamp,
  updatedAt: timestamp,
});
let schedulerCalls = 0;
const scheduler = {
  isRunning: false,
  async tick() {
    schedulerCalls += 1;
    throw new Error('Ingest tests must not trigger scheduler work.');
  },
};
const provider = { id: 'test-provider', configured: false, async generate() { throw new Error('Ingest must not call the AI provider.'); } };
const app = express();
app.use(express.json({ limit: '32kb' }));
app.use('/api/blog', createBlogRouter({ database, provider, adminToken, scheduler }));
const server = createServer(app);
let baseUrl;

async function api(pathname, { method = 'GET', body, token = adminToken } = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  database.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

test('authenticated n8n ingestion validates input and persists only a draft', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const payload = {
    topicId: topic.id,
    title: 'A Practical Guide to Robotics at Work',
    excerpt: 'Explore practical ways to introduce robotics into shared workspaces.',
    body: 'Robotics projects work best when teams start with a clear task, a safe environment, and a way to review outcomes.',
    metaDescription: 'Learn how to plan robotics projects for shared workspaces with clear goals, safety practices, and ongoing review.',
    suggestedKeywords: ['workplace robotics', 'robotics planning'],
  };

  const unauthorized = await api('/api/blog/articles/ingest', { method: 'POST', body: payload, token: '' });
  assert.equal(unauthorized.status, 401);

  const missingBody = await api('/api/blog/articles/ingest', {
    method: 'POST',
    body: { ...payload, body: undefined },
  });
  assert.equal(missingBody.status, 400);

  const invalidKeywords = await api('/api/blog/articles/ingest', {
    method: 'POST',
    body: { ...payload, suggestedKeywords: 'robotics' },
  });
  assert.equal(invalidKeywords.status, 400);

  const unsafeStatus = await api('/api/blog/articles/ingest', {
    method: 'POST',
    body: { ...payload, status: 'published', scheduledAt: new Date(Date.now() + 60_000).toISOString() },
  });
  assert.equal(unsafeStatus.status, 400);

  const invalidMetaDescription = await api('/api/blog/articles/ingest', {
    method: 'POST',
    body: { ...payload, metaDescription: null },
  });
  assert.equal(invalidMetaDescription.status, 400);

  const unknownTopic = await api('/api/blog/articles/ingest', {
    method: 'POST',
    body: { ...payload, topicId: randomUUID() },
  });
  assert.equal(unknownTopic.status, 404);

  const response = await api('/api/blog/articles/ingest', { method: 'POST', body: payload });
  assert.equal(response.status, 201);
  const { article } = await response.json();
  assert.equal(article.topic_id, topic.id);
  assert.equal(article.status, 'draft');
  assert.equal(article.scheduled_at, null);
  assert.equal(article.published_at, null);
  assert.equal(article.generated_by, 'n8n-ingest');
  assert.equal(article.meta_description, payload.metaDescription);
  assert.deepEqual(article.suggested_keywords, payload.suggestedKeywords);
  assert.match(article.slug, /^a-practical-guide-to-robotics-at-work-[a-f0-9]{8}$/);

  const storedArticle = database.getArticle(article.id);
  assert.equal(storedArticle.status, 'draft');
  assert.equal(storedArticle.scheduled_at, null);
  assert.equal(storedArticle.published_at, null);
  assert.equal(database.countTopicArticles(topic.id), 1);
  assert.equal(schedulerCalls, 0);

  const publicArticles = await api('/api/blog/public/articles', { token: '' });
  assert.equal(publicArticles.status, 200);
  assert.equal((await publicArticles.json()).articles.length, 0);
});

test('n8n ingestion defaults omitted SEO fields without scheduling or publishing', async () => {
  const response = await api('/api/blog/articles/ingest', {
    method: 'POST',
    body: {
      topicId: topic.id,
      title: 'Robotics Project Planning',
      excerpt: 'A concise summary of planning a robotics project with clear goals.',
      body: 'Start with a well-defined task, involve the people who will use the system, and establish a safe way to evaluate results.',
    },
  });
  assert.equal(response.status, 201);
  const { article } = await response.json();
  assert.equal(article.status, 'draft');
  assert.equal(article.meta_description, article.excerpt);
  assert.deepEqual(article.suggested_keywords, []);
  assert.equal(article.scheduled_at, null);
  assert.equal(article.published_at, null);
  assert.equal(schedulerCalls, 0);
});

