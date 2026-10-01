import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiGitHubTracker, createTracker } from '../src/tracker.js';
import { githubRepositoryConfigs } from '../src/github-repositories.js';
import { resolveConfig } from '../src/workflow.js';
import { childEnvironment } from '../src/process.js';
import { quiet, temp } from './helpers.js';
import { workspaceKey } from '../src/workspace.js';
import { Orchestrator } from '../src/orchestrator.js';

const config = (provider: Record<string, unknown> = {}) => resolveConfig({ tracker: { kind: 'github', required_labels: ['symphony'], provider: { api_key: 'shared', repositories: ['Owner/One', 'owner/two'], ...provider } } }, 'WORKFLOW.md');
const raw = { number: 1, id: 123, title: 'Task', state: 'open', labels: ['symphony'], assignees: [] };
const response = (value: unknown) => new Response(JSON.stringify(value));

test('multi-repository config validates identity and merges scoped automation', () => {
  assert.ok(createTracker(config()) instanceof MultiGitHubTracker);
  for (const repositories of [[], 'owner/one', [null], ['bad'], ['owner/one', 'OWNER/ONE'], [{ repo: 'owner/one', endpoint: 'https://elsewhere.example' }]]) {
    assert.throws(() => createTracker(config({ repositories })), { category: 'invalid_tracker_config' });
  }
  assert.throws(() => createTracker(config({ repo: 'owner/one' })), { category: 'invalid_tracker_config' });
  const configs = githubRepositoryConfigs(config({ automation: { enabled: true, test_command: 'npm.cmd test', draft: true }, repositories: ['owner/one', { repo: 'owner/two', automation: { test_command: 'node --test', base_branch: 'develop' } }] }));
  assert.equal(configs[0].tracker.provider.repo, 'owner/one');
  assert.equal(configs[1].tracker.provider.automation.test_command, 'node --test');
  assert.equal(configs[1].tracker.provider.automation.draft, true);
  assert.equal(configs[1].tracker.provider.repositories, undefined);
});

test('same issue number remains isolated, refresh routes only to its repository, and failures are atomic', async () => {
  const calls: string[] = []; let fail = false;
  const tracker = new MultiGitHubTracker(config(), quiet, async input => {
    const url = new URL(String(input)); calls.push(url.pathname);
    if (fail && url.pathname.includes('/two/')) return new Response('{}', { status: 403 });
    return response(url.pathname.endsWith('/1') ? raw : [raw]);
  });
  const issues = await tracker.fetchByStates(['open']);
  assert.deepEqual(issues.map(i => i.id), ['owner/one#1', 'owner/two#1']);
  assert.notEqual(workspaceKey(issues[0].identifier), workspaceKey(issues[1].identifier));
  calls.length = 0;
  assert.equal((await tracker.fetchByIds(['owner/two#1', 'owner/two#1', 'other/repo#1', 'owner/one#../../x'])).length, 1);
  assert.deepEqual(calls, ['/repos/owner/two/issues/1']);
  calls.length = 0; assert.deepEqual(await tracker.fetchByIds([]), []); assert.equal(calls.length, 0);
  fail = true;
  await assert.rejects(tracker.fetchByStates(['open']), { category: 'tracker_status' });
  await assert.rejects(tracker.fetchByIds(['owner/one#1', 'owner/two#1']), { category: 'tracker_status' });
});

test('repository tools route credentials and writes correctly and strip all configured secrets', async () => {
  process.env.SYMPHONY_REPO_A = 'token-a'; process.env.SYMPHONY_REPO_B = 'token-b'; process.env.SYMPHONY_SHARED_UNUSED = 'unused-secret';
  try {
    const calls: { path: string; method: string; token: string | null }[] = [];
    const c = config({ api_key: '$SYMPHONY_SHARED_UNUSED', automation: { enabled: true, test_command: 'npm.cmd test' }, repositories: [
      { repo: 'owner/one', api_key: '$SYMPHONY_REPO_A' }, { repo: 'owner/two', api_key: '$SYMPHONY_REPO_B', automation: { test_command: 'node --test' } }
    ] });
    const tracker = new MultiGitHubTracker(c, quiet, async (input, options) => {
      const path = new URL(String(input)).pathname, method = options?.method ?? 'GET';
      calls.push({ path, method, token: new Headers(options?.headers).get('Authorization') });
      if (path === '/user') return response({ id: 42 });
      if (path.endsWith('/comments')) return response(method === 'GET' ? [] : { id: 1 });
      if (path.includes('/labels')) return response([]);
      return response(path.endsWith('/issues') ? [raw] : raw);
    });
    const environment = childEnvironment(tracker.secretEnvironmentNames);
    assert.equal(environment.SYMPHONY_REPO_A, undefined); assert.equal(environment.SYMPHONY_REPO_B, undefined);
    assert.equal(environment.SYMPHONY_SHARED_UNUSED, undefined);
    const issues = await tracker.fetchByStates(['open']);
    const integration = tracker.createRunIntegration({ issue: issues[1], workspace: await temp(), signal: new AbortController().signal, log: quiet })!;
    assert.match(integration.instructions, /node --test/);
    calls.length = 0;
    await integration.tools.find(t => t.name === 'github_issue_context')!.execute({});
    await integration.tools.find(t => t.name === 'github_report_blocked')!.execute({ reason: 'Test blocker' });
    assert.ok(integration.complete());
    assert.ok(calls.some(c => c.method === 'POST'));
    assert.ok(calls.every(c => c.path === '/user' || c.path.startsWith('/repos/owner/two/')));
    assert.ok(calls.every(c => c.token === 'Bearer token-b'));
    assert.throws(() => tracker.createRunIntegration({ issue: { ...issues[0], native_ref: issues[1].native_ref }, workspace: '.', signal: new AbortController().signal, log: quiet }), { category: 'invalid_issue_context' });
  } finally { delete process.env.SYMPHONY_REPO_A; delete process.env.SYMPHONY_REPO_B; delete process.env.SYMPHONY_SHARED_UNUSED; }
});

test('multi-repository dashboard uses scoped labels and global concurrency', async () => {
  const c = config({ repositories: ['owner/one', { repo: 'owner/two', automation: { enabled: true, test_command: 'node --test', review_label: 'custom:review' } }] });
  c.workspace.root = await temp(); c.agent.max_concurrent_agents = 1;
  const tracker = new MultiGitHubTracker(c, quiet, async input => response(new URL(String(input)).pathname.includes('/two/') ? [raw, { ...raw, number: 2, labels: ['custom:review'] }] : [raw]));
  // Use fully normalized records so ID refresh uses the same read contract.
  const issues = await tracker.fetchByStates(['open']);
  const orchestrator = new Orchestrator('unused', { load: async () => ({ config: c, prompt: '' }), logger: quiet,
    tracker: () => ({ secretEnvironmentNames: [], fetchByStates: async states => states.includes('open') ? issues : [], fetchByIds: async ids => issues.filter(i => ids.includes(i.id)) }),
    run: async (_issue, _attempt, _workflow, _tracker, signal) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })) });
  try {
    await orchestrator.start(false); const state = orchestrator.snapshot();
    assert.equal(state.counts.running, 1);
    assert.deepEqual(state.dashboard.repositories, ['owner/one', 'owner/two']);
    assert.equal(state.dashboard.issues.find(i => i.id === 'owner/two#2')?.status, 'review');
    assert.equal(state.dashboard.issues.find(i => i.id === 'owner/two#1')?.status, 'ready');
  } finally { await orchestrator.stop(); }
});
