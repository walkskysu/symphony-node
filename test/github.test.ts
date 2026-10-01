import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubTracker, createTracker } from '../src/tracker.js';
import { resolveConfig } from '../src/workflow.js';
import { childEnvironment } from '../src/process.js';
import { quiet } from './helpers.js';

const config = (provider: Record<string, unknown> = {}) => resolveConfig({ tracker: { kind: 'github', provider: { repo: 'Owner/Repo', api_key: 'test-token', ...provider }, required_labels: ['symphony'] } }, 'WORKFLOW.md');
const raw = (number = 1, extra: Record<string, unknown> = {}) => ({ id: 100 + number, number, title: `Task ${number}`, state: 'open', body: 'Implement a fix', html_url: `https://github.com/owner/repo/issues/${number}`, labels: [{ name: ' Symphony ' }, 'BUG'], assignees: [{ id: 42, login: 'Alice' }], created_at: '2026-09-29T00:00:00Z', ...extra });
const json = (body: unknown, headers?: HeadersInit) => new Response(JSON.stringify(body), { headers });

test('GitHub configuration, default states, factory and secret isolation', () => {
  const c = config(); assert.deepEqual(c.tracker.active_states, ['open']); assert.deepEqual(c.tracker.terminal_states, ['closed']);
  assert.ok(createTracker(c) instanceof GitHubTracker);
  for (const repo of ['bad', '../repo', 'owner/..', 'owner/repo/extra', 'owner/repo?token=x']) assert.throws(() => new GitHubTracker(config({ repo })), { category: 'invalid_tracker_config' });
  assert.throws(() => new GitHubTracker(config({ endpoint: 'http://api.github.com' })), { category: 'invalid_tracker_config' });
  assert.throws(() => new GitHubTracker(config({ endpoint: 'https://token@api.github.com' })), { category: 'invalid_tracker_config' });
  assert.throws(() => new GitHubTracker(config({ api_key: '' })), { category: 'missing_tracker_secret' });
  c.tracker.active_states = ['In Progress']; assert.throws(() => new GitHubTracker(c), { category: 'invalid_tracker_config' });
  process.env.SYMPHONY_GITHUB_TEST_SECRET = 'test';
  try {
    const tracker = new GitHubTracker(config({ api_key: '$SYMPHONY_GITHUB_TEST_SECRET' }));
    assert.ok(tracker.secretEnvironmentNames.includes('GH_TOKEN'));
    assert.equal(childEnvironment(tracker.secretEnvironmentNames).SYMPHONY_GITHUB_TEST_SECRET, undefined);
  } finally { delete process.env.SYMPHONY_GITHUB_TEST_SECRET; }
});
test('GitHub paginates repository issues, excludes PRs, and preserves full normalized snapshots', async () => {
  const requests: string[] = [];
  const next = 'https://api.github.com/repos/owner/repo/issues?page=2&per_page=100&state=open';
  const tracker = new GitHubTracker(config(), quiet, async (input, options) => {
    const url = String(input); requests.push(url);
    const headers = new Headers(options?.headers); assert.equal(headers.get('Authorization'), 'Bearer test-token'); assert.equal(options?.redirect, 'manual');
    return requests.length === 1 ? json([raw(), raw(2, { pull_request: { url: 'pr' } })], { link: `<${next}>; rel="next", <${next}>; rel="last"` }) : json([raw(3)]);
  });
  assert.deepEqual(await tracker.fetchByStates([]), []); assert.deepEqual(await tracker.fetchByIds([]), []); assert.equal(requests.length, 0);
  const result = await tracker.fetchByStates([' OPEN ']);
  assert.equal(requests.length, 2); assert.equal(new URL(requests[0]).searchParams.get('state'), 'open');
  assert.deepEqual(result.map(i => i.id), ['owner/repo#1', 'owner/repo#3']);
  assert.deepEqual(result[0].labels, ['symphony', 'bug']); assert.equal(result[0].description, 'Implement a fix');
  assert.equal(result[0].assignee_id, '42'); assert.equal(result[0].priority, null); assert.equal(result[0].native_ref?.issue_number, 1);
});
test('GitHub ID refresh is scoped, de-duplicates IDs, returns terminal states, and omits missing/PRs', async () => {
  const calls: string[] = [];
  const tracker = new GitHubTracker(config(), quiet, async input => {
    const url = String(input); calls.push(url);
    if (url.endsWith('/2')) return new Response('{}', { status: 404 });
    if (url.endsWith('/3')) return json(raw(3, { pull_request: {} }));
    return json(raw(1, { state: 'closed' }));
  });
  const issues = await tracker.fetchByIds(['owner/repo#1', 'owner/repo#1', 'other/repo#1', 'owner/repo#../../x', 'owner/repo#2', 'owner/repo#3']);
  assert.equal(calls.length, 3); assert.equal(issues.length, 1); assert.equal(issues[0].state, 'closed');
});
test('GitHub assignment routing remains visible to scheduler, with case-insensitive login matching', async () => {
  const tracker = new GitHubTracker(config({ assignee: 'ALICE' }), quiet, async () => json([raw(1), raw(2, { assignees: [{ id: 43, login: 'bob' }] }), raw(3, { assignees: [{ id: 43, login: 'bob' }, { id: 42, login: 'alice' }] })]));
  assert.deepEqual((await tracker.fetchByStates(['open'])).map(i => i.dispatchable), [true, false, true]);
});
test('GitHub malformed records: list omission is logged; requested malformed identity is an error', async () => {
  let omissions = 0;
  const tracker = new GitHubTracker(config(), () => { omissions++; }, async () => json([raw(), raw(2, { title: '' })]));
  assert.equal((await tracker.fetchByStates(['open'])).length, 1); assert.equal(omissions, 1);
  const refresh = new GitHubTracker(config(), quiet, async () => json(raw(2)));
  await assert.rejects(refresh.fetchByIds(['owner/repo#1']), { category: 'tracker_response' });
  const invalid = new GitHubTracker(config(), quiet, async () => json(raw(1, { state: 'unexpected' })));
  await assert.rejects(invalid.fetchByIds(['owner/repo#1']), { category: 'tracker_response' });
});
test('GitHub errors map to stable categories and partial pages are never returned', async () => {
  for (const [status, headers, category] of [
    [401, {}, 'tracker_status'], [403, {}, 'tracker_status'], [403, { 'x-ratelimit-remaining': '0' }, 'tracker_rate_limited'],
    [403, { 'retry-after': '60' }, 'tracker_rate_limited'], [429, {}, 'tracker_rate_limited'], [301, { location: 'https://other.invalid' }, 'tracker_status']
  ] as const) {
    const tracker = new GitHubTracker(config(), quiet, async () => new Response('{}', { status, headers }));
    await assert.rejects(tracker.fetchByStates(['open']), { category });
  }
  const offline = new GitHubTracker(config(), quiet, async () => { throw Error('network includes secret'); });
  await assert.rejects(offline.fetchByStates(['open']), { category: 'tracker_request' });
  let calls = 0;
  const paging = new GitHubTracker(config(), quiet, async () => ++calls === 1 ? json([raw()], { link: '<https://api.github.com/repos/owner/repo/issues?page=2>; rel="next"' }) : new Response('not json'));
  await assert.rejects(paging.fetchByStates(['open']), { category: 'tracker_response' });
});
test('GitHub pagination blocks credential exfiltration, changed scope and duplicate pages', async () => {
  for (const next of ['https://evil.invalid/repos/owner/repo/issues?page=2', 'https://api.github.com/repos/other/repo/issues?page=2', 'https://user:pass@api.github.com/repos/owner/repo/issues?page=2']) {
    let calls = 0;
    const tracker = new GitHubTracker(config(), quiet, async () => { calls++; return json([raw()], { link: `<${next}>; rel="next"` }); });
    await assert.rejects(tracker.fetchByStates(['open']), { category: 'tracker_pagination' }); assert.equal(calls, 1);
  }
  const loop = new GitHubTracker(config(), quiet, async () => json([], { link: '<https://api.github.com/repos/owner/repo/issues?page=2>; rel="next"' }));
  await assert.rejects(loop.fetchByStates(['open']), { category: 'tracker_pagination' });
});
test('GitHub Enterprise base path is preserved and mixed states use all', async () => {
  const tracker = new GitHubTracker(config({ endpoint: 'https://github.example.com/api/v3/' }), quiet, async input => {
    const url = new URL(String(input)); assert.equal(url.pathname, '/api/v3/repos/owner/repo/issues'); assert.equal(url.searchParams.get('state'), 'all'); return json([]);
  });
  assert.deepEqual(await tracker.fetchByStates(['open', 'closed']), []);
});
