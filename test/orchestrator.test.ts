import test from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator, retryDelay, sortIssues } from '../src/orchestrator.js';
import type { Issue, Tracker, AgentEvent } from '../src/types.js';
import { startServer } from '../src/server.js';
import { writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { temp, issue, workflow, quiet, settle } from './helpers.js';

async function harness() {
  let current = workflow(await temp()), now = 0, invalid = false, fetchError = false;
  let issues: Issue[] = [issue()];
  const jobs = new Map<string, { resolve: () => void; reject: (e: Error) => void; signal: AbortSignal; emit: (e: AgentEvent) => void }>();
  const tracker: Tracker = { secretEnvironmentNames: [], fetchByStates: async states => { if (fetchError) throw Error('offline'); return issues.filter(i => states.includes(i.state)); }, fetchByIds: async ids => { if (fetchError) throw Error('offline'); return issues.filter(i => ids.includes(i.id)); } };
  const orchestrator = new Orchestrator('unused', { logger: quiet, now: () => now, load: async () => { if (invalid) throw Error('bad yaml'); return current; }, tracker: () => tracker,
    run: (i, _a, _w, _t, signal, emit) => new Promise((resolve, reject) => { jobs.set(i.id, { resolve, reject, signal, emit }); signal.addEventListener('abort', () => reject(Error('canceled')), { once: true }); if (signal.aborted) reject(Error('canceled')); }) });
  return { orchestrator, jobs, setIssues: (v: Issue[]) => { issues = v; }, advance: (n: number) => { now += n; }, invalid: (b: boolean) => { invalid = b; }, offline: (b: boolean) => { fetchError = b; }, config: current.config, replace: () => { current = structuredClone(current); } };
}
test('sorting ranks 1..4 before unknown priorities and null timestamps last', () => {
  assert.deepEqual(sortIssues([issue({ id: 'a', priority: 0 }), issue({ id: 'b', priority: 1 }), issue({ id: 'c', priority: 1, created_at: '2025-01-01T00:00:00Z' })]).map(i => i.id), ['c', 'b', 'a']);
  assert.equal(retryDelay(1, 300000), 10000); assert.equal(retryDelay(99, 300000), 300000);
});
test('claims prevent duplicate dispatch, labels and per-state slots apply', async () => {
  const h = await harness(); h.config.agent.limits.todo = 1;
  h.setIssues([issue(), issue({ id: '2', identifier: 'TEST-2' }), issue({ id: '3', identifier: 'TEST-3', state: 'In Progress', dispatchable: false }), issue({ id: '4', identifier: 'TEST-4', state: 'In Progress', labels: [] })]);
  await h.orchestrator.start(false); await h.orchestrator.tick(); assert.equal(h.jobs.size, 1); assert.equal(h.orchestrator.snapshot().counts.running, 1); await h.orchestrator.stop();
});
test('failure backoff increments, normal completion retries at one second, terminal retry releases claim', async () => {
  const h = await harness(); await h.orchestrator.start(false);
  h.jobs.get('1')!.reject(Error('failed')); await settle(); assert.equal(h.orchestrator.snapshot().retrying[0].attempt, 1);
  h.advance(9999); await h.orchestrator.tick(); assert.equal(h.orchestrator.snapshot().counts.running, 0);
  h.advance(1); await h.orchestrator.tick(); h.jobs.get('1')!.reject(Error('failed again')); await settle(); assert.equal(h.orchestrator.snapshot().retrying[0].attempt, 2);
  h.advance(20000); await h.orchestrator.tick(); h.jobs.get('1')!.resolve(); await settle(); assert.equal(h.orchestrator.snapshot().retrying[0].attempt, 1);
  h.setIssues([issue({ state: 'Done' })]); h.advance(1000); await h.orchestrator.tick(); assert.deepEqual(h.orchestrator.snapshot().counts, { running: 0, retrying: 0 }); await h.orchestrator.stop();
});
test('reconciliation preserves workers on transport errors, cancels missing/unroutable issues', async () => {
  const h = await harness(); await h.orchestrator.start(false); h.offline(true); await h.orchestrator.tick(); assert.equal(h.orchestrator.snapshot().counts.running, 1);
  h.offline(false); h.setIssues([issue({ labels: [] })]); await h.orchestrator.tick(); assert.equal(h.jobs.get('1')!.signal.aborted, true); assert.equal(h.orchestrator.snapshot().counts.running, 0);
  h.setIssues([issue()]); await h.orchestrator.tick(); h.setIssues([]); await h.orchestrator.tick(); assert.equal(h.orchestrator.snapshot().counts.running, 0); await h.orchestrator.stop();
});
test('invalid reload gates dispatch and retries while reconciliation remains active; recovery applies config', async () => {
  const h = await harness(); await h.orchestrator.start(false); h.invalid(true); h.setIssues([issue({ state: 'Human Review' }), issue({ id: '2', identifier: 'TEST-2' })]);
  await h.orchestrator.tick(); assert.equal(h.orchestrator.snapshot().health.dispatch_enabled, false); assert.equal(h.orchestrator.snapshot().counts.running, 0);
  h.invalid(false); h.replace(); await h.orchestrator.tick(); assert.equal(h.orchestrator.snapshot().counts.running, 1); await h.orchestrator.stop();
});
test('stall detection retries; repeated cumulative token usage does not double count', async () => {
  const h = await harness(); await h.orchestrator.start(false);
  const event = { event: 'thread/tokenUsage/updated', timestamp: new Date().toISOString(), usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
  h.jobs.get('1')!.emit(event); h.jobs.get('1')!.emit(event);
  assert.equal(h.orchestrator.snapshot().codex_totals.total_tokens, 15);
  h.advance(300001); await h.orchestrator.tick(); assert.equal(h.orchestrator.snapshot().retrying[0].error, 'stalled'); await h.orchestrator.stop();
});
test('HTTP loopback snapshot, issue details, methods and refresh', async () => {
  const h = await harness(); await h.orchestrator.start(false); const server = await startServer(h.orchestrator, 0);
  try {
    const address = server.address(); assert.ok(address && typeof address === 'object'); const url = `http://127.0.0.1:${address.port}`;
    assert.equal((await (await fetch(url + '/api/v1/state')).json() as any).counts.running, 1);
    assert.equal((await fetch(url + '/api/v1/TEST-1')).status, 200);
    assert.equal((await fetch(url + '/api/v1/unknown')).status, 404);
    assert.equal((await fetch(url + '/api/v1/state', { method: 'POST' })).status, 405);
    assert.equal((await fetch(url + '/api/v1/refresh', { method: 'POST' })).status, 202);
      assert.equal((await fetch(url + '/')).status, 200);
      const html = await fetch(url + '/');
      assert.match(await html.text(), /任务看板/);
      assert.match(html.headers.get('content-security-policy')!, /script-src 'self'/);
      assert.equal((await fetch(url + '/dashboard.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
      assert.equal((await fetch(url + '/dashboard.css')).status, 200);
      assert.equal((await fetch(url + '/dashboard.js', { method: 'POST' })).status, 405);
      assert.equal((await fetch(url + '/.env')).status, 404);
      assert.equal((await fetch(url + '/api/v1/refresh', { method: 'POST', headers: { Origin: 'https://untrusted.example' } })).status, 403);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await h.orchestrator.stop(); }
});

test('dashboard exposes task stages and fresh/stale state without provider secrets', async () => {
  const h = await harness(); h.config.agent.max_concurrent_agents = 1;
  h.config.tracker.provider.api_key = 'do-not-expose-test-secret';
  h.setIssues([issue(), issue({ id: '2', identifier: 'TEST-2' }),
    issue({ id: '3', identifier: 'TEST-3', labels: ['symphony:review'], dispatchable: false, title: '<img src=x onerror=alert(1)>' }),
    issue({ id: '4', identifier: 'TEST-4', labels: ['symphony:blocked'], dispatchable: false }),
    issue({ id: '5', identifier: 'TEST-5', labels: [] })]);
  try {
    await h.orchestrator.start(false);
    const first = h.orchestrator.snapshot();
    assert.deepEqual(first.dashboard.issues.map(i => i.status), ['running', 'ready', 'review', 'blocked', 'backlog']);
    assert.ok(first.dashboard.tracker_updated_at);
    assert.equal(first.dashboard.activities[0].event, 'worker_started');
    assert.ok(!JSON.stringify(first).includes('do-not-expose-test-secret'));
    h.offline(true); await h.orchestrator.tick();
    assert.equal(h.orchestrator.snapshot().dashboard.tracker_error, 'offline');
    assert.equal(h.orchestrator.snapshot().dashboard.issues.length, 5);
    h.offline(false); h.setIssues([issue()]); await h.orchestrator.tick();
    assert.equal(h.orchestrator.snapshot().dashboard.tracker_error, null);
    assert.equal(h.orchestrator.snapshot().dashboard.issues.length, 1);
  } finally { await h.orchestrator.stop(); }
});
test('startup and terminal transition clean actual workspaces; handoff preserves them', async () => {
  const h = await harness(), root = h.config.workspace.root;
  await mkdir(path.join(root, 'DONE-1'));
  h.setIssues([issue({ id: 'done', identifier: 'DONE-1', state: 'Done' }), issue()]);
  await h.orchestrator.start(false);
  await assert.rejects(access(path.join(root, 'DONE-1')));
  await mkdir(path.join(root, 'TEST-1'));
  h.setIssues([issue({ state: 'Review' })]); await h.orchestrator.tick();
  await access(path.join(root, 'TEST-1'));
  h.setIssues([issue()]); await h.orchestrator.tick();
  h.setIssues([issue({ state: 'Done' })]); await h.orchestrator.tick();
  await assert.rejects(access(path.join(root, 'TEST-1'))); await h.orchestrator.stop();
});
test('background file reload detects changes without manual tick and recovers from bad YAML', { timeout: 8000 }, async () => {
  const root = await temp(), file = path.join(root, 'WORKFLOW.md');
  const valid = '---\ntracker:\n  kind: file\n  provider:\n    path: issues.json\n  active_states: [Todo]\n  terminal_states: [Done]\npolling:\n  interval_ms: 60000\n---\nHello';
  await writeFile(file, valid); await writeFile(path.join(root, 'issues.json'), '[]');
  const orchestrator = new Orchestrator(file, { logger: quiet }); await orchestrator.start();
  const until = async (predicate: () => boolean) => { const deadline = Date.now() + 3000; while (!predicate()) { if (Date.now() > deadline) throw Error('reload not observed'); await new Promise(r => setTimeout(r, 50)); } };
  try {
    await writeFile(file, '---\na: [\n---'); await until(() => !orchestrator.snapshot().health.dispatch_enabled);
    await writeFile(file, valid); await until(() => orchestrator.snapshot().health.dispatch_enabled);
  } finally { await orchestrator.stop(); }
});
