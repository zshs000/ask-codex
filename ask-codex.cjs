#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const net = require('node:net');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = text => process.stderr.write(`[ask-codex] ${text}\n`);
const THREAD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^ask-codex-[0-9a-f-]{36}$/i;
const fatalError = message => Object.assign(new Error(message), { fatal: true });
const help = `Usage:
  ask-codex <threadId> <message>
  ask-codex <threadId> --message-file <file>
  ask-codex <threadId> --stdin
  ask-codex --resume <requestId>
  ask-codex --status <requestId>
  ask-codex --steer <requestId> <message>
  ask-codex --stop <threadId>
  ask-codex --check

Options:
  --json                     Output result and request metadata as JSON
  --timeout-seconds <n>      Total wait limit; default 0 means no limit
  --poll-seconds <n>         Snapshot interval; default 3
  --source-thread <id>       Optional Codex source identity; default target thread
  --config <file>            Override config file

Progress goes to stderr. The final reply goes to stdout.
Keep the Codex desktop app open. Long messages can use stdin or a file.
`;

function parseArgs(argv) {
  const opts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { opts.positional.push(...argv.slice(i + 1)); break; }
    const flags = { '--help': 'help', '-h': 'help', '--json': 'json', '--stdin': 'stdin', '--check': 'check' };
    const values = { '--resume': 'resume', '--status': 'statusRequestId', '--steer': 'steerRequestId', '--stop': 'stopThreadId', '--message-file': 'messageFile', '--timeout-seconds': 'timeoutSeconds', '--poll-seconds': 'pollSeconds', '--source-thread': 'sourceThreadId', '--config': 'configPath' };
    if (flags[arg]) opts[flags[arg]] = true;
    else if (values[arg]) {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      opts[values[arg]] = argv[++i];
    } else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else opts.positional.push(arg);
  }
  return opts;
}

function settings(opts) {
  const configPath = path.resolve(opts.configPath || path.join(__dirname, 'config.json'));
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')) : {};
  const pollSeconds = Number(opts.pollSeconds ?? config.pollSeconds ?? 3);
  const timeoutSeconds = Number(opts.timeoutSeconds ?? 0);
  if (!Number.isFinite(pollSeconds) || pollSeconds < 1) throw new Error('--poll-seconds must be at least 1');
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) throw new Error('--timeout-seconds must be nonnegative');
  const historySearchLimit = Number(config.historySearchLimit ?? 1000);
  if (!Number.isInteger(historySearchLimit) || historySearchLimit < 10) throw new Error('historySearchLimit must be an integer of at least 10');
  return { ...config, pollSeconds, timeoutSeconds, historySearchLimit,
    stateDir: path.resolve(path.dirname(configPath), process.env.ASK_CODEX_STATE_DIR || config.stateDir || path.join(os.homedir(), '.ask-codex')),
    nodePath: process.env.CODEX_MCP_NODE_PATH || config.nodePath || process.execPath };
}

function findServer(config) {
  let serverPath = process.env.CODEX_APP_SERVER_PATH || config.serverPath;
  const codexHome = process.env.CODEX_HOME || config.codexHome || path.join(os.homedir(), '.codex');
  const root = path.join(codexHome, 'plugins', 'cache', 'openai-bundled', 'codex-app-tools');
  if (!serverPath && fs.existsSync(root)) {
    const versions = fs.readdirSync(root).filter(v => fs.existsSync(path.join(root, v, 'server.mjs'))).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (versions.length) serverPath = path.join(root, versions[0], 'server.mjs');
  }
  if (!serverPath || !fs.existsSync(serverPath)) throw fatalError('Codex app-tools server.mjs not found. Open the desktop app or set CODEX_APP_SERVER_PATH.');
  return path.resolve(serverPath);
}

function isRetryableError(error) {
  if (error.fatal || [-32600, -32601, -32602].includes(error.rpcCode)) return false;
  return /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|connection.*closed|pipe.*closed|process exited|timed out|timeout|not-connected|not-initialized|No live Codex app-tools pipe|Codex app tool request failed/i.test(error.message);
}

