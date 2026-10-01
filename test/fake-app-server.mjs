import readline from 'node:readline';
import assert from 'node:assert/strict';
const mode = process.argv[2] ?? 'normal';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let initialized = false, acknowledged = false, turns = 0;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    assert.equal(m.params.clientInfo.name, 'symphony_node'); initialized = true;
    if (mode !== 'read-timeout') send({ id: m.id, result: { userAgent: 'test' } });
  } else if (m.method === 'initialized') { assert.ok(initialized); acknowledged = true;
  } else if (m.method === 'thread/start') {
    assert.ok(acknowledged); assert.equal(m.params.cwd, process.cwd()); assert.equal(m.params.sandbox, 'workspace-write');
    if (mode.startsWith('host-tool')) assert.equal(m.params.dynamicTools[0].type, 'function');
    send({ id: m.id, result: { thread: { id: 'thread-test' } } });
  } else if (m.method === 'thread/name/set') send({ id: m.id, result: {} });
  else if (m.method === 'turn/start') {
    assert.equal(m.params.cwd, process.cwd()); assert.equal(m.params.threadId, 'thread-test');
    const id = `turn-${++turns}`;
    if (turns === 1 && ['normal', 'early', 'tool'].includes(mode)) assert.ok(['你好，Symphony', 'Test issue'].includes(m.params.input[0].text));
    if (mode === 'early') send({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id, status: 'completed' } } });
    send({ id: m.id, result: { turn: { id } } });
    if (mode === 'early' || mode === 'silence') return;
    if (mode === 'input') { send({ id: 100, method: 'item/tool/requestUserInput', params: {} }); return; }
    if (mode === 'approval') { send({ id: 100, method: 'item/commandExecution/requestApproval', params: {} }); return; }
    if (mode === 'tool') { send({ id: 100, method: 'item/tool/call', params: { tool: 'unknown', arguments: {} } }); return; }
    if (mode.startsWith('host-tool')) { send({ id: 100, method: 'item/tool/call', params: { tool: 'test_publish', threadId: 'thread-test', turnId: id, callId: 'call-1', arguments: { title: 'Fix' } } }); return; }
    if (mode === 'exit') { process.exit(3); }
    process.stderr.write('diagnostic text that is not protocol\n');
    process.stdout.write('malformed\n');
    send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-test', tokenUsage: { total: { inputTokens: turns * 10, outputTokens: turns * 5, totalTokens: turns * 15 } } } });
    const completion = JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id, status: mode === 'failure' ? 'failed' : 'completed' } } }) + '\n';
    process.stdout.write(completion.slice(0, 20)); setTimeout(() => process.stdout.write(completion.slice(20)), 5);
  } else if (m.id === 100 && mode === 'tool') {
    assert.equal(m.result.success, false); send({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: `turn-${turns}`, status: 'completed' } } });
  } else if (m.id === 100 && mode.startsWith('host-tool')) {
    assert.equal(m.result.success, true); assert.equal(JSON.parse(m.result.contentItems[0].text).published, true);
    send({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: `turn-${turns}`, status: mode === 'host-tool-failure' ? 'failed' : 'completed' } } });
  }
});
