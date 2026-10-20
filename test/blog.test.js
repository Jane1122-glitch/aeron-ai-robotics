import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { generateGeminiContent } from '../src/gemini.js';
import { createBlogDatabase } from '../src/blog/database.js';
import { createGeminiBlogProvider } from '../src/blog/providers/gemini.js';
import { createBlogRouter } from '../src/blog/routes.js';
import { createBlogScheduler, karachiDateKey, nextDailyOccurrence, runDailyBlogAutomation } from '../src/blog/scheduler.js';

const sentence = 'Teams should map the work, review constraints, and invite operators to evaluate changes before deploying a robot.';
const longParagraph = Array(14).fill(sentence).join(' ');
const generatedArticle = {
  title: 'A Practical Guide to Safe Robotics at Work',
  excerpt: 'A practical guide to planning, evaluating, and improving safe robotics deployments in workplaces.',
  introduction: longParagraph,
  sections: [
    { heading: 'Understand the task and environment', content: longParagraph },
    { heading: 'Set clear operating boundaries', content: longParagraph },
    { heading: 'Work with operators', content: longParagraph },
    { heading: 'Review results over time', content: longParagraph },
  ],
  conclusion: longParagraph,
  meta_description: 'Learn practical steps for planning safe workplace robotics, from evaluating the environment to supporting operators and reviewing results.',
  suggested_keywords: ['workplace robotics', 'robot safety', 'automation planning', 'human robot interaction'],
  image_alt_text: 'A collaborative robot working beside a person in a bright workshop',
  slug: 'safe-robotics-at-work',
};
const topicIdeas = [
  { category: 'Robotics', title: 'Designing Safe Robot Workcells', brief: 'Explain how to assess workspace hazards and define practical safety boundaries for collaborative robot workcells.', keywords: ['robot safety', 'workcell design', 'collaborative robots'] },
  { category: 'AI Automation', title: 'Human Review in AI Workflows', brief: 'Describe where human review belongs in AI-assisted business workflows and how teams can improve handoffs.', keywords: ['AI workflows', 'human review', 'automation'] },
];
const tempDirectory = mkdtempSync(path.join(os.tmpdir(), 'aeron-gemini-test-'));
const adminToken = 'gemini-blog-test-token-that-is-over-32-characters';
const testDatabases = [];
const testServers = [];

function newDatabase(name) {
  const database = createBlogDatabase(path.join(tempDirectory, `${name}.sqlite`));
  testDatabases.push(database);
  return database;
}

function fakeTimers() {
  const timeouts = [];
  const intervals = [];
  return {
    timeouts,
    intervals,
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} };
      timeouts.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) { timer.cleared = true; },
    setIntervalFn(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} };
      intervals.push(timer);
      return timer;
    },
    clearIntervalFn(timer) { timer.cleared = true; },
  };
}

function mockGeminiFetch(statuses, outputText = JSON.stringify(generatedArticle)) {
  let calls = 0;
  const fetch = async () => {
    const status = statuses[Math.min(calls, statuses.length - 1)];
    calls += 1;
    const body = status === 200
      ? { candidates: [{ content: { role: 'model', parts: [{ text: outputText }] }, finishReason: 'STOP' }] }
      : { error: { code: status, message: 'mock Gemini failure' } };
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetch, get calls() { return calls; } };
}

function mockProvider({ generate = async () => JSON.stringify(generatedArticle), topics = async () => JSON.stringify({ topics: topicIdeas }) } = {}) {
  return createGeminiBlogProvider({ apiKey: 'mock-key-not-a-real-secret', model: 'test-model', generate: async (request) => {
    if (request.responseSchema?.properties?.topics) return topics(request);
    return generate(request);
  } });
}

