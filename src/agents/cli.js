import 'dotenv/config';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomUUID } from 'node:crypto';

const apiKey = process.env.OPENAI_API_KEY;
const projectId = process.env.OPENAI_PROJECT_ID || 'proj_pJCRBi4iy1ebI6fIqCQJOlbe';
const agentId = process.env.OPENAI_AGENT_ID || 'agent_68f49f5482e04fa9bedf640ff5689fd30d8f99d1bada487ba2';
const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const agentOverrides = {
  model: 'gpt-6-astra',
  instructions: `You are a helpful blog-writing assistant.

Your job is to write clear, informative, and engaging blog posts based on the topic provided by the user.

Follow these rules:

1. Ask for the blog topic if the user has not provided one.
2. Write a clear and relevant title.
3. Organize the blog using headings and short paragraphs.
4. Use simple, natural English.
5. Include an introduction, main content, and conclusion.
6. Never publish a blog automatically. Only generate a draft for the user to review.
`,
  reasoning: { effort: 'medium', summary: 'auto' },
  text: { format: { type: 'text' }, verbosity: 'medium' },
};

if (!apiKey || apiKey === 'your_api_key_here') {
  console.error('OPENAI_API_KEY is missing. Add it to .env or your environment before starting.');
  process.exit(1);
}

function curl(args, { input, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('curl.exe', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      onStdout?.(chunk);
    });
    child.stderr.on('data', (chunk) => { errors += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(extractApiError(output) || errors.trim() || `curl exited with code ${code}`));
    });
    child.stdin.end(input ?? '');
  });
}

function headers() {
  return [
    '-H', 'OpenAI-Beta: agents=v1',
    '--variable', '%OPENAI_API_KEY%',
    '--expand-header', 'Authorization: Bearer {{OPENAI_API_KEY}}',
    '-H', `OpenAI-Project: ${projectId}`,
  ];
}

function redactSecrets(value) {
  return String(value)
    .replaceAll(apiKey, '[redacted API key]')
    .replace(/sk-(?:proj-)?[A-Za-z0-9_*.-]{8,}/g, '[redacted API key]');
}

function extractApiError(raw) {
  const body = raw.match(/\r?\n\r?\n([\s\S]*)$/)?.[1] || raw;
  try {
    const parsed = JSON.parse(body);
    return redactSecrets(parsed.error?.message || parsed.message || '');
  } catch {
    return '';
  }
}

function parseSseBlock(block) {
  const eventLine = block.split(/\r?\n/).find((line) => line.startsWith('event:'));
  const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
  if (!data || data === '[DONE]') return null;
  try {
    const payload = JSON.parse(data);
    return { type: payload.type || eventLine?.slice(6).trim() || 'event', payload };
  } catch {
    return { type: eventLine?.slice(6).trim() || 'event', payload: { data } };
  }
}

function handleEvent({ type, payload }) {
  console.log(`\n[event] ${type}`);
  if (type === 'error') throw new Error(redactSecrets(payload.error?.message || JSON.stringify(payload)));
  if (type === 'agent.session.failed' || type === 'agent.session.environment.failed') {
    throw new Error(redactSecrets(payload.error?.message || `Agent lifecycle failure: ${type}`));
  }
  if (type === 'agent.session.turn.failed' && payload.turn?.subagent_id == null) {
    throw new Error(redactSecrets(payload.turn?.error?.message || 'The agent turn failed.'));
  }
  if (type === 'agent.session.turn.cancelled' && payload.turn?.subagent_id == null) {
    throw new Error('The agent turn was cancelled.');
  }
  if (type === 'agent.session.requires_action') {
    console.log(JSON.stringify(payload.required_actions || payload, null, 2));
    throw new Error('The session requested an external action, but this app has no custom function tools or self-hosted executor configured.');
  }

  const delta = payload.delta || payload.text || payload.item?.text;
  if (typeof delta === 'string' && delta) stdout.write(delta);
  if (type.includes('tool') || type.includes('required_action')) console.log(JSON.stringify(payload, null, 2));
  if (type === 'agent.session.turn.completed') console.log('\n\n[turn complete]');
}

