import { randomUUID } from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;
const PUBLISH_TIME_ZONE = 'Asia/Karachi';
const STALE_RUN_MS = 15 * 60 * 1000;

function nextOccurrence(current, cadenceDays, now) {
  let timestamp = Date.parse(current) + cadenceDays * DAY_MS;
  while (timestamp <= now) timestamp += cadenceDays * DAY_MS;
  return new Date(timestamp).toISOString();
}

function zonedParts(date, timeZone) {
  const values = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(values.filter((part) => part.type !== 'literal').map(({ type, value }) => [type, Number(value)]));
}

function offsetAt(timestamp, timeZone) {
  const date = new Date(timestamp);
  const local = zonedParts(date, timeZone);
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second)
    - Math.floor(timestamp / 1000) * 1000;
}

function localTimeToUtc(year, month, day, hour, minute, timeZone) {
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  return localAsUtc - offsetAt(localAsUtc, timeZone);
}

export function nextDailyOccurrence(now = new Date(), timeZone = PUBLISH_TIME_ZONE, hour = 14, minute = 30) {
  const timestamp = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const local = zonedParts(new Date(timestamp), timeZone);
  let target = localTimeToUtc(local.year, local.month, local.day, hour, minute, timeZone);
  if (target <= timestamp) {
    const nextDay = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
    target = localTimeToUtc(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), hour, minute, timeZone);
  }
  return new Date(target);
}

export function karachiDateKey(now = new Date()) {
  const { year, month, day } = zonedParts(now instanceof Date ? now : new Date(now), PUBLISH_TIME_ZONE);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isAfterDailyTime(now) {
  const { hour, minute } = zonedParts(now, PUBLISH_TIME_ZONE);
  return hour > 14 || (hour === 14 && minute >= 30);
}

export function publishDueArticles(database, now = new Date()) {
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
  const result = database.connection.prepare(`UPDATE articles
    SET status = 'published', published_at = scheduled_at, updated_at = scheduled_at, scheduled_at = NULL
    WHERE status = 'scheduled' AND scheduled_at <= ?`).run(timestamp);
  return result.changes;
}

export async function runDueAutomations(database, provider, now = new Date()) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowIso = nowDate.toISOString();
  const connection = database.connection;
  const due = connection.prepare(`SELECT a.*, t.title AS topic_title, t.brief AS topic_brief,
    t.keywords AS topic_keywords, t.active AS topic_active
    FROM automations a JOIN topics t ON t.id = a.topic_id
    WHERE a.enabled = 1 AND a.next_run_at <= ? AND t.active = 1
    ORDER BY a.next_run_at ASC`).all(nowIso);
  const results = [];

  for (const automation of due) {
    const nextRunAt = nextOccurrence(automation.next_run_at, automation.cadence_days, nowDate.getTime());
    const claim = connection.prepare(`UPDATE automations SET next_run_at = ?, last_run_at = ?, updated_at = ?
      WHERE id = ? AND enabled = 1 AND next_run_at = ?`)
      .run(nextRunAt, nowIso, nowIso, automation.id, automation.next_run_at);
    if (!claim.changes) continue;

    const runId = randomUUID();
    try {
      const topic = {
        id: automation.topic_id,
        title: automation.topic_title,
        brief: automation.topic_brief,
        keywords: JSON.parse(automation.topic_keywords),
      };
      const draft = await provider.generate({ topic });
      const articleId = randomUUID();
      const scheduledAt = new Date(nowDate.getTime() + automation.publish_delay_hours * 60 * 60 * 1000).toISOString();
      const titleSlug = (draft.slug || draft.title).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72) || 'article';
      database.createArticle({
        id: articleId, topicId: topic.id, title: draft.title, slug: `${titleSlug}-${articleId.slice(0, 8)}`,
        excerpt: draft.excerpt, body: draft.body, imageAltText: draft.imageAltText,
        metaDescription: draft.metaDescription || draft.excerpt,
        suggestedKeywords: draft.suggestedKeywords || [], status: 'scheduled', generatedBy: draft.generatedBy,
        scheduledAt, publishedAt: null, createdAt: nowIso, updatedAt: nowIso,
      });
      connection.prepare(`INSERT INTO automation_runs
        (id, automation_id, topic_id, article_id, status, message, started_at, finished_at)
        VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)`).run(
        runId, automation.id, topic.id, articleId,
        'AI draft created and scheduled for local publication.', nowIso, nowIso,
      );
      results.push({ automationId: automation.id, status: 'completed', articleId });
    } catch (error) {
      connection.prepare(`INSERT INTO automation_runs
        (id, automation_id, topic_id, article_id, status, message, started_at, finished_at)
        VALUES (?, ?, ?, NULL, 'failed', ?, ?, ?)`).run(
        runId, automation.id, automation.topic_id, 'Draft generation failed.', nowIso, nowIso,
      );
      results.push({ automationId: automation.id, status: 'failed', errorCode: error?.code || 'generation_error' });
    }
  }

  return results;
}

