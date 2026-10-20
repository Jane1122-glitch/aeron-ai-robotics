import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBlogDatabase } from './src/blog/database.js';
import { createGeminiBlogProvider } from './src/blog/providers/gemini.js';
import { generateGeminiContent } from './src/gemini.js';
import { createBlogScheduler } from './src/blog/scheduler.js';
import { createBlogRouter } from './src/blog/routes.js';

const app = express();
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';
const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const apiKey = process.env.GEMINI_API_KEY;
const root = path.dirname(fileURLToPath(import.meta.url));
const allowedTypes = new Set(['social', 'email', 'outline', 'summary']);

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data: https://images.unsplash.com https://www.nom.nl https://alumni.ntnu.edu.tw https://media-hp.technikum-wien.at; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
  });
  next();
});
app.use(express.json({ limit: '32kb', type: 'application/json' }));

// Serve only the public website files; never expose the project directory or .env.
app.get(['/', '/index.html'], (_req, res) => res.sendFile(path.join(root, 'index.html')));
app.get('/styles.css', (_req, res) => res.sendFile(path.join(root, 'styles.css')));
app.get('/script.js', (_req, res) => res.sendFile(path.join(root, 'script.js')));

const blogDatabasePath = process.env.BLOG_DB_PATH || path.join(root, 'data', 'blog.sqlite');
const blogDatabase = createBlogDatabase(blogDatabasePath);
const blogProvider = createGeminiBlogProvider({ apiKey, model });
const blogScheduler = createBlogScheduler({ database: blogDatabase, provider: blogProvider });
app.use('/api/blog', createBlogRouter({
  database: blogDatabase,
  provider: blogProvider,
  adminToken: process.env.BLOG_ADMIN_TOKEN,
  scheduler: blogScheduler,
}));

const requestTimes = new Map();
app.post('/api/generate', (req, res, next) => {
  const origin = req.get('origin');
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (parsed.host !== req.get('host')) return res.status(403).json({ error: 'Request origin was not accepted.' });
    } catch {
      return res.status(403).json({ error: 'Request origin was not accepted.' });
    }
  }

  const now = Date.now();
  const address = req.ip;
  const recent = (requestTimes.get(address) || []).filter((time) => now - time < 60_000);
  if (recent.length >= 10) return res.status(429).json({ error: 'You have made several requests. Please wait a minute and try again.' });
  recent.push(now);
  requestTimes.set(address, recent);
  if (requestTimes.size > 500) requestTimes.clear();

  const { type, prompt } = req.body ?? {};
  if (!allowedTypes.has(type)) return res.status(400).json({ error: 'Choose one of the available content types.' });
  if (typeof prompt !== 'string' || prompt.trim().length < 10 || prompt.trim().length > 2000) {
    return res.status(400).json({ error: 'Please enter a brief between 10 and 2,000 characters.' });
  }
  if (!apiKey) return res.status(503).json({ error: 'The AI service is not configured yet. Add GEMINI_API_KEY to your local .env file and restart the server.' });
  next();
}, async (req, res) => {
  const formats = {
    social: 'a concise social media post',
    email: 'a clear, personable email draft with a subject line',
    outline: 'a practical article outline with useful section headings',
    summary: 'a concise summary in plain language',
  };
  try {
    const text = await generateGeminiContent({
      apiKey,
      model,
      systemInstruction: `You are a careful writing assistant. Create ${formats[req.body.type]} based on the user's brief. Follow the brief, avoid unsupported factual claims, and return only the draft.`,
      prompt: req.body.prompt.trim(),
      maxOutputTokens: 700,
    });
    if (!text) return res.status(502).json({ error: 'The AI service did not return a text draft. Please try again.' });
    res.json({ text });
  } catch (error) {
    const status = Number(error?.status);
    if (status === 429) return res.status(429).json({ error: 'The AI service is busy or the API project has reached a usage limit. Try again shortly.' });
    if (status === 401 || status === 403) return res.status(502).json({ error: 'The API key was not accepted. Check GEMINI_API_KEY in your .env file.' });
    if (status >= 400 && status < 500) return res.status(502).json({ error: 'The AI service could not process this request. Please revise the brief and try again.' });
    console.error('Gemini request failed:', status || 'network error');
    res.status(502).json({ error: 'We could not reach the AI service. Check your connection and try again.' });
  }
});

app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large. Please shorten your brief.' });
  if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'Please submit a valid request.' });
  console.error('Server request failed:', error?.status || 'unexpected error');
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const httpServer = app.listen(port, host, () => {
  console.log(`AERON website available at http://${host}:${port}`);
  if (!apiKey) console.log('GEMINI_API_KEY is not configured. Add it to .env to enable generation.');
  if (!process.env.BLOG_ADMIN_TOKEN || process.env.BLOG_ADMIN_TOKEN.length < 32) {
    console.log('Blog management API is disabled until BLOG_ADMIN_TOKEN is configured (32+ characters).');
  }
  console.log(`Blog database: ${blogDatabasePath}`);
  blogScheduler.start();
});

function shutdown() {
  blogScheduler.stop();
  httpServer.close(() => blogDatabase.close());
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