async function createSession(initialInput) {
  let buffer = '';
  let sessionId = null;
  let eventFailure = null;
  await curl([
    '--no-buffer', '--fail-with-body', `${baseUrl}/agents/sessions`,
    ...headers(), '-H', 'Content-Type: application/json', '-d', '@-',
  ], {
    input: JSON.stringify({
      agent_id: agentId,
      agent: agentOverrides,
      environment: { type: 'none' },
      input: initialInput,
      stream: true,
    }),
    onStdout(chunk) {
      buffer += chunk;
      let boundary;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
        const event = parseSseBlock(block);
        if (event) {
          sessionId ||= event.payload.session?.id || event.payload.session_id || null;
          try { handleEvent(event); } catch (error) { eventFailure = error; }
        }
      }
    },
  });
  if (eventFailure) throw eventFailure;
  return sessionId;
}

async function submitAndStream(sessionId, message) {
  const stream = spawn('curl.exe', [
    '--no-buffer', '--include', '--fail-with-body', `${baseUrl}/agents/sessions/${encodeURIComponent(sessionId)}/events?stream=true`,
    ...headers(), '-H', 'Accept: text/event-stream',
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let streamBuffer = '';
  let headerBuffer = '';
  let connected = false;
  let eventFailure = null;
  let streamError = '';
  let resolveHeaders;
  let rejectHeaders;
  const ready = new Promise((resolve, reject) => { resolveHeaders = resolve; rejectHeaders = reject; });
  const streamFinished = new Promise((resolve, reject) => {
    stream.on('close', (code) => {
      if (eventFailure) reject(eventFailure);
      else if (code === 0) resolve();
      else reject(new Error(streamError.trim() || `Event stream exited with code ${code}`));
    });
  });

  stream.stdout.setEncoding('utf8');
  stream.stderr.setEncoding('utf8');
  stream.stderr.on('data', (chunk) => { streamError += chunk; });
  stream.stdout.on('data', (chunk) => {
    if (!connected) {
      headerBuffer += chunk;
      const end = headerBuffer.search(/\r?\n\r?\n/);
      if (end === -1) return;
      const header = headerBuffer.slice(0, end);
      chunk = headerBuffer.slice(end).replace(/^\r?\n\r?\n/, '');
      connected = true;
      if (!/ 2\d\d /.test(`${header} `)) {
        rejectHeaders(new Error(extractApiError(chunk) || header.split(/\r?\n/)[0]));
        stream.kill();
        return;
      }
      resolveHeaders();
    }
    streamBuffer += chunk;
    let boundary;
    while ((boundary = streamBuffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = streamBuffer.slice(0, boundary);
      streamBuffer = streamBuffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
      const event = parseSseBlock(block);
      if (event) {
        try { handleEvent(event); } catch (error) { eventFailure = error; stream.kill(); }
      }
    }
  });
  stream.on('error', rejectHeaders);
  stream.on('close', () => {
    if (!connected) rejectHeaders(new Error(streamError.trim() || 'Could not open the session event stream.'));
  });

  try {
    await ready;
    await curl([
      '--fail-with-body', `${baseUrl}/agents/sessions/${encodeURIComponent(sessionId)}/events`,
      ...headers(), '-H', 'Content-Type: application/json', '-H', `Idempotency-Key: ${randomUUID()}`,
      '-d', JSON.stringify({ events: [{
        type: 'agent.session.input.message',
        input: [{ role: 'user', content: [{ type: 'input_text', text: message }] }],
      }] }),
    ]);
    await streamFinished;
  } catch (error) {
    stream.kill();
    throw error;
  }
}

console.log('Starting AI Blog Assistant session with the saved agent and session-only overrides...');
console.log(`Project: ${projectId}`);
console.log(`Saved agent: ${agentId}`);
let sessionId;
try {
  sessionId = await createSession('Hi! I would like help drafting a blog post. Please ask me for the topic first.');
  if (!sessionId) throw new Error('The API stream completed without returning a session ID.');
  console.log(`\nSession ID: ${sessionId}`);
} catch (error) {
  console.error(`\nCould not start the Agents API session: ${redactSecrets(error.message)}`);
  process.exit(1);
}

if (process.argv.includes('--once')) process.exit(0);

const readline = createInterface({ input: stdin, output: stdout });
console.log('\nType a message to continue this session. Enter /exit to quit.');
try {
  while (true) {
    const message = await readline.question('\nYou: ');
    if (message.trim().toLowerCase() === '/exit') break;
    if (!message.trim()) continue;
    try { await submitAndStream(sessionId, message.trim()); }
    catch (error) { console.error(`\nSession request failed: ${redactSecrets(error.message)}`); }
  }
} finally {
  readline.close();
}