function claimDailyRun(database, runDate, timestamp) {
  const connection = database.connection;
  connection.exec('BEGIN IMMEDIATE');
  try {
    const current = connection.prepare('SELECT * FROM daily_blog_runs WHERE run_date = ?').get(runDate);
    if (current?.status === 'completed') {
      connection.exec('ROLLBACK');
      return false;
    }
    if (current?.next_retry_at && Date.parse(current.next_retry_at) > timestamp.getTime()) {
      connection.exec('ROLLBACK');
      return false;
    }
    if (current?.status === 'running' && Date.parse(current.started_at) > timestamp.getTime() - STALE_RUN_MS) {
      connection.exec('ROLLBACK');
      return false;
    }
    if (current) {
      connection.prepare(`UPDATE daily_blog_runs SET status = 'running', attempts = attempts + 1,
        started_at = ?, finished_at = NULL, next_retry_at = NULL, message = '' WHERE run_date = ?`).run(timestamp.toISOString(), runDate);
    } else {
      connection.prepare(`INSERT INTO daily_blog_runs (run_date, status, attempts, started_at)
        VALUES (?, 'running', 1, ?)`).run(runDate, timestamp.toISOString());
    }
    connection.exec('COMMIT');
    return true;
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
}

function saveDailyTopics(database, runDate, candidates, timestamp) {
  const connection = database.connection;
  const topics = candidates.map((candidate) => ({
    id: randomUUID(), title: candidate.category,
    brief: `${candidate.title}\n\n${candidate.brief}`,
    keywords: candidate.keywords, active: true,
    createdAt: timestamp.toISOString(), updatedAt: timestamp.toISOString(),
  }));
  connection.exec('BEGIN IMMEDIATE');
  try {
    for (const topic of topics) database.createTopic(topic);
    connection.prepare('UPDATE daily_blog_runs SET topics_json = ? WHERE run_date = ?')
      .run(JSON.stringify(topics.map((topic) => ({ ...topic, active: undefined }))), runDate);
    connection.exec('COMMIT');
    return topics;
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
}

function articleAlreadyRecorded(database, runDate, slot) {
  return database.connection.prepare('SELECT article_id FROM daily_blog_items WHERE run_date = ? AND slot = ?').get(runDate, slot)?.article_id;
}

function retryAtFor(timestamp, results) {
  const temporaryFailure = results.some((item) => item.status === 'failed'
    && ['rate_limited', 'network_error', 'upstream_error', 'gateway_timeout'].includes(item.errorCode));
  return temporaryFailure
    ? new Date(timestamp.getTime() + 15 * 60 * 1000).toISOString()
    : nextDailyOccurrence(timestamp).toISOString();
}

function publishDailyArticle(database, runDate, slot, topic, draft, timestamp) {
  const connection = database.connection;
  const articleId = randomUUID();
  const slug = (draft.slug || draft.title).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72) || 'article';
  connection.exec('BEGIN IMMEDIATE');
  try {
    const already = connection.prepare('SELECT article_id FROM daily_blog_items WHERE run_date = ? AND slot = ?').get(runDate, slot);
    if (already) {
      connection.exec('ROLLBACK');
      return already.article_id;
    }
    database.createArticle({
      id: articleId, topicId: topic.id, title: draft.title, slug: `${slug}-${articleId.slice(0, 8)}`,
      excerpt: draft.excerpt, body: draft.body, imageAltText: draft.imageAltText,
      metaDescription: draft.metaDescription, suggestedKeywords: draft.suggestedKeywords,
      status: 'draft', generatedBy: 'gemini-daily-automation', scheduledAt: null,
      publishedAt: null, createdAt: timestamp.toISOString(), updatedAt: timestamp.toISOString(),
    });
    const published = database.publishArticle(articleId, timestamp.toISOString());
    if (!published || published.status !== 'published') throw new Error('publication_failed');
    connection.prepare(`INSERT INTO daily_blog_items (run_date, slot, topic_id, article_id, published_at)
      VALUES (?, ?, ?, ?, ?)`).run(runDate, slot, topic.id, articleId, timestamp.toISOString());
    connection.exec('COMMIT');
    return articleId;
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
}

async function withRetries(operation, { attempts = 3, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      const retryable = error?.code !== 'gateway_timeout'
        && (error?.status === 429 || error?.status >= 500 || error?.code === 'network_error' || error?.code === 'upstream_error');
      if (!retryable || attempt >= attempts) throw error;
      await delay(250 * (2 ** (attempt - 1)));
    }
  }
}

export async function runDailyBlogAutomation(database, provider, now = new Date(), { logger = console, retry = withRetries } = {}) {
  const timestamp = now instanceof Date ? now : new Date(now);
  const runDate = karachiDateKey(timestamp);
  if (!claimDailyRun(database, runDate, timestamp)) return { runDate, skipped: true };
  const connection = database.connection;
  const results = [];

  try {
    let topics = JSON.parse(connection.prepare('SELECT topics_json FROM daily_blog_runs WHERE run_date = ?').get(runDate).topics_json);
    if (!topics.length) {
      const existingTopics = database.listTopics();
      const existingArticles = connection.prepare('SELECT title, excerpt AS brief FROM articles ORDER BY created_at DESC').all();
      const ideas = await retry(() => provider.generateTopics({ existingTopics: [...existingTopics, ...existingArticles] }));
      topics = saveDailyTopics(database, runDate, ideas, timestamp);
    }

    for (let index = 0; index < 2; index += 1) {
      const slot = index + 1;
      if (articleAlreadyRecorded(database, runDate, slot)) {
        results.push({ slot, status: 'already_published' });
        continue;
      }
      try {
        const topic = database.getTopic(topics[index].id);
        if (!topic) throw new Error('topic_missing');
        const draft = await retry(() => provider.generate({ topic }));
        const articleId = publishDailyArticle(database, runDate, slot, topic, draft, timestamp);
        logger.info?.(`Daily blog automation published article ${slot} for ${runDate}.`);
        results.push({ slot, status: 'published', articleId });
      } catch (error) {
        logger.error?.(`Daily blog automation failed for ${runDate}, article ${slot}: ${error?.code || 'generation_error'}.`);
        results.push({ slot, status: 'failed', errorCode: error?.code || 'generation_error' });
      }
    }

    const publishedCount = connection.prepare('SELECT COUNT(*) AS count FROM daily_blog_items WHERE run_date = ?').get(runDate).count;
    const status = publishedCount === 2 ? 'completed' : publishedCount ? 'partial' : 'failed';
    const retryAt = status === 'completed' ? null : retryAtFor(timestamp, results);
    connection.prepare('UPDATE daily_blog_runs SET status = ?, finished_at = ?, next_retry_at = ?, message = ? WHERE run_date = ?')
      .run(status, new Date().toISOString(), retryAt, status === 'completed' ? 'Both daily articles were published.' : `${publishedCount} of 2 daily articles were published.`, runDate);
    return { runDate, status, results };
  } catch (error) {
    const retryAt = retryAtFor(timestamp, [{ status: 'failed', errorCode: error?.code || 'generation_error' }]);
    connection.prepare(`UPDATE daily_blog_runs SET status = 'failed', finished_at = ?, next_retry_at = ?, message = ? WHERE run_date = ?`)
      .run(new Date().toISOString(), retryAt, 'Topic selection or daily run setup failed.', runDate);
    logger.error?.(`Daily blog automation setup failed for ${runDate}: ${error?.code || 'generation_error'}.`);
    return { runDate, status: 'failed', errorCode: error?.code || 'generation_error', results };
  }
}

export function createBlogScheduler({
  database, provider, intervalMs = 30_000, logger = console,
  clock = () => new Date(), setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
}) {
  let timer;
  let dailyTimer;
  let retryTimer;
  let running = false;

  async function tick(now = clock(), { runDaily = false } = {}) {
    if (running) return { skipped: true };
    running = true;
    try {
      const published = publishDueArticles(database, now);
      const automations = await runDueAutomations(database, provider, now);
      const daily = runDaily && isAfterDailyTime(now)
        ? await runDailyBlogAutomation(database, provider, now, { logger })
        : { skipped: true, nextRunAt: nextDailyOccurrence(now).toISOString() };
      return { published, automations, daily };
    } finally {
      running = false;
    }
  }

  function scheduleDaily() {
    if (!timer) return;
    const next = nextDailyOccurrence(clock());
    dailyTimer = setTimeoutFn(async () => {
      try { await runDailyBlogAutomation(database, provider, clock(), { logger }); }
      catch (error) { logger.error?.(`Daily blog automation failed: ${error?.code || 'generation_error'}.`); }
      scheduleDailyRetry();
      scheduleDaily();
    }, Math.max(0, next.getTime() - clock().getTime()));
    dailyTimer.unref?.();
  }

  function scheduleDailyRetry(minDelayMs = 0) {
    if (!timer) return;
    if (retryTimer) clearTimeoutFn(retryTimer);
    const runDate = karachiDateKey(clock());
    const row = database.connection.prepare('SELECT MIN(next_retry_at) AS next_retry_at FROM daily_blog_runs WHERE run_date = ?').get(runDate);
    const retryAt = Date.parse(row?.next_retry_at || '');
    if (!Number.isFinite(retryAt)) { retryTimer = undefined; return; }
    const delay = Math.max(minDelayMs, retryAt - clock().getTime());
    retryTimer = setTimeoutFn(async () => {
      retryTimer = undefined;
      let result;
      try { result = await runDailyBlogAutomation(database, provider, clock(), { logger }); }
      catch (error) { logger.error?.(`Daily blog retry failed: ${error?.code || 'generation_error'}.`); }
      scheduleDailyRetry(result?.skipped ? intervalMs : 0);
    }, delay);
    retryTimer.unref?.();
  }

  return {
    tick,
    get isRunning() { return Boolean(timer); },
    start() {
      if (timer) return;
      void tick(clock(), { runDaily: true }).then(() => scheduleDailyRetry()).catch(() => logger.error('Blog scheduler tick failed.'));
      timer = setIntervalFn(() => { void tick().catch(() => logger.error('Blog scheduler tick failed.')); }, intervalMs);
      timer.unref?.();
      scheduleDaily();
      scheduleDailyRetry();
    },
    stop() {
      if (timer) clearIntervalFn(timer);
      if (dailyTimer) clearTimeoutFn(dailyTimer);
      if (retryTimer) clearTimeoutFn(retryTimer);
      timer = undefined;
      dailyTimer = undefined;
      retryTimer = undefined;
    },
  };
}

