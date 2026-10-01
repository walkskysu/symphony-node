import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AppServer } from '../src/app-server.js';
import { runAgent } from '../src/runner.js';
import type { AgentEvent } from '../src/types.js';
import { temp, workflow, issue, quiet } from './helpers.js';
function fakeCommand(mode: string) {
  const file = path.resolve('test/fake-app-server.mjs');
  return process.platform === 'win32' ? `& '${process.execPath.replaceAll("'", "''")}' '${file.replaceAll("'", "''")}' ${mode}` : `'${process.execPath}' '${file}' ${mode}`;
}
for (const mode of ['normal', 'early', 'tool', 'silence', 'failure', 'input', 'approval', 'exit', 'read-timeout']) {
  test(`app-server: ${mode}`, { timeout: 15000 }, async () => {
    const root = await temp(), w = workflow(root), events: AgentEvent[] = [];
    w.config.codex.command = fakeCommand(mode); w.config.codex.read_timeout_ms = mode === 'read-timeout' ? 1500 : 5000; w.config.codex.turn_timeout_ms = 200;
    const client = new AppServer(w.config, root, new AbortController().signal, e => events.push(e));
    try {
      if (mode === 'read-timeout') { await assert.rejects(client.start('Test'), { category: 'response_timeout' }); return; }
      await client.start('Test');
      const errors: Record<string, string> = { silence: 'turn_timeout', failure: 'turn_failed', input: 'turn_input_required', approval: 'approval_required', exit: 'port_exit' };
      if (errors[mode]) await assert.rejects(client.runTurn('hello'), { category: errors[mode] });
      else { await client.runTurn('你好，Symphony'); await client.runTurn('continue'); assert.equal(events.filter(e => e.event === 'session_started').length, 2); }
      if (mode === 'normal') assert.equal(events.filter(e => e.usage).at(-1)?.usage?.total_tokens, 30);
    } finally { await client.close(); }
  });
}
test('runner performs multiple turns in the same session and exits on handoff', { timeout: 15000 }, async () => {
  const root = await temp(), w = workflow(root), events: AgentEvent[] = []; let reads = 0;
  w.config.codex.command = fakeCommand('normal');
  await runAgent(issue(), null, w, { secretEnvironmentNames: [], fetchByStates: async () => [], fetchByIds: async () => [issue({ state: ++reads === 2 ? 'Review' : 'Todo' })] }, new AbortController().signal, e => events.push(e), quiet);
  const sessions = events.filter(e => e.event === 'session_started'); assert.equal(sessions.length, 2); assert.equal(sessions[0].thread_id, sessions[1].thread_id);
});
test('real Codex integration requires explicit opt-in', { skip: process.env.SYMPHONY_REAL_CODEX !== '1' }, async () => {
  const root = await temp(), w = workflow(root);
  w.config.codex.read_timeout_ms = 30000;
  const client = new AppServer(w.config, root, new AbortController().signal, quiet);
  try { await client.start('Symphony integration smoke'); await client.runTurn('Reply OK without running commands or modifying files.'); } finally { await client.close(); }
});

for (const handedOff of [true, false]) {
  test(`runner preserves durable handoff after model failure: ${handedOff}`, async () => {
    const root = await temp(), w = workflow(root); w.config.codex.command = fakeCommand('host-tool-failure');
    let complete = false, failures = 0;
    const logs: string[] = [];
    const task = runAgent(issue(), null, w, {
      secretEnvironmentNames: [], fetchByStates: async () => [], fetchByIds: async () => [issue()],
      createRunIntegration: () => ({ instructions: '', prepare: async () => true, complete: () => complete,
        failed: async () => { failures++; }, tools: [{ name: 'test_publish', description: 'Publish', inputSchema: { type: 'object' },
          execute: async () => { complete = handedOff; return { published: true }; } }] })
    }, new AbortController().signal, quiet, event => { logs.push(event); });
    if (handedOff) { await task; assert.equal(failures, 0); assert.ok(logs.includes('post_handoff_agent_error')); }
    else { await assert.rejects(task, { category: 'turn_failed' }); assert.equal(failures, 1); }
  });
}
test('host dynamic tools are advertised, executed and returned over the targeted protocol', async () => {
  const root = await temp(), w = workflow(root); w.config.codex.command = fakeCommand('host-tool'); let calls = 0;
  const client = new AppServer(w.config, root, new AbortController().signal, quiet, [], [{ name: 'test_publish', description: 'Test', inputSchema: { type: 'object' }, execute: async args => { assert.deepEqual(args, { title: 'Fix' }); calls++; return { published: true }; } }]);
  try { await client.start('Dynamic tools'); await client.runTurn('Do work'); assert.equal(calls, 1); } finally { await client.close(); }
});
test('long-running host tool sends heartbeat instead of timing out the turn', async () => {
  const root = await temp(), w = workflow(root); w.config.codex.command = fakeCommand('host-tool'); w.config.codex.turn_timeout_ms = 100;
  const client = new AppServer(w.config, root, new AbortController().signal, quiet, [], [{ name: 'test_publish', description: 'Test', inputSchema: { type: 'object' }, execute: async () => { await new Promise(r => setTimeout(r, 350)); return { published: true }; } }]);
  try { await client.start('Heartbeat'); await client.runTurn('Do work'); } finally { await client.close(); }
});
test('canceling a session aborts an in-flight host tool before shutdown completes', async () => {
  const root = await temp(), w = workflow(root); w.config.codex.command = fakeCommand('host-tool');
  const session = new AbortController(), toolAbort = new AbortController(); let started!: () => void;
  const active = new Promise<void>(resolve => { started = resolve; });
  const client = new AppServer(w.config, root, session.signal, quiet, [], [{ name: 'test_publish', description: 'Test', inputSchema: { type: 'object' }, execute: async () => {
    started(); await new Promise<void>((_resolve, reject) => { toolAbort.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }); }); return { published: true };
  } }], () => toolAbort.abort());
  try {
    await client.start('Cancellation'); const turn = client.runTurn('Do work'); const rejected = assert.rejects(turn, { category: 'canceled' });
    await active; session.abort(); await rejected; await client.close(); assert.equal(toolAbort.signal.aborted, true);
  } finally { await client.close(); }
});
