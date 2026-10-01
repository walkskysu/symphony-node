import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { parseWorkflow, resolveConfig, renderPrompt, loadWorkflow, localPath } from '../src/workflow.js';
import { FileTracker, LinearTracker, normalizeIssue } from '../src/tracker.js';
import { WorkspaceManager, workspaceKey, assertContained } from '../src/workspace.js';
import { childEnvironment } from '../src/process.js';
import { temp, issue, workflow, quiet } from './helpers.js';

test('workflow format, typed errors, defaults and environment-backed relative paths', async () => {
  assert.deepEqual(parseWorkflow(' hello '), { config: {}, prompt: 'hello' });
  assert.deepEqual(parseWorkflow('---\r\nx: 1\r\n---\r\n body '), { config: { x: 1 }, prompt: 'body' });
  assert.throws(() => parseWorkflow('---\n- item\n---'), { category: 'workflow_front_matter_not_a_map' });
  assert.throws(() => parseWorkflow('---\na: [\n---'), { category: 'workflow_parse_error' });
  assert.throws(() => parseWorkflow('---\nx: 1'), { category: 'workflow_parse_error' });
  const root = await temp(), w = workflow(root);
  assert.equal(w.config.agent.max_turns, 20);
  assert.equal(w.config.codex.turn_timeout_ms, 3600000);
  assert.equal(resolveConfig({ tracker: { kind: 'linear' } }, 'WORKFLOW.md').codex.command,
    process.platform === 'win32' ? 'codex.cmd app-server' : 'codex app-server');
  assert.equal(resolveConfig({ tracker: { kind: 'linear' }, runtime: { shell: 'bash' } }, 'WORKFLOW.md').codex.command, 'codex app-server');
  await assert.rejects(loadWorkflow(path.join(root, 'absent')), { category: 'missing_workflow_file' });
  process.env.SYMPHONY_TEST_ROOT = 'relative-dir';
  assert.equal(localPath('$SYMPHONY_TEST_ROOT', root), path.join(root, 'relative-dir'));
  delete process.env.SYMPHONY_TEST_ROOT;
  const c = resolveConfig({ tracker: { kind: 'linear', provider: { unknown: 1 } }, agent: { max_concurrent_agents_by_state: { ' ToDo ': 2, wrong: -1 } }, codex: { command: 'custom --arg $LITERAL' } }, path.join(root, 'WORKFLOW.md'));
  assert.deepEqual(c.agent.limits, { todo: 2 }); assert.equal(c.tracker.provider.unknown, 1); assert.equal(c.codex.command, 'custom --arg $LITERAL');
  assert.throws(() => resolveConfig({ tracker: { kind: 'linear' }, agent: { max_turns: 0 } }, 'WORKFLOW.md'), { category: 'invalid_config' });
});
test('Liquid is strict, supports nullable attempts and nested data', async () => {
  assert.equal(await renderPrompt('{{ issue.title }}{% if attempt %} retry{% endif %}', issue(), null), 'Test issue');
  assert.equal(await renderPrompt('{% for label in issue.labels %}{{ label }}{% endfor %} {{ attempt }}', issue(), 2), 'symphony 2');
  await assert.rejects(renderPrompt('{{ issue.missing }}', issue(), null), { category: 'template_render_error' });
  await assert.rejects(renderPrompt('{{ issue.title | unknown_filter }}', issue(), null));
});
test('normalization and file adapter: malformed refresh fails, candidates omit, empty calls do no IO', async () => {
  const root = await temp(), file = path.join(root, 'issues.json'), adapter = new FileTracker(file, quiet);
  assert.deepEqual(await adapter.fetchByIds([]), []); assert.deepEqual(await adapter.fetchByStates([]), []);
  await writeFile(file, JSON.stringify([issue({ labels: [' A ', 'a', '', 1], priority: 'high', created_at: 'wrong' }), { id: 'bad', state: 'Todo' }]));
  const result = await adapter.fetchByStates(['TODO']); assert.equal(result.length, 1); assert.deepEqual(result[0].labels, ['a']); assert.equal(result[0].priority, null);
  await assert.rejects(adapter.fetchByIds(['bad']), { category: 'tracker_response' });
  assert.deepEqual(await adapter.fetchByIds(['missing']), []);
  assert.throws(() => normalizeIssue({ id: '1' }), { category: 'tracker_response' });
});
test('workspace containment, collision-resistant names and junction defense', async () => {
  const root = await temp(), manager = new WorkspaceManager(workflow(root).config, quiet);
  assert.equal(workspaceKey('ABC-123'), 'ABC-123'); assert.notEqual(workspaceKey('a/b'), workspaceKey('a?b'));
  for (const key of ['..', '.', 'CON', 'nul.txt', 'name.']) assert.throws(() => workspaceKey(key));
  assert.throws(() => assertContained(root, root)); assert.throws(() => assertContained(root, path.join(root, '..', 'escape')));
  const target = await manager.prepare('A'); assert.equal(await manager.prepare('A'), target);
  await writeFile(path.join(root, 'file'), 'x'); await assert.rejects(manager.prepare('file'));
  const outside = await temp(); await symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(manager.prepare('link')); await assert.rejects(manager.remove('link'));
  await manager.remove('A'); await manager.remove('A');
});
test('Windows/POSIX hooks run in cwd, create once, abort on failure and timeout, cleanup is best effort', async () => {
  const root = await temp(), w = workflow(root), windows = process.platform === 'win32';
  w.config.hooks.scripts.after_create = windows ? "Add-Content -LiteralPath marker.txt -Value 'created'" : "echo created >> marker.txt";
  const manager = new WorkspaceManager(w.config, quiet);
  const target = await manager.prepare('A'); await manager.prepare('A');
  assert.equal((await readFile(path.join(target, 'marker.txt'), 'utf8')).trim(), 'created');
  w.config.hooks.scripts.before_run = 'exit 7'; await assert.rejects(manager.hook('before_run', target));
  w.config.hooks.timeout_ms = 150; w.config.hooks.scripts.before_run = windows ? 'Start-Sleep -Seconds 30' : 'sleep 30';
  await assert.rejects(manager.hook('before_run', target));
  w.config.hooks.scripts.before_remove = 'exit 8'; await manager.remove('A');
});
test('tracker secret environment aliases are removed case-insensitively', () => {
  process.env.SYMPHONY_TEST_SECRET = 'not-a-real-secret';
  assert.equal(childEnvironment(['symphony_test_secret']).SYMPHONY_TEST_SECRET, undefined);
  delete process.env.SYMPHONY_TEST_SECRET;
});
test('Linear pagination is atomic, scoped, normalized and detects repeated cursors', async () => {
  const w = workflow(await temp()); w.config.tracker.provider = { project_slug: 'demo', api_key: 'test-key' };
  let calls = 0;
  const transport: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)); assert.equal(request.variables.filter.and[0].project.slugId.eq, 'demo');
    calls++;
    return new Response(JSON.stringify({ data: { issues: { nodes: [{ id: String(calls), identifier: `L-${calls}`, title: 'Task', state: { name: 'Todo' }, labels: { nodes: [{ name: ' SyMpHoNy ' }], pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: calls === 1, endCursor: 'next' } } } }));
  };
  const tracker = new LinearTracker(w.config, quiet, transport);
  assert.deepEqual(await tracker.fetchByIds([]), []); assert.equal(calls, 0);
  const issues = await tracker.fetchByStates(['todo']); assert.equal(issues.length, 2); assert.deepEqual(issues[0].labels, ['symphony']);
  const failed = new LinearTracker(w.config, quiet, async () => new Response('{}', { status: 429 }));
  await assert.rejects(failed.fetchByStates(['Todo']), { category: 'tracker_rate_limited' });
  let n = 0;
  const looping = new LinearTracker(w.config, quiet, async () => new Response(JSON.stringify({ data: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: n++ > 0 ? 'x' : 'x' } } } })));
  await assert.rejects(looping.fetchByStates(['Todo']), { category: 'tracker_pagination' });
});