async function startApi(database, provider, scheduler = createBlogScheduler({ database, provider })) {
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use('/api/blog', createBlogRouter({ database, provider, adminToken, scheduler }));
  const server = createServer(app);
  testServers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return async (pathname, { method = 'GET', body, token = adminToken } = {}) => fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

after(async () => {
  await Promise.all(testServers.map((server) => new Promise((resolve) => server.close(resolve))));
  for (const database of testDatabases) database.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

test('official Gemini SDK request uses server-side auth and structured JSON output', async () => {
  let request;
  const client = { models: { generateContent: async (input) => { request = input; return { text: '{"ok":true}' }; } } };
  const retryOptions = { attempts: 3, httpStatusCodes: [503, 504], initialDelay: 0.5, maxDelay: 2, expBase: 2, jitter: 1 };
  const text = await generateGeminiContent({ apiKey: 'mock-only', model: 'test-model', systemInstruction: 'Be concise.', prompt: 'Return JSON.', maxOutputTokens: 100, responseSchema: { type: 'object' }, retryOptions, client });
  assert.equal(text, '{"ok":true}');
  assert.equal(request.model, 'test-model');
  assert.equal(request.config.systemInstruction, 'Be concise.');
  assert.equal(request.config.responseMimeType, 'application/json');
  assert.deepEqual(request.config.responseSchema, { type: 'object' });
  assert.deepEqual(request.config.httpOptions.retryOptions, retryOptions);
  assert.equal(typeof request.config.httpOptions.fetch, 'function');
  assert.equal(request.contents, 'Return JSON.');
});

test('Gemini article SDK retries transient HTTP 503 and 504 errors at most twice', async (t) => {
  const topic = { title: 'Testing', brief: 'A practical test topic', keywords: [] };
  const providerFor = (mock) => createGeminiBlogProvider({
    apiKey: 'mock-only', model: 'test-model',
    fetcher: mock.fetch,
  });

  await t.test('HTTP 200 succeeds with one request', async () => {
    const mock = mockGeminiFetch([200]);
    const article = await providerFor(mock).generate({ topic });
    assert.equal(article.title, generatedArticle.title);
    assert.equal(mock.calls, 1);
  });

  await t.test('HTTP 504 followed by success uses two requests', async () => {
    const mock = mockGeminiFetch([504, 200]);
    const article = await providerFor(mock).generate({ topic });
    assert.equal(article.title, generatedArticle.title);
    assert.equal(mock.calls, 2);
  });

  await t.test('HTTP 503 followed by success uses two requests', async () => {
    const mock = mockGeminiFetch([503, 200]);
    const article = await providerFor(mock).generate({ topic });
    assert.equal(article.title, generatedArticle.title);
    assert.equal(mock.calls, 2);
  });

  await t.test('repeated HTTP 503 and 504 stop after three requests and stay sanitized', async () => {
    for (const [status, code] of [[503, 'upstream_error'], [504, 'gateway_timeout']]) {
      const mock = mockGeminiFetch([status]);
      await assert.rejects(providerFor(mock).generate({ topic }), (error) => {
        assert.equal(error.status, 502);
        assert.equal(error.code, code);
        assert.equal(error.message, 'Gemini is temporarily unavailable. Please try again shortly.');
        assert.doesNotMatch(error.message, /mock Gemini failure/);
        return true;
      });
      assert.equal(mock.calls, 3);
    }
  });

  await t.test('transport errors are not retried by the HTTP status policy', async () => {
    let calls = 0;
    const provider = createGeminiBlogProvider({ apiKey: 'mock-only', model: 'test-model', fetcher: async () => { calls += 1; throw new Error('mock transport failure'); } });
    await assert.rejects(provider.generate({ topic }), (error) => {
      assert.equal(error.status, 502);
      assert.equal(error.code, 'network_error');
      assert.doesNotMatch(error.message, /mock transport failure/);
      return true;
    });
    assert.equal(calls, 1);
  });
});

test('Gemini provider validates complete article fields and rejects invalid output', async (t) => {
  let request;
  const provider = createGeminiBlogProvider({ apiKey: 'mock-only', model: 'configured-model', generate: async (value) => { request = value; return JSON.stringify(generatedArticle); } });
  const topic = { title: 'Robotics', brief: 'Workplace robots', keywords: ['robotics'] };
  const draft = await provider.generate({ topic });
  assert.equal(request.model, 'configured-model');
  assert.equal(request.maxOutputTokens, 8000);
  assert.deepEqual(request.retryOptions, { attempts: 3, httpStatusCodes: [503, 504], initialDelay: 0.5, maxDelay: 2, expBase: 2, jitter: 1 });
  assert.match(request.systemInstruction, /1,200-1,800 words/);
  assert.equal(draft.generatedBy, 'gemini');
  assert.equal(draft.excerpt, generatedArticle.excerpt);
  assert.equal(draft.imageAltText, generatedArticle.image_alt_text);
  assert.deepEqual(draft.suggestedKeywords, generatedArticle.suggested_keywords);
  assert.match(draft.body, /## Introduction/);
  assert.match(draft.body, /## Conclusion/);
  assert.ok(draft.body.split(/\s+/).length >= 900);

  await t.test('missing API key', async () => {
    const missing = createGeminiBlogProvider({ apiKey: '', model: 'test-model' });
    await assert.rejects(missing.generate({ topic }), { status: 503, code: 'missing_api_key' });
  });
  await t.test('invalid article is rejected', async () => {
    const invalid = createGeminiBlogProvider({ apiKey: 'mock-only', generate: async () => JSON.stringify({ ...generatedArticle, sections: [] }) });
    await assert.rejects(invalid.generate({ topic }), { code: 'invalid_output' });
  });
});

test('Gemini topic selection requests two distinct evergreen ideas and prevents duplicate topics', async () => {
  let request;
  const provider = createGeminiBlogProvider({ apiKey: 'mock-only', generate: async (value) => { request = value; return JSON.stringify({ topics: topicIdeas }); } });
  const topics = await provider.generateTopics({ existingTopics: [{ title: 'Robotics', brief: 'Earlier topics about industrial robot maintenance.' }] });
  assert.equal(topics.length, 2);
  assert.equal(request.responseSchema.properties.topics.type, 'array');
  assert.match(request.prompt, /Earlier topics about industrial robot maintenance/);

  const duplicate = createGeminiBlogProvider({ apiKey: 'mock-only', generate: async () => JSON.stringify({ topics: topicIdeas }) });
  await assert.rejects(duplicate.generateTopics({ existingTopics: [{ title: 'Designing Safe Robot Workcells', brief: 'Older article about workcells.' }] }), { code: 'duplicate_topic' });
});

test('Gemini API failures are translated without leaking SDK details', async (t) => {
  const topic = { title: 'Testing', brief: '', keywords: [] };
  for (const [name, failure, status, code] of [
    ['invalid key', Object.assign(new Error('sensitive sdk response'), { status: 401 }), 502, 'invalid_api_key'],
    ['insufficient quota', Object.assign(new Error('sensitive quota details'), { status: 429, code: 'insufficient_quota' }), 402, 'insufficient_quota'],
    ['rate limit', Object.assign(new Error('sensitive sdk response'), { status: 429 }), 429, 'rate_limited'],
    ['gateway timeout', Object.assign(new Error('sensitive sdk response'), { status: 504 }), 502, 'gateway_timeout'],
    ['upstream outage', Object.assign(new Error('sensitive sdk response'), { status: 503 }), 502, 'upstream_error'],
    ['network error', Object.assign(new Error('sensitive sdk response'), { name: 'GeminiApiError', status: 0 }), 502, 'network_error'],
  ]) {
    await t.test(name, async () => {
      const provider = createGeminiBlogProvider({ apiKey: 'mock-only', generate: async () => { throw failure; } });
      await assert.rejects(provider.generate({ topic }), (error) => {
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        assert.doesNotMatch(error.message, /sensitive sdk response/);
        return true;
      });
    });
  }
});

test('authenticated article route persists a Gemini draft and keeps existing publish controls', async () => {
  const database = newDatabase('api');
  const provider = mockProvider();
  const api = await startApi(database, provider);
  const noAuth = await api('/api/blog/topics', { token: '' });
  assert.equal(noAuth.status, 401);
  const topicResponse = await api('/api/blog/topics', { method: 'POST', body: { title: 'Workplace robotics', brief: 'Planning safe robots at work', keywords: ['robotics'] } });
  assert.equal(topicResponse.status, 201);
  const { topic } = await topicResponse.json();

  const generation = await api('/api/blog/articles/generate', { method: 'POST', body: { topicId: topic.id } });
  assert.equal(generation.status, 201);
  const { article } = await generation.json();
  assert.equal(article.status, 'draft');
  assert.equal(article.category, topic.title);
  assert.equal(article.generated_by, 'gemini');
  assert.equal(article.image_alt_text, generatedArticle.image_alt_text);
  assert.equal(article.meta_description, generatedArticle.meta_description);
  assert.deepEqual(article.suggested_keywords, generatedArticle.suggested_keywords);
  assert.match(article.slug, /^safe-robotics-at-work-/);

  const scheduledAt = new Date(Date.now() + 1000).toISOString();
  const scheduled = await api(`/api/blog/articles/${article.id}/schedule`, { method: 'POST', body: { scheduledAt } });
  assert.equal((await scheduled.json()).article.status, 'scheduled');
  assert.equal(database.getArticle(article.id).image_alt_text, generatedArticle.image_alt_text);
  const status = await api('/api/blog/status');
  const statusJson = await status.json();
  assert.equal(statusJson.generator, 'google-gemini');
  assert.deepEqual(statusJson.dailyAutomation, { time: '14:30', timeZone: 'Asia/Karachi', articlesPerRun: 2, lastRun: null });
});

test('daily automation publishes two distinct articles at Asia/Karachi time and is idempotent', async () => {
  const database = newDatabase('daily');
  let generated = 0;
  const provider = mockProvider({ generate: async () => { generated += 1; return JSON.stringify({ ...generatedArticle, title: `${generatedArticle.title} ${generated}`, slug: `${generatedArticle.slug}-${generated}` }); } });
  const runAt = new Date('2026-10-19T09:30:00.000Z'); // 14:30 Asia/Karachi
  const first = await runDailyBlogAutomation(database, provider, runAt, { logger: { info() {}, error() {} }, retry: (operation) => operation() });
  assert.equal(first.status, 'completed');
  assert.equal(first.results.filter((item) => item.status === 'published').length, 2);
  const articles = database.connection.prepare("SELECT * FROM articles WHERE status = 'published' ORDER BY title").all();
  assert.equal(articles.length, 2);
  assert.equal(database.connection.prepare('SELECT COUNT(*) AS count FROM daily_blog_items').get().count, 2);
  assert.ok(articles.every((article) => article.published_at && article.scheduled_at === null));
  assert.equal(articles[0].topic_id === articles[1].topic_id, false);
  assert.ok(articles.every((article) => article.image_alt_text === generatedArticle.image_alt_text));

  const repeated = await runDailyBlogAutomation(database, provider, new Date(runAt.getTime() + 60_000), { logger: { info() {}, error() {} } });
  assert.equal(repeated.skipped, true);
  assert.equal(generated, 2);
  assert.equal(database.connection.prepare('SELECT status FROM daily_blog_runs WHERE run_date = ?').get('2026-10-19').status, 'completed');
});

test('daily automation keeps a successful article and retries a failed slot without duplication', async () => {
  const database = newDatabase('retry');
  let calls = 0;
  const provider = mockProvider({ generate: async () => {
    calls += 1;
    if (calls <= 3) throw Object.assign(new Error('temporary'), { status: 429, code: 'rate_limited' });
    return JSON.stringify({ ...generatedArticle, title: `${generatedArticle.title} ${calls}`, slug: `${generatedArticle.slug}-${calls}` });
  } });
  const runAt = new Date('2026-10-20T09:30:00.000Z');
  const first = await runDailyBlogAutomation(database, provider, runAt, { logger: { info() {}, error() {} } });
  assert.equal(first.status, 'partial');
  assert.equal(calls, 4); // One article received three bounded retries; the other was still completed.
  assert.equal(database.connection.prepare('SELECT COUNT(*) AS count FROM daily_blog_items').get().count, 1);
  const earlyRetry = await runDailyBlogAutomation(database, provider, new Date(runAt.getTime() + 5 * 60 * 1000), { logger: { info() {}, error() {} } });
  assert.equal(earlyRetry.skipped, true);
  const retryAt = new Date(runAt.getTime() + 16 * 60 * 1000);
  const second = await runDailyBlogAutomation(database, provider, retryAt, { logger: { info() {}, error() {} }, retry: (operation) => operation() });
  assert.equal(second.status, 'completed');
  assert.equal(database.connection.prepare("SELECT COUNT(*) AS count FROM articles WHERE status = 'published'").get().count, 2);
  assert.equal(database.connection.prepare('SELECT COUNT(*) AS count FROM daily_blog_items WHERE run_date = ?').get('2026-10-20').count, 2);
  assert.equal(database.connection.prepare('SELECT COUNT(DISTINCT article_id) AS count FROM daily_blog_items').get().count, 2);
});

test('scheduler automatically retries a failed daily slot at next_retry_at without republishing completed slots', async () => {
  const database = newDatabase('scheduled-retry');
  const timers = fakeTimers();
  let now = new Date('2026-10-23T09:30:00.000Z'); // 14:30 Asia/Karachi
  let articleCalls = 0;
  const provider = mockProvider({ generate: async () => {
      articleCalls += 1;
      if (articleCalls === 2) throw Object.assign(new Error('sanitized timeout'), { status: 504 });
      return JSON.stringify({ ...generatedArticle, title: `${generatedArticle.title} ${articleCalls}`, slug: `${generatedArticle.slug}-${articleCalls}` });
    } });
  const scheduler = createBlogScheduler({
    database, provider, clock: () => new Date(now), intervalMs: 30_000,
    logger: { info() {}, error() {} },
    ...timers,
  });

  const first = await scheduler.tick(now, { runDaily: true });
  assert.equal(first.daily.status, 'partial');
  scheduler.start();
  await new Promise((resolve) => setImmediate(resolve));
  const run = database.connection.prepare('SELECT next_retry_at FROM daily_blog_runs WHERE run_date = ?').get('2026-10-23');
  assert.equal(Date.parse(run.next_retry_at) - now.getTime(), 15 * 60 * 1000);
  assert.equal(articleCalls, 2); // The exhausted 504 was not retried immediately by the scheduler.
  assert.equal(database.connection.prepare('SELECT COUNT(*) AS count FROM daily_blog_items').get().count, 1);

  const retryTimer = timers.timeouts.find((item) => !item.cleared && item.delay === 15 * 60 * 1000);
  assert.ok(retryTimer, 'scheduler should register a timer for next_retry_at');
  now = new Date(run.next_retry_at);
  await retryTimer.callback();

  assert.equal(articleCalls, 3); // Existing published slot is skipped; only the failed slot is generated again.
  assert.equal(database.connection.prepare("SELECT COUNT(*) AS count FROM articles WHERE status = 'published'").get().count, 2);
  assert.equal(database.connection.prepare('SELECT COUNT(*) AS count FROM daily_blog_items WHERE run_date = ?').get('2026-10-23').count, 2);
  assert.equal(database.connection.prepare('SELECT COUNT(DISTINCT article_id) AS count FROM daily_blog_items').get().count, 2);
  const repeated = await scheduler.tick(now, { runDaily: true });
  assert.equal(repeated.daily.skipped, true);
  assert.equal(articleCalls, 3);
  scheduler.stop();
});

test('daily runner protects against overlapping duplicate execution', async () => {
  const database = newDatabase('overlap');
  let resolveTopics;
  const topicGate = new Promise((resolve) => { resolveTopics = resolve; });
  let topicCalls = 0;
  const provider = mockProvider({
    topics: async () => { topicCalls += 1; await topicGate; return JSON.stringify({ topics: topicIdeas }); },
  });
  const runAt = new Date('2026-10-21T09:30:00.000Z');
  const first = runDailyBlogAutomation(database, provider, runAt, { logger: { info() {}, error() {} }, retry: (operation) => operation() });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await runDailyBlogAutomation(database, provider, runAt, { logger: { info() {}, error() {} }, retry: (operation) => operation() });
  assert.equal(second.skipped, true);
  resolveTopics();
  const completed = await first;
  assert.equal(completed.status, 'completed');
  assert.equal(topicCalls, 1);
  assert.equal(database.connection.prepare("SELECT COUNT(*) AS count FROM articles WHERE status = 'published'").get().count, 2);
});

test('daily schedule resolves 14:30 using the Asia/Karachi timezone', () => {
  const before = nextDailyOccurrence(new Date('2026-10-19T09:29:59.000Z'));
  assert.equal(before.toISOString(), '2026-10-19T09:30:00.000Z');
  const atTime = nextDailyOccurrence(new Date('2026-10-19T09:30:00.000Z'));
  assert.equal(atTime.toISOString(), '2026-10-20T09:30:00.000Z');
  assert.equal(karachiDateKey(new Date('2026-10-19T20:00:00.000Z')), '2026-10-20');
});

test('article publication failure rolls back only that slot, preserving the other successful article', async () => {
  const database = newDatabase('publish-failure');
  const originalPublish = database.publishArticle.bind(database);
  let failFirst = true;
  database.publishArticle = (id, publishedAt) => {
    if (failFirst) { failFirst = false; return null; }
    return originalPublish(id, publishedAt);
  };
  const provider = mockProvider();
  const result = await runDailyBlogAutomation(database, provider, new Date('2026-10-22T09:30:00.000Z'), { logger: { info() {}, error() {} }, retry: (operation) => operation() });
  assert.equal(result.status, 'partial');
  assert.equal(database.connection.prepare("SELECT COUNT(*) AS count FROM articles WHERE status = 'published'").get().count, 1);
  assert.equal(database.connection.prepare("SELECT COUNT(*) AS count FROM articles WHERE status = 'draft'").get().count, 0);
  assert.equal(database.connection.prepare('SELECT COUNT(*) AS count FROM daily_blog_items').get().count, 1);
});

