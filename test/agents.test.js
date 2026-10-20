import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const savedAgentId = 'agent_68f49f5482e04fa9bedf640ff5689fd30d8f99d1bada487ba2';
const mockedApiKey = 'sk-test-this-must-never-appear-in-output';

test('Agents CLI reuses the saved agent, applies only session overrides, and streams mocked events', async (t) => {
  const curl = spawnSync('curl.exe', ['--version'], { windowsHide: true, encoding: 'utf8' });
  if (curl.error?.code === 'ENOENT') {
    t.skip('The CLI uses curl.exe directly; this integration test requires curl.exe.');
    return;
  }

  let createPayload;
  let createHeaders;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;

    if (req.method === 'POST' && req.url === '/v1/agents/sessions') {
      createPayload = body;
      createHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end([
        'data: {"type":"agent.session.turn.output_text.delta","delta":"Please share a topic."}',
        '',
        'data: {"type":"agent.session.turn.completed","session_id":"sess_mock","turn":{"subagent_id":null}}',
        '',
        '',
      ].join('\n'));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Unexpected mock route.' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const child = spawn(process.execPath, ['src/agents/cli.js', '--once'], {
    cwd: projectRoot,
    windowsHide: true,
    env: {
      ...process.env,
      OPENAI_API_KEY: mockedApiKey,
      OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OPENAI_PROJECT_ID: 'proj_mock',
      OPENAI_AGENT_ID: savedAgentId,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  child.stdin.end();

  const timeout = setTimeout(() => child.kill(), 15_000);
  const [exitCode] = await once(child, 'close');
  clearTimeout(timeout);

  assert.equal(exitCode, 0, `${errors}\n${output}`);
  assert.equal(createPayload.agent_id, savedAgentId);
  assert.equal(createHeaders.authorization, `Bearer ${mockedApiKey}`);
  assert.equal(createHeaders['openai-project'], 'proj_mock');
  assert.deepEqual(createPayload.environment, { type: 'none' });
  assert.equal(createPayload.stream, true);
  assert.equal(createPayload.agent.model, 'gpt-6-astra');
  assert.equal(createPayload.agent.reasoning.effort, 'medium');
  assert.equal(createPayload.agent.reasoning.summary, 'auto');
  assert.equal(createPayload.agent.text.verbosity, 'medium');
  assert.equal(createPayload.agent.instructions.includes('Never publish a blog automatically'), true);
  assert.equal(Object.hasOwn(createPayload.agent, 'tools'), false);
  assert.match(createPayload.input, /ask me for the topic first/i);
  assert.match(output, /Please share a topic\./);
  assert.match(output, /Session ID: sess_mock/);
  assert.equal(output.includes(mockedApiKey), false);
  assert.equal(errors.includes(mockedApiKey), false);
});

