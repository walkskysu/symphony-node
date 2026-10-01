import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeIssue } from '../src/tracker.js';
import { resolveConfig, type Workflow } from '../src/workflow.js';
export const temp = () => mkdtemp(path.join(tmpdir(), 'symphony-test-'));
export const issue = (extra: Record<string, unknown> = {}) => normalizeIssue({ id: '1', identifier: 'TEST-1', title: 'Test issue', state: 'Todo', dispatchable: true, labels: ['symphony'], ...extra });
export function workflow(root: string): Workflow {
  return { config: resolveConfig({ tracker: { kind: 'file', provider: { path: 'issues.json' }, active_states: ['Todo', 'In Progress'], terminal_states: ['Done'], required_labels: ['symphony'] }, workspace: { root }, agent: { max_concurrent_agents: 2 } }, path.join(root, 'WORKFLOW.md')), prompt: '{{ issue.title }}' };
}
export const quiet = () => {};
export async function settle() { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); }
