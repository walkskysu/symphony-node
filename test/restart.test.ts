import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiGitHubTracker } from '../src/tracker.js';
import { resolveConfig } from '../src/workflow.js';
import { Orchestrator } from '../src/orchestrator.js';
import { startServer } from '../src/server.js';
import { issue, quiet, settle, temp, workflow } from './helpers.js';
import type { Tracker } from '../src/types.js';
import { request } from 'node:http';

test('restart routes to scoped repository, preserves labels and rejects existing PRs before writes', async () => {
  const c = resolveConfig({ tracker: { kind: 'github', required_labels: ['symphony'], provider: {
    api_key: 'shared', automation: { enabled: true, test_command: 'npm test' },
    repositories: ['owner/one', { repo: 'owner/two', api_key: 'second', automation: { blocked_label: 'paused' } }]
  } } }, 'WORKFLOW.md');
  let labels = ['paused', 'custom'], state = 'open', hasPR = false, failWrite = false;
  const writes: string[] = [];
  const tracker = new MultiGitHubTracker(c, quiet, async (input, options) => {
    const url = new URL(String(input)), method = options?.method ?? 'GET';
    assert.ok(url.pathname.startsWith('/repos/owner/two/'));
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer second');
    if (method !== 'GET') {
      writes.push(method);
      if (failWrite) return new Response('{}', { status: 403 });
      if (method === 'POST') { const body = JSON.parse(String(options?.body)); assert.deepEqual(body.labels, ['symphony']); labels.push('symphony'); }
      if (method === 'DELETE') { assert.ok(url.pathname.endsWith('/paused')); labels = labels.filter(l => l !== 'paused'); }
      return Response.json(labels);
    }
    if (url.pathname.endsWith('/pulls')) return Response.json(hasPR ? [{ number: 9 }] : []);
    return Response.json({ number: 3, title: 'Issue', state, labels, assignees: [] });
  });
  await assert.rejects(tracker.restartIssue('foreign/repo#3'), { category: 'issue_not_found' });
  await assert.rejects(tracker.restartIssue('owner/two#../3'), { category: 'issue_not_found' });
  hasPR = true; await assert.rejects(tracker.restartIssue('owner/two#3'), { category: 'issue_has_pull_request' });
  assert.deepEqual(writes, []);
  hasPR = false; state = 'closed'; await assert.rejects(tracker.restartIssue('owner/two#3'), { category: 'issue_closed' });
  state = 'open'; failWrite = true; await assert.rejects(tracker.restartIssue('owner/two#3'), { category: 'tracker_status' });
  assert.ok(labels.includes('paused')); failWrite = false;
  const fresh = await tracker.restartIssue('owner/two#3');
  assert.deepEqual(fresh.labels.sort(), ['custom', 'symphony']); assert.equal(fresh.dispatchable, true);
});

test('restart HTTP control rejects cross-origin requests and resumes without duplicate workers', async () => {
  const w = workflow(await temp()); let current = issue({ id: 'owner/repo#3', identifier: 'owner/repo#3', dispatchable: false });
  let writes = 0, runs = 0;
  const tracker: Tracker = { secretEnvironmentNames: [], fetchByStates: async states => states.includes(current.state) ? [current] : [], fetchByIds: async () => [current],
    restartIssue: async () => { writes++; current = { ...current, dispatchable: true }; return current; } };
  const o = new Orchestrator('unused', { load: async () => w, tracker: () => tracker, logger: quiet,
    run: async (_i, _a, _w, _t, signal) => { runs++; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); } });
  await o.start(false); const server = await startServer(o, 0);
  const address = server.address() as import('node:net').AddressInfo;
  const url = `http://127.0.0.1:${address.port}/api/v1/issues/${encodeURIComponent(current.id)}/restart`;
  try {
    assert.equal((await fetch(url)).status, 405);
    assert.equal((await fetch(url, { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
    const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(url, { method: 'POST', headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(badHostStatus, 403);
    assert.equal(writes, 0);
    assert.equal((await fetch(url, { method: 'POST' })).status, 202);
    await settle(); await o.tick();
    assert.equal(runs, 1); assert.equal(writes, 1);
    const again = await fetch(url, { method: 'POST' }); assert.equal(again.status, 409);
    assert.equal((await again.json()).error.code, 'issue_running'); assert.equal(writes, 1);
  } finally { await o.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