function discoverPipe(config) {
  // Windows exposes live named pipes through this directory. Prefer live
  // discovery over an inherited path which can become stale after app restart.
  if (process.platform === 'win32') {
    const pipes = fs.readdirSync('\\\\.\\pipe\\').filter(name => /^codex-app-tools-[0-9a-f-]+$/i.test(name));
    const explicit = process.env.CODEX_APP_TOOLS_PIPE_PATH || config.pipePath;
    if (explicit && pipes.some(name => explicit.endsWith(name))) return explicit;
    if (pipes.length === 1) return '\\\\.\\pipe\\' + pipes[0];
    if (pipes.length > 1) throw new Error('Multiple Codex app-tools pipes found. Set CODEX_APP_TOOLS_PIPE_PATH to the intended app.');
  }
  const pipe = process.env.CODEX_APP_TOOLS_PIPE_PATH || config.pipePath;
  if (pipe && process.platform !== 'win32') return pipe;
  throw new Error('No live Codex app-tools pipe found. Keep the Codex desktop app open.');
}

class McpClient {
  constructor(config) { this.config = config; this.pending = new Map(); this.nextId = 1; this.buffer = ''; this.decoder = new StringDecoder('utf8'); this.closed = false; }
  async connect() {
    this.serverPath = findServer(this.config);
    this.pipe = discoverPipe(this.config);
    this.child = spawn(this.config.nodePath, [this.serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: this.pipe }
    });
    this.child.stdout.on('data', chunk => this.onData(chunk));
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr || '') + chunk; this.stderr = this.stderr.slice(-2000); });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', code => this.fail(new Error(`Codex MCP process exited (${code})`)));
    this.child.stdin.on('error', error => this.fail(error));
    await this.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'ask-codex', version: '0.1.0' } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const listed = await this.request('tools/list', {});
    if (!['read_thread', 'send_message_to_thread'].every(name => listed.tools?.some(t => t.name === name))) throw new Error('Required Codex tools are unavailable.');
  }
  fail(error) {
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  onData(chunk) {
    this.buffer += this.decoder.write(chunk);
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let value;
      try { value = JSON.parse(line); } catch { this.fail(new Error('Invalid JSON from Codex MCP')); return; }
      const pending = this.pending.get(value.id);
      if (!pending) continue;
      clearTimeout(pending.timer); this.pending.delete(value.id);
      if (value.error) pending.reject(Object.assign(new Error(`MCP ${value.error.code}: ${value.error.message}`), { rpcCode: value.error.code }));
      else pending.resolve(value.result);
    }
  }
  request(method, params) {
    if (this.closed) return Promise.reject(new Error('Codex MCP connection is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} call timed out`)); }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async tool(name, args, sourceThreadId) {
    const result = await this.request('tools/call', { name, arguments: args, _meta: { threadId: sourceThreadId } });
    const content = result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (result.isError) throw new Error(content || `${name} failed`);
    try { return JSON.parse(content); } catch { throw new Error(`${name} returned an invalid result`); }
  }
  close() { this.fail(new Error('Closed')); if (this.child) { this.child.stdin.end(); this.child.kill(); } }
}

// The desktop stop button routes interrupts through the thread's owning client.
// Keep this adapter narrow: discovery plus an interrupt guarded by the turn ID.
class DesktopIpc {
  constructor() { this.pending = new Map(); this.buffer = Buffer.alloc(0); this.clientId = ''; }
  async connect() {
    if (process.platform !== 'win32') throw new Error('--stop currently requires Windows Node');
    this.socket = net.createConnection('\\\\.\\pipe\\codex-ipc');
    this.socket.on('data', chunk => this.onData(chunk));
    this.socket.on('error', error => this.fail(error));
    this.socket.on('close', () => this.fail(new Error('Codex desktop IPC closed')));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.socket.destroy(); reject(new Error('Codex desktop IPC connection timed out')); }, 5000);
      this.socket.once('connect', () => { clearTimeout(timer); resolve(); });
      this.socket.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const initialized = await this.request('initialize', { clientType: 'cli' }, 0);
    this.clientId = initialized.result.clientId;
  }
  send(message) {
    const bytes = Buffer.from(JSON.stringify(message));
    const frame = Buffer.alloc(4 + bytes.length);
    frame.writeUInt32LE(bytes.length, 0); bytes.copy(frame, 4);
    this.socket.write(frame);
  }
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > 16 * 1024 * 1024) { this.fail(new Error('Desktop IPC frame too large')); this.socket.destroy(); return; }
      if (this.buffer.length < length + 4) return;
      let message;
      try { message = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8')); }
      catch { this.fail(new Error('Invalid desktop IPC response')); this.socket.destroy(); return; }
      this.buffer = this.buffer.subarray(length + 4);
      if (message.type === 'client-discovery-request') {
        this.send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } }); continue;
      }
      const pending = this.pending.get(message.requestId);
      if (!pending) continue;
      clearTimeout(pending.timer); this.pending.delete(message.requestId);
      if (message.resultType === 'error') pending.reject(new Error(`Desktop IPC: ${message.error}`));
      else pending.resolve(message);
    }
  }
  request(method, params, version, targetClientId) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`Desktop ${method} timed out`)); }, 20000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send({ type: 'request', requestId, sourceClientId: this.clientId, version, method, params, targetClientId, timeoutMs: 20000 });
    });
  }
  fail(error) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
  close() { this.fail(new Error('Closed')); this.socket?.destroy(); }
}

