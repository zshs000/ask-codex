'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { readMatching, isRetryableError, settings, McpClient } = require('../ask-codex.cjs');

const CLI = path.resolve(__dirname, '../ask-codex.cjs');
const THREAD = '11111111-1111-4111-8111-111111111111';
const REQUEST = 'ask-codex-22222222-2222-4222-8222-222222222222';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const snapshot = (turns, nextCursor = null) => ({ thread: { status: { type: 'idle' } }, turns, page: { nextCursor } });
const target = status => ({ id: 'target-turn', status, items: [] });

async function fixture(t, initial = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-codex-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbFile = path.join(root, 'db.json');
  fs.writeFileSync(dbFile, JSON.stringify({ busy: false, sent: [], ...initial }));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir);
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ stateDir, pollSeconds: 1 }));
  // Discovery remains enabled in production; tests expose a private dummy pipe
  // on Windows so no running desktop app is required for the fake MCP process.
  const pipePath = process.platform === 'win32' ? '\\\\.\\pipe\\codex-app-tools-' + randomUUID() : path.join(root, 'unused.sock');
  if (process.platform === 'win32') {
    const server = net.createServer(socket => socket.end());
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipePath, resolve); });
    t.after(() => new Promise(resolve => server.close(resolve)));
  }
  const env = { ...process.env, CODEX_APP_SERVER_PATH: path.join(__dirname, 'fixtures/mcp.cjs'),
    CODEX_MCP_NODE_PATH: process.execPath, CODEX_APP_TOOLS_PIPE_PATH: pipePath,
    ASK_CODEX_STATE_DIR: stateDir, ASK_CODEX_TEST_DB: dbFile };
  const children = [];
  t.after(async () => { for (const child of children) if (child.exitCode === null) child.kill(); await Promise.all(children.map(child => child.done)); });
  function run(args, override = {}) {
    const child = spawn(process.execPath, [CLI, ...args, '--config', configFile], { env: { ...env, ...override }, windowsHide: true });
    child.out = ''; child.err = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', text => child.out += text);
    child.stderr.on('data', text => child.err += text);
    child.done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Test process timed out: ${child.err}`)); }, 15000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); resolve({ code, stdout: child.out, stderr: child.err }); });
    });
    children.push(child); return child;
  }
  function writeRecord(status, extra = {}) {
    const record = { requestId: REQUEST, threadId: THREAD, sourceThreadId: THREAD, turnId: 'target-turn', status, ...extra };
    fs.writeFileSync(path.join(stateDir, REQUEST + '.json'), JSON.stringify(record));
  }
  return { root, env, run, writeRecord, stateDir, dbFile,
    db: () => JSON.parse(fs.readFileSync(dbFile, 'utf8')) };
}

async function waitFor(check, description) {
  const until = Date.now() + 8000;
  while (!check()) { if (Date.now() > until) throw new Error('Timed out waiting for ' + description); await delay(25); }
}

test('concurrent resume re-reads state after lock and dispatches only once', { timeout: 15000 }, async t => {
  const f = await fixture(t, { busy: true });
  const owner = f.run([THREAD, 'test message']);
  await waitFor(() => owner.err.includes('Target has an active turn'), 'owner waiting');
  const requestId = owner.err.match(/request=(ask-codex-[0-9a-f-]+)/)[1];
  const follower = f.run(['--resume', requestId]);
  await waitFor(() => follower.err.includes('Thread busy'), 'resume waiting for lock');
  const record = JSON.parse(fs.readFileSync(path.join(f.stateDir, requestId + '.json'), 'utf8'));
  assert.equal(record.status, 'prepared');
  const data = f.db(); data.busy = false;
  const tmp = f.dbFile + '.test.tmp'; fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, f.dbFile);
  const results = await Promise.all([owner.done, follower.done]);
  assert.equal(f.db().sent.length, 1);
  for (const result of results) { assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout, 'fixture reply\n'); }
});

test('missing target is a permanent error and exits after one read', async t => {
  const f = await fixture(t, { error: 'missing' }); f.writeRecord('running');
  const result = await f.run(['--resume', REQUEST]).done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /No Codex thread found/);
  assert.equal(f.db().reads, 1);
  assert.equal(f.db().sent.length, 0);
});

test('a transient connection error reconnects and continues the same request', async t => {
  const f = await fixture(t, { error: 'transient', turnId: 'target-turn', requestId: REQUEST }); f.writeRecord('running');
  const result = await f.run(['--resume', REQUEST]).done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'fixture reply\n');
  assert.equal(f.db().reads, 2);
  assert.equal(f.db().sent.length, 0);
});

test('completed resume returns cached reply without plugin or connection', async t => {
  const f = await fixture(t); f.writeRecord('completed', { reply: 'cached reply' });
  const result = await f.run(['--resume', REQUEST, '--json'], { CODEX_APP_SERVER_PATH: path.join(f.root, 'missing-server'), CODEX_APP_TOOLS_PIPE_PATH: 'not-a-real-pipe' }).done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).reply, 'cached reply');
  assert.equal(f.db().reads, undefined);
});

test('interrupted requests fail offline and a new request can use the same thread', async t => {
  const f = await fixture(t); f.writeRecord('interrupted', { error: 'user stopped' });
  const old = await f.run(['--resume', REQUEST], { CODEX_APP_SERVER_PATH: path.join(f.root, 'missing') }).done;
  assert.equal(old.code, 1); assert.match(old.stderr, /user stopped/);
  const fresh = await f.run([THREAD, 'new task after stop']).done;
  assert.equal(fresh.code, 0, fresh.stderr); assert.equal(f.db().sent.length, 1);
});

test('bound turn is found beyond the latest ten turns', async () => {
  const calls = [];
  const client = { async tool(name, args) { calls.push(args); return args.cursor ? snapshot([target('completed')]) : snapshot(Array.from({ length: 10 }, (_, i) => ({ id: 'newer-' + i })), 'older'); } };
  const result = await readMatching(client, { threadId: THREAD, turnId: 'target-turn', sourceThreadId: THREAD });
  assert.equal(result.turn.status, 'completed'); assert.equal(calls.length, 2); assert.equal(calls[1].cursor, 'older');
});

test('missing bound turn and repeated cursor fail rather than wait forever', async () => {
  await assert.rejects(readMatching({ tool: async () => snapshot([]) }, { turnId: 'missing', threadId: THREAD }), /was not found/);
  await assert.rejects(readMatching({ tool: async () => snapshot([{ id: 'other' }], 'same') }, { turnId: 'missing', threadId: THREAD }), /repeated history cursor/);
});

test('history search limit is bounded and leaves an unbound request retryable', async () => {
  let calls = 0;
  const client = { tool: async () => { calls++; return snapshot(Array.from({ length: 10 }, (_, i) => ({ id: String(i) })), String(calls)); } };
  await assert.rejects(readMatching(client, { turnId: 'missing', threadId: THREAD }, 20), /searching 20 turns/);
  assert.equal(calls, 2);
  const notVisible = await readMatching({ tool: async () => snapshot([]) }, { requestId: REQUEST, threadId: THREAD });
  assert.equal(notVisible.turn, null);
});

test('oversized history falls back to one turn; an oversized single turn is fatal', async () => {
  const limits = [];
  const client = { async tool(name, args) { limits.push(args.turnLimit); if (args.turnLimit > 1) throw new Error('response exceeds the size limit'); return snapshot([target('completed')]); } };
  const result = await readMatching(client, { turnId: 'target-turn', threadId: THREAD });
  assert.equal(result.turn.id, 'target-turn'); assert.deepEqual(limits, [10, 1]);
  await assert.rejects(readMatching({ tool: async () => { throw new Error('response exceeds the size limit'); } }, { turnId: 'target-turn', threadId: THREAD }), error => error.fatal === true);
});

test('protocol errors are terminal while transport failures remain retryable', () => {
  for (const message of ['No Codex thread found', 'Unknown Codex app tool', 'Invalid JSON from Codex MCP']) assert.equal(isRetryableError(new Error(message)), false);
  assert.equal(isRetryableError(Object.assign(new Error('invalid params'), { rpcCode: -32602 })), false);
  assert.equal(isRetryableError(new Error('ECONNRESET')), true);
});

test('default records live in the user directory and UTF-8 output survives split chunks', () => {
  const previous = process.env.ASK_CODEX_STATE_DIR; delete process.env.ASK_CODEX_STATE_DIR;
  try { assert.equal(settings({}).stateDir, path.join(os.homedir(), '.ask-codex')); }
  finally { if (previous !== undefined) process.env.ASK_CODEX_STATE_DIR = previous; }
  const client = new McpClient({}); let answer;
  client.pending.set(1, { timer: setTimeout(() => {}, 1000), resolve: value => answer = value, reject: error => { throw error; } });
  const bytes = Buffer.from(JSON.stringify({ id: 1, result: { text: '中文 reply' } }) + '\n');
  for (let i = 0; i < bytes.length; i++) client.onData(bytes.subarray(i, i + 1));
  assert.equal(answer.text, '中文 reply');
});
