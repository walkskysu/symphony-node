import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { Liquid } from 'liquidjs';
import { SymphonyError, norm, type Issue } from './types.js';

type MapValue = Record<string, any>;
function map(v: unknown, name: string): MapValue {
  if (v === undefined) return {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new SymphonyError('invalid_config', `${name} must be a map`);
  return v as MapValue;
}
function integer(v: unknown, fallback: number, name: string, positive = true): number {
  const n = v === undefined ? fallback : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || (positive && n <= 0)) throw new SymphonyError('invalid_config', `${name} must be ${positive ? 'a positive' : 'an'} integer`);
  return n;
}
function strings(v: unknown, fallback: string[] | undefined, name: string): string[] {
  const value = v ?? fallback;
  if (!Array.isArray(value) || !value.every(x => typeof x === 'string')) throw new SymphonyError('invalid_config', `${name} must be a string list`);
  return value;
}
export function localPath(value: string, base: string): string {
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    const expanded = process.env[value.slice(1)];
    if (!expanded) throw new SymphonyError('invalid_config', 'Path environment variable is empty');
    value = expanded;
  }
  if (value === '~' || /^~[/\\]/.test(value)) value = path.join(homedir(), value.slice(2));
  return path.resolve(base, value);
}
export function parseWorkflow(text: string): { config: MapValue; prompt: string } {
  text = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!/^---\s*\n/.test(text)) return { config: {}, prompt: text.trim() };
  const lines = text.split('\n');
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end < 0) throw new SymphonyError('workflow_parse_error', 'Unclosed YAML front matter');
  let config: unknown;
  try { config = parse(lines.slice(1, end).join('\n')); } catch { throw new SymphonyError('workflow_parse_error', 'Invalid YAML front matter'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new SymphonyError('workflow_front_matter_not_a_map');
  return { config: config as MapValue, prompt: lines.slice(end + 1).join('\n').trim() };
}
export function resolveConfig(raw: MapValue, file: string) {
  const tracker = map(raw.tracker, 'tracker'), provider = map(tracker.provider, 'tracker.provider');
  const polling = map(raw.polling, 'polling'), workspace = map(raw.workspace, 'workspace'), hooks = map(raw.hooks, 'hooks');
  const agent = map(raw.agent, 'agent'), codex = map(raw.codex, 'codex'), runtime = map(raw.runtime, 'runtime');
  if (!['file', 'linear', 'github'].includes(tracker.kind)) throw new SymphonyError('unsupported_tracker_kind');
  const limits: Record<string, number> = {};
  for (const [state, value] of Object.entries(map(agent.max_concurrent_agents_by_state, 'state limits'))) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) limits[norm(state)] = value;
  }
  const hookScripts: Record<string, string> = {};
  for (const key of ['after_create', 'before_run', 'after_run', 'before_remove']) {
    if (hooks[key] != null) {
      if (typeof hooks[key] !== 'string') throw new SymphonyError('invalid_config', `hooks.${key} must be a string`);
      hookScripts[key] = hooks[key];
    }
  }
  const shell = runtime.shell ?? (process.platform === 'win32' ? 'powershell' : 'bash');
  if (!['powershell', 'bash'].includes(shell)) throw new SymphonyError('invalid_config', 'runtime.shell must be powershell or bash');
  const command = codex.command ?? (process.platform === 'win32' && shell === 'powershell' ? 'codex.cmd app-server' : 'codex app-server');
  if (typeof command !== 'string' || !command.trim()) throw new SymphonyError('invalid_config', 'codex.command is empty');
  const server = map(raw.server, 'server');
  const port = server.port === undefined ? undefined : integer(server.port, 0, 'server.port', false);
  if (port !== undefined && (port < 0 || port > 65535)) throw new SymphonyError('invalid_config', 'server.port out of range');
  const root = workspace.root ?? path.join(tmpdir(), 'symphony_workspaces');
  if (typeof root !== 'string' || !root.trim()) throw new SymphonyError('invalid_config', 'workspace.root must be a path');
  return {
    workflowPath: path.resolve(file), tracker: { kind: tracker.kind as 'file' | 'linear' | 'github', provider: { ...provider },
      active_states: strings(tracker.active_states, tracker.kind === 'github' ? ['open'] : tracker.kind === 'linear' ? ['Todo', 'In Progress'] : undefined, 'active_states'),
      terminal_states: strings(tracker.terminal_states, tracker.kind === 'github' ? ['closed'] : tracker.kind === 'linear' ? ['Done', 'Canceled', 'Cancelled', 'Duplicate'] : undefined, 'terminal_states'),
      required_labels: strings(tracker.required_labels, [], 'required_labels').map(norm) },
    polling: { interval_ms: integer(polling.interval_ms, 30000, 'polling.interval_ms') },
    workspace: { root: localPath(root, path.dirname(path.resolve(file))) },
    hooks: { scripts: hookScripts, timeout_ms: integer(hooks.timeout_ms, 60000, 'hooks.timeout_ms') },
    agent: { max_concurrent_agents: integer(agent.max_concurrent_agents, 10, 'max_concurrent_agents'), max_turns: integer(agent.max_turns, 20, 'max_turns'), max_retry_backoff_ms: integer(agent.max_retry_backoff_ms, 300000, 'max_retry_backoff_ms'), limits },
    codex: { command, approval_policy: codex.approval_policy ?? 'never', thread_sandbox: codex.thread_sandbox ?? 'workspace-write',
      turn_sandbox_policy: codex.turn_sandbox_policy ?? { type: 'workspaceWrite' },
      read_timeout_ms: integer(codex.read_timeout_ms, 5000, 'read_timeout_ms'), turn_timeout_ms: integer(codex.turn_timeout_ms, 3600000, 'turn_timeout_ms'), stall_timeout_ms: integer(codex.stall_timeout_ms, 300000, 'stall_timeout_ms', false) },
    runtime: { shell: shell as 'powershell' | 'bash' }, server: { port }
  };
}
export type Config = ReturnType<typeof resolveConfig>;
export interface Workflow { config: Config; prompt: string }
export async function loadWorkflow(file: string): Promise<Workflow> {
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { throw new SymphonyError('missing_workflow_file', `Cannot read ${file}`); }
  const parsed = parseWorkflow(text);
  return { config: resolveConfig(parsed.config, file), prompt: parsed.prompt };
}
const liquid = new Liquid({ strictVariables: true, strictFilters: true, ownPropertyOnly: true });
export async function renderPrompt(prompt: string, issue: Issue, attempt: number | null): Promise<string> {
  let template;
  try { template = liquid.parse(prompt || 'You are working on an issue from the configured tracker.'); }
  catch { throw new SymphonyError('template_parse_error'); }
  try { return await liquid.render(template, { issue, attempt }); }
  catch { throw new SymphonyError('template_render_error', 'Unknown variable/filter or invalid interpolation'); }
}