async function stopThread(client, config, threadId, sourceThreadId) {
  if (!THREAD_ID.test(threadId)) throw new Error('Invalid --stop thread ID');
  const read = () => client.tool('read_thread', { threadId, hostId: 'local', turnLimit: 3, includeOutputs: false }, sourceThreadId || threadId);
  const before = await read();
  const turn = before.turns?.find(t => t.status === 'inProgress');
  if (before.thread.status.type !== 'active' || !turn) return { stopped: false, threadId, reason: 'No active turn' };
  const ipc = new DesktopIpc();
  try {
    await ipc.connect();
    const owner = await ipc.request('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, 1);
    // user-stop uses the same goal pause, interrupt, and cleanup path as the UI.
    const response = await ipc.request('thread-follower-interrupt-turn', {
      conversationId: threadId, mode: 'user-stop', expectedTurnId: turn.id
    }, 4, owner.handledByClientId);
    if (response.result?.interruptedTurnId !== turn.id) throw new Error('The active turn changed before interruption; no different turn was stopped.');
    for (let i = 0; i < 30; i++) {
      const after = await read();
      const ended = after.turns?.find(t => t.id === turn.id);
      if (ended?.status === 'interrupted') return { stopped: true, threadId, turnId: turn.id, status: ended.status, ...(response.result.goalPauseError ? { goalPauseError: response.result.goalPauseError } : {}) };
      if (ended?.status === 'completed') return { stopped: false, threadId, turnId: turn.id, reason: 'Turn completed before interruption was observed' };
      await sleep(500);
    }
    throw new Error('Interrupt accepted, but interrupted status was not observed within 15 seconds');
  } finally { ipc.close(); }
}

function loadRecord(config, requestId) {
  if (!REQUEST_ID.test(requestId)) throw new Error('Invalid request ID');
  return JSON.parse(fs.readFileSync(path.join(config.stateDir, requestId + '.json'), 'utf8'));
}

async function readMessage(opts) {
  const modes = Number(Boolean(opts.messageFile)) + Number(Boolean(opts.stdin)) + Number(opts.positional.length > 0);
  if (modes !== 1) throw new Error('Provide a message, --message-file, or --stdin');
  let message;
  if (opts.messageFile) message = fs.readFileSync(path.resolve(opts.messageFile), 'utf8').replace(/^\uFEFF/, '');
  else if (opts.stdin) { process.stdin.setEncoding('utf8'); message = ''; for await (const chunk of process.stdin) message += chunk; }
  else message = opts.positional.join(' ');
  if (!message.trim()) throw new Error('The message is empty');
  if (Buffer.byteLength(message) > 512 * 1024) throw new Error('Message exceeds 512 KiB');
  return message;
}

function turnMessages(turn) {
  return turn?.items?.filter(i => i.type === 'agentMessage' && typeof i.text === 'string')
    .map(i => ({ id: i.id, turnId: turn.id, phase: i.phase || 'message', text: i.text })) || [];
}

function captureMessages(config, record, turn) {
  const messages = turnMessages(turn);
  const known = new Map((record.messages || []).map(message => [message.id, message]));
  let changed = false;
  for (const message of messages) {
    const previous = known.get(message.id);
    if (previous?.text === message.text && previous.phase === message.phase) continue;
    known.set(message.id, message); changed = true;
    if (!['final_answer', 'final'].includes(message.phase) && message.text.trim()) {
      const delta = previous && message.text.startsWith(previous.text) ? message.text.slice(previous.text.length) : message.text;
      if (delta.trim()) log(`Codex ${message.phase}: ${delta.trim()}`);
    }
  }
  if (changed) { record.messages = [...known.values()]; saveRecord(config, record); }
}

async function requestStatus(client, config, requestId) {
  const record = loadRecord(config, requestId);
  const snapshot = await readMatching(client, record, config.historySearchLimit);
  return { requestId, threadId: record.threadId, turnId: snapshot.turn?.id || record.turnId,
    status: snapshot.turn?.status || record.status, threadStatus: snapshot.response.thread?.status,
    messages: snapshot.turn ? turnMessages(snapshot.turn) : record.messages || [],
    error: snapshot.turn?.error || record.error || null };
}

async function steerRequest(client, config, requestId, message) {
  const record = loadRecord(config, requestId);
  const snapshot = await readMatching(client, record, config.historySearchLimit);
  if (!snapshot.turn || snapshot.turn.status !== 'inProgress' || snapshot.response.thread.status.type !== 'active') throw new Error('This request has no active turn to steer. Start a new request for a follow-up.');
  const controlId = randomUUID();
  const filename = path.join(config.stateDir, requestId + '.controls.jsonl');
  const control = { controlId, requestId, turnId: snapshot.turn.id, message, time: new Date().toISOString() };
  fs.appendFileSync(filename, JSON.stringify({ ...control, status: 'sending' }) + '\n');
  // Do not acquire the waiter's lock: this input is intended for its active turn.
  const result = await client.tool('send_message_to_thread', { threadId: record.threadId, hostId: 'local',
    prompt: `来自 Claude，执行中补充\n请求编号：${requestId}\n\n${message}\n\n请结合这条补充继续当前任务。`
  }, record.sourceThreadId);
  fs.appendFileSync(filename, JSON.stringify({ ...control, status: 'sent' }) + '\n');
  return { sent: result.threadId === record.threadId, requestId, threadId: record.threadId, targetTurnId: snapshot.turn.id, controlId };
}

function saveRecord(config, record) {
  record.updatedAt = new Date().toISOString();
  const filename = path.join(config.stateDir, record.requestId + '.json');
  const temporary = filename + `.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(record, null, 2));
  fs.renameSync(temporary, filename);
}

async function lockThread(config, threadId, requestId, deadline) {
  const filename = path.join(config.stateDir, threadId + '.lock');
  for (;;) {
    if (deadline && Date.now() > deadline) throw new Error('Timed out waiting for this thread lock');
    try {
      fs.writeFileSync(filename, JSON.stringify({ pid: process.pid, requestId }), { flag: 'wx' });
      return () => {
        try { if (JSON.parse(fs.readFileSync(filename, 'utf8')).pid === process.pid) fs.unlinkSync(filename); } catch {}
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { throw new Error(`Unreadable thread lock: ${filename}`); }
      try { process.kill(owner.pid, 0); } catch (error) {
        if (error.code === 'ESRCH') { fs.unlinkSync(filename); continue; }
        if (error.code !== 'EPERM') throw error;
      }
      log(`Thread busy with ${owner.requestId}; waiting`);
      await sleep(3000);
    }
  }
}

function itemText(item) {
  if (item.type === 'userMessage') return item.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || '';
  if (item.type === 'functionCallOutput' && item.name === 'send_message_to_thread') return typeof item.output === 'string' ? item.output : item.output?.text || '';
  return '';
}

async function readMatching(client, record, searchLimit = 1000) {
  let cursor;
  let turnLimit = 10;
  let searched = 0;
  const cursors = new Set();
  for (;;) {
    let response;
    try {
      // Outputs are only needed for the request marker near the start of the sent prompt.
      // A short cap keeps output-heavy history under the read_thread response size limit.
      response = await client.tool('read_thread', {
        threadId: record.threadId, hostId: 'local', turnLimit,
        includeOutputs: true, maxOutputCharsPerItem: 300, ...(cursor ? { cursor } : {})
      }, record.sourceThreadId);
    } catch (error) {
      if (!/exceeds the size limit/i.test(error.message)) throw error;
      // Still too large: read one turn per call. A single turn over the limit is unreadable, so retrying cannot help.
      if (turnLimit === 1) throw Object.assign(new Error(`A turn in thread ${record.threadId} is too large for Codex read_thread; read it in the desktop app. (${error.message})`), { fatal: true });
      turnLimit = 1; continue;
    }
    const match = response.turns?.find(turn => record.turnId ? turn.id === record.turnId : turn.items?.some(item => itemText(item).includes(record.requestId)));
    if (match) return { response, turn: match };
    searched += response.turns?.length || turnLimit;
    const nextCursor = response.page?.nextCursor;
    if (searched >= searchLimit || !nextCursor) {
      if (record.turnId) throw fatalError(`Turn ${record.turnId} was not found in thread ${record.threadId} after searching ${searched} turns. Check the thread or increase historySearchLimit.`);
      return { response, turn: null };
    }
    if (cursors.has(nextCursor)) throw fatalError('Codex returned a repeated history cursor');
    cursors.add(nextCursor); cursor = nextCursor;
  }
}

function printResult(record, json) {
  const text = json ? JSON.stringify({ requestId: record.requestId, threadId: record.threadId, turnId: record.turnId, reply: record.reply }) : record.reply;
  process.stdout.write(text + (text.endsWith('\n') ? '' : '\n'));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(help); return; }
  if ([opts.resume, opts.statusRequestId, opts.steerRequestId, opts.stopThreadId, opts.check].filter(Boolean).length > 1) throw new Error('Use one action per invocation');
  const config = settings(opts);
  let client;
  let release;
  let record;
  const deadline = config.timeoutSeconds ? Date.now() + config.timeoutSeconds * 1000 : 0;
  try {
    if (opts.resume) {
      record = loadRecord(config, opts.resume);
      if (record.status === 'completed') { printResult(record, opts.json); return; }
      if (['failed', 'interrupted'].includes(record.status)) throw new Error(record.error || record.status);
    }
    client = new McpClient(config); await client.connect();
    if (opts.check) {
      process.stdout.write(JSON.stringify({ connected: true, serverPath: client.serverPath, pipePath: client.pipe, stateDir: config.stateDir }, null, 2) + '\n'); return;
    }
    if (opts.stopThreadId) {
      const result = await stopThread(client, config, opts.stopThreadId, opts.sourceThreadId);
      process.stdout.write(JSON.stringify(result) + '\n'); return;
    }
    if (opts.statusRequestId) {
      process.stdout.write(JSON.stringify(await requestStatus(client, config, opts.statusRequestId)) + '\n'); return;
    }
    if (opts.steerRequestId) {
      process.stdout.write(JSON.stringify(await steerRequest(client, config, opts.steerRequestId, await readMessage(opts))) + '\n'); return;
    }
    fs.mkdirSync(config.stateDir, { recursive: true });
    if (!opts.resume) {
      const threadId = opts.positional.shift();
      if (!THREAD_ID.test(threadId || '')) throw new Error('A valid target threadId is required. Use --help.');
      const message = await readMessage(opts);
      const sourceThreadId = opts.sourceThreadId || config.sourceThreadId || threadId;
      if (!THREAD_ID.test(sourceThreadId)) throw new Error('Invalid source thread ID');
      record = { requestId: 'ask-codex-' + randomUUID(), threadId, sourceThreadId, message, createdAt: new Date().toISOString(), status: 'prepared' };
      saveRecord(config, record);
    }
    log(`request=${record.requestId}`);
    log(`resume: ask-codex --resume ${record.requestId}`);
    log(`progress: ask-codex --status ${record.requestId}`);
    release = await lockThread(config, record.threadId, record.requestId, deadline);
    // The live owner may have dispatched or completed this request while we waited.
    // Read durable state only after acquiring the lock, before any sending decision.
    record = loadRecord(config, record.requestId);
    if (record.status === 'completed') { printResult(record, opts.json); return; }
    if (['failed', 'interrupted'].includes(record.status)) throw new Error(record.error || record.status);
    if (record.status === 'prepared') {
      // Avoid steering another active task. All bridge calls to this thread are serialized.
      let waitingLogged = false;
      for (;;) {
        if (deadline && Date.now() > deadline) throw new Error('Wait timed out before dispatch');
        const snapshot = await client.tool('read_thread', { threadId: record.threadId, hostId: 'local', turnLimit: 1, includeOutputs: false }, record.sourceThreadId);
        if (snapshot.thread?.kind !== 'codex') throw new Error('This prototype supports Codex threads');
        if (snapshot.thread.status?.type !== 'active') break;
        if (!waitingLogged) { log('Target has an active turn; waiting before sending'); waitingLogged = true; }
        await sleep(config.pollSeconds * 1000);
      }
      record.status = 'sending'; saveRecord(config, record);
      const prompt = `来自 Claude\n请求编号：${record.requestId}\n\n${record.message}\n\n请在本对话回答，回复由桥接程序读取。`;
      try {
        const result = await client.tool('send_message_to_thread', { threadId: record.threadId, hostId: 'local', prompt }, record.sourceThreadId);
        if (result.threadId !== record.threadId) throw new Error('Codex routed to a different thread');
      } catch (error) {
        record.status = 'dispatch_uncertain'; record.error = String(error); saveRecord(config, record);
        throw new Error(`Dispatch result is uncertain: ${error.message}. Resume to check the existing message; it will not be resent.`);
      }
      record.status = 'dispatched'; record.dispatchedAt = new Date().toISOString(); delete record.error; saveRecord(config, record);
      log(`Sent to ${record.threadId}; waiting for reply`);
    } else if (['sending', 'dispatch_uncertain'].includes(record.status)) {
      const match = await readMatching(client, record, config.historySearchLimit);
      if (!match.turn) throw new Error('Dispatch is uncertain and its request marker was not found. No message was resent.');
      record.turnId = match.turn.id; record.status = 'running'; saveRecord(config, record);
    }
    let errors = 0;
    let lastProgress = 0;
    for (;;) {
      if (deadline && Date.now() > deadline) throw new Error('Wait timed out; the Codex task continues. Resume with the same request ID.');
      let snapshot;
      try { snapshot = await readMatching(client, record, config.historySearchLimit); errors = 0; }
      catch (error) {
        if (!isRetryableError(error)) throw error;
        errors++;
        log(`Read failed: ${error.message}; retry ${errors}`);
        client.close();
        for (;;) {
          if (deadline && Date.now() > deadline) throw new Error('Wait timed out during reconnection; resume with the same request ID.');
          await sleep(3000);
          client = new McpClient(config);
          try { await client.connect(); break; }
          catch (error) {
            client.close();
            if (!isRetryableError(error)) throw error;
            log(`Reconnect failed: ${error.message}`);
          }
        }
        continue;
      }
      const turn = snapshot.turn;
      if (turn && !record.turnId) { record.turnId = turn.id; record.status = 'running'; saveRecord(config, record); log(`Matched turn=${turn.id}`); }
      if (turn) captureMessages(config, record, turn);
      if (turn?.status === 'completed') {
        const replies = turn.items?.filter(i => i.type === 'agentMessage' && ['final_answer', 'final'].includes(i.phase));
        if (!replies?.length) throw new Error('The turn completed without a final answer');
        if (replies.some(i => i.truncated === true || i.text?.truncated === true)) throw new Error('Codex returned a truncated final answer; read the complete answer in the desktop app.');
        record.reply = replies.map(i => i.text).join('\n\n'); record.status = 'completed'; record.completedAt = new Date().toISOString(); saveRecord(config, record);
        log('Completed'); printResult(record, opts.json); return;
      }
      if (['failed', 'interrupted'].includes(turn?.status)) {
        record.status = turn.status; record.error = typeof turn.error === 'string' ? turn.error : JSON.stringify(turn.error || turn.status); saveRecord(config, record); throw new Error(record.error);
      }
      if (Date.now() - lastProgress > 30000) {
        const flags = snapshot.response.thread?.status?.activeFlags || [];
        log(flags.length ? `Waiting: ${flags.join(', ')}; handle input/approval in Codex if requested` : `Waiting (${turn?.status || 'message not yet visible'})`);
        lastProgress = Date.now();
      }
      await sleep(config.pollSeconds * 1000);
    }
  } catch (error) {
    if (record) log(`Keep request=${record.requestId}; --resume does not resend dispatched messages`);
    throw error;
  } finally { release?.(); client?.close(); }
}

if (require.main === module) main().catch(error => { log(error.message); process.exitCode = 1; });
module.exports = { parseArgs, settings, discoverPipe, itemText, McpClient, turnMessages, DesktopIpc, readMatching, isRetryableError };
