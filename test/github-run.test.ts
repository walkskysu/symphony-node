import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubRun, type GitPublisher } from '../src/github-run.js';
import { GitHubApi } from '../src/github-api.js';
import { githubAutomationConfig } from '../src/github-config.js';
import { GitHubTracker } from '../src/tracker.js';
import { resolveConfig } from '../src/workflow.js';
import { SymphonyError } from '../src/types.js';
import { issue, quiet, temp } from './helpers.js';

async function fixture() {
  const root = await temp();
  const config = resolveConfig({ workspace: { root }, tracker: { kind: 'github', required_labels: ['symphony'], provider: { repo: 'owner/repo', api_key: 'fake', automation: { enabled: true, test_command: 'npm test' } } } }, 'WORKFLOW.md');
  const current: any = { number: 7, title: 'Fix it', state: 'open', labels: [{ name: 'symphony' }], assignees: [] };
  const comments: any[] = [], prs: any[] = [], writes: { method: string; path: string; body: any }[] = [];
  let failCheck = false, losePRResponse = false, pushes = 0, preparations = 0;
  const api = new GitHubApi('https://api.github.com', 'owner/repo', 'fake', async (url, options) => {
    const u = new URL(String(url)), method = options?.method ?? 'GET', p = u.pathname.replace('/repos/owner/repo', '');
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (method !== 'GET') writes.push({ method, path: p, body });
    if (p === '/user') return response({ id: 100, login: 'symphony-bot' });
    if (p === '') return response({ full_name: 'owner/repo', default_branch: 'main' });
    if (p === '/issues/7' && method === 'GET') return response(current);
    if (p === '/issues/7/comments') {
      if (method === 'GET') return response(comments);
      const comment = { id: comments.length + 1, user: { id: 100 }, ...body }; comments.push(comment); return response(comment, 201);
    }
    if (p.startsWith('/issues/comments/') && method === 'PATCH') {
      const comment = comments.find(c => c.id === Number(p.split('/').at(-1))); Object.assign(comment, body); return response(comment);
    }
    if (p.startsWith('/labels/')) return response({ name: decodeURIComponent(p.slice(8)) });
    if (p === '/issues/7/labels' && method === 'POST') { for (const name of body.labels) if (!current.labels.some((l: any) => l.name === name)) current.labels.push({ name }); return response(current.labels); }
    if (p.startsWith('/issues/7/labels/') && method === 'DELETE') { const label = decodeURIComponent(p.split('/').at(-1)!); current.labels = current.labels.filter((l: any) => l.name !== label); return response(current.labels); }
    if (p === '/pulls') {
      if (method === 'GET') return response(prs);
      const pr = { ...body, number: 23, html_url: 'https://github.com/owner/repo/pull/23', state: 'open', head: { ref: body.head, repo: { full_name: 'owner/repo' } }, base: { ref: body.base } };
      prs.push(pr); if (losePRResponse) throw Error('connection lost'); return response(pr, 201);
    }
    throw Error(`Unexpected mock request ${method} ${p}`);
  });
  const git: GitPublisher = { prepare: async base => { preparations++; assert.equal(base, 'main'); }, publish: async () => { if (failCheck) throw new SymphonyError('checks_failed'); pushes++; return { sha: 'abc123', branch: 'symphony/issue-7', checks: 'npm test' }; } };
  const context = { issue: issue({ id: 'owner/repo#7', identifier: 'owner/repo#7', state: 'open', native_ref: { issue_number: 7 } }), workspace: root, signal: new AbortController().signal, log: quiet };
  const make = () => new GitHubRun(config, githubAutomationConfig(config)!, context, api, 'fake', ['GITHUB_TOKEN'], git);
  const run = make();
  const tool = (name: string, args: unknown) => run.tools.find(t => t.name === name)!.execute(args);
  return { run, tool, make, config, current, comments, prs, writes, failChecks: (value: boolean) => { failCheck = value; }, loseResponse: () => { losePRResponse = true; }, pushes: () => pushes, preparations: () => preparations };
}
test('GitHub Issue → checks → push → draft PR → comment and label handoff', async () => {
  const f = await fixture(); assert.equal(await f.run.prepare(), true);
  await f.tool('github_update_progress', { summary: 'Fixed the regression' });
  await f.tool('github_publish_pull_request', { title: 'Fix regression', summary: 'Adds coverage and fixes the bug.' });
  assert.equal(f.run.complete(), true); assert.equal(f.pushes(), 1); assert.equal(f.prs.length, 1); assert.equal(f.prs[0].draft, true);
  assert.ok(f.prs[0].body.includes('Closes #7')); assert.ok(f.prs[0].body.includes('npm test'));
  assert.equal(f.comments.length, 1); assert.ok(f.comments[0].body.includes('/pull/23'));
  assert.deepEqual(f.current.labels, [{ name: 'symphony:review' }]);
  await assert.rejects(f.tool('github_publish_pull_request', { title: 'Again', summary: 'Again' }), { category: 'handoff_already_complete' });
});
test('failed mandatory checks never create a PR or mark the issue reviewed; tool can retry', async () => {
  const f = await fixture(); await f.run.prepare(); f.failChecks(true);
  await assert.rejects(f.tool('github_publish_pull_request', { title: 'Fix', summary: 'Fix' }), { category: 'checks_failed' });
  assert.equal(f.pushes(), 0); assert.equal(f.prs.length, 0); assert.equal(f.run.complete(), false);
  f.failChecks(false); await f.tool('github_publish_pull_request', { title: 'Fix', summary: 'Fix' }); assert.equal(f.prs.length, 1);
});
test('lost PR response and restarted attempt recover the same PR without duplicate commits/comments', async () => {
  const f = await fixture(); await f.run.prepare(); f.loseResponse();
  await f.tool('github_publish_pull_request', { title: 'Fix', summary: 'Fix' }); assert.equal(f.prs.length, 1);
  f.current.labels = [{ name: 'symphony' }];
  const next = f.make(); assert.equal(await next.prepare(), false); assert.equal(next.complete(), true);
  assert.equal(f.pushes(), 1); assert.equal(f.preparations(), 1); assert.equal(f.comments.length, 1);
});
test('human blocker pauses eligibility and never pushes a branch', async () => {
  const f = await fixture(); await f.run.prepare(); await f.tool('github_report_blocked', { reason: 'Need acceptance criteria for the API response.' });
  assert.equal(f.run.complete(), true); assert.equal(f.pushes(), 0); assert.ok(f.current.labels.some((l: any) => l.name === 'symphony:blocked'));
  const tracker = new GitHubTracker(f.config, quiet, async () => new Response(JSON.stringify([f.current])));
  assert.equal((await tracker.fetchByStates(['open']))[0].dispatchable, false);
});
test('tool arguments cannot select a foreign issue or arbitrary repository', async () => {
  const f = await fixture(); await f.run.prepare();
  await assert.rejects(f.tool('github_update_progress', { summary: 'x', issue_number: 999 }), { category: 'invalid_tool_arguments' });
  await assert.rejects(f.tool('github_publish_pull_request', { title: '', summary: 'x' }), { category: 'invalid_tool_arguments' });
  assert.equal(f.prs.length, 0);
});
test('removed dispatch label prevents publication, and errors do not leak raw secret details to comments', async () => {
  const f = await fixture(); await f.run.prepare(); f.current.labels = [];
  await assert.rejects(f.tool('github_publish_pull_request', { title: 'Fix', summary: 'Fix' }), { category: 'issue_no_longer_eligible' });
  await f.run.failed(Error('fake-secret-value')); assert.ok(!f.comments[0].body.includes('fake-secret-value')); assert.equal(f.prs.length, 0);
});
test('automation config requires mandatory checks and distinct dispatch/review/blocked labels', async () => {
  const f = await fixture();
  f.config.tracker.provider.automation.test_command = ''; assert.throws(() => githubAutomationConfig(f.config), { category: 'invalid_tracker_config' });
  f.config.tracker.provider.automation.test_command = 'npm test'; f.config.tracker.provider.automation.review_label = 'symphony'; assert.throws(() => githubAutomationConfig(f.config), { category: 'invalid_tracker_config' });
});
