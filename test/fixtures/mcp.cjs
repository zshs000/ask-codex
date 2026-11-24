'use strict';
const fs = require('node:fs');
const readline = require('node:readline');

const filename = process.env.ASK_CODEX_TEST_DB;
const read = () => JSON.parse(fs.readFileSync(filename, 'utf8'));
const save = db => {
  const temporary = filename + '.server.tmp';
  fs.writeFileSync(temporary, JSON.stringify(db));
  fs.renameSync(temporary, filename);
};
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') {
    result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'test-fixture', version: '1' } };
  } else if (request.method === 'tools/list') {
    result = { tools: [{ name: 'read_thread' }, { name: 'send_message_to_thread' }] };
  } else {
    const db = read();
    const args = request.params.arguments;
    let payload;
    let isError = false;
    if (request.params.name === 'send_message_to_thread') {
      db.sent.push(args.prompt);
      db.turnId = 'test-turn-' + db.sent.length;
      db.requestId = args.prompt.match(/ask-codex-[0-9a-f-]+/)[0];
      payload = { threadId: args.threadId };
    } else {
      db.reads = (db.reads || 0) + 1;
      if (db.error === 'missing' || (db.error === 'transient' && db.reads === 1)) {
        payload = db.error === 'missing' ? `No Codex thread found for threadId: ${args.threadId}` : 'Codex app tool request failed';
        isError = true;
      } else {
        payload = {
          thread: { id: args.threadId, kind: 'codex', status: { type: db.busy ? 'active' : 'idle' } },
          turns: db.turnId ? [{ id: db.turnId, status: db.turnStatus || 'completed', items: [
            { type: 'functionCallOutput', name: 'send_message_to_thread', output: { text: db.requestId } },
            { type: 'agentMessage', id: 'test-answer', phase: 'final_answer', text: 'fixture reply' }
          ] }] : [],
          page: { nextCursor: null }
        };
      }
    }
    save(db);
    result = { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }], isError };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
input.on('close', () => process.exit(0));
