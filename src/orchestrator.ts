import { performance } from 'node:perf_hooks';
import { createTracker } from './tracker.js';
import { loadWorkflow, type Workflow } from './workflow.js';
import { runAgent, eligible, type Run } from './runner.js';
import { WorkspaceManager } from './workspace.js';
import { norm, errorText, log, type Issue, type Tracker, type AgentEvent, type Log } from './types.js';

const tokens = () => ({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
interface Running {
  issue: Issue; attempt: number | null; abort: AbortController; task: Promise<void>; workflow: Workflow;
  started: number; started_at: string; last: number; last_event_at: string | null; last_event: string | null;
  session_id: string | null; turn_count: number; tokens: ReturnType<typeof tokens>; canceled?: boolean;
}
interface Retry { issue: Issue; attempt: number; due: number; error: string | null }
export const retryDelay = (attempt: number, cap: number) => Math.min(10000 * 2 ** Math.min(Math.max(attempt - 1, 0), 30), cap);
export function sortIssues(issues: Issue[]): Issue[] {
  const rank = (i: Issue) => i.priority !== null && i.priority >= 1 && i.priority <= 4 ? i.priority : Infinity;
  const time = (i: Issue) => i.created_at ? Date.parse(i.created_at) : Infinity;
  return [...issues].sort((a, b) => (rank(a) - rank(b) || time(a) - time(b) || (a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0)));
}
export interface Dependencies { load?: typeof loadWorkflow; tracker?: typeof createTracker; run?: Run; now?: () => number; logger?: Log }
export class Orchestrator {
  private running = new Map<string, Running>();
  private retries = new Map<string, Retry>();
  private claimed = new Set<string>();
  private completed = new Set<string>();
  private observed = new Map<string, Issue>();
  private activities: { timestamp: string; event: string; issue_identifier?: string; error?: string; pull_request_url?: string }[] = [];
  private trackerUpdatedAt: string | null = null;
  private trackerError: string | null = null;
  private workflow!: Workflow;
  private tracker!: Tracker;
  private serialized: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private pulseBusy = false;
  private stopping = false;
  private nextPoll = 0;
  private nextReload = 0;
  private valid = true;
  private lastError: string | null = null;
  private totals = { ...tokens(), seconds_running: 0 };
  private rateLimits: unknown = null;
  private load: typeof loadWorkflow; private factory: typeof createTracker; private run: Run; private now: () => number; private logger: Log;
  constructor(private file: string, deps: Dependencies = {}) {
    this.load = deps.load ?? loadWorkflow; this.factory = deps.tracker ?? createTracker; this.run = deps.run ?? runAgent;
    this.now = deps.now ?? (() => performance.now()); this.logger = deps.logger ?? log;
  }
  private enqueue(action: () => Promise<void>): Promise<void> {
    const result = this.serialized.then(action);
    this.serialized = result.catch(e => this.logger('orchestrator_error', { error: errorText(e) }));
    return result;
  }
  async start(background = true): Promise<void> {
    this.workflow = await this.load(this.file); this.tracker = this.factory(this.workflow.config, this.logger);
    try {
      const terminal = await this.tracker.fetchByStates(this.workflow.config.tracker.terminal_states);
      for (const issue of terminal) await this.cleanup(issue, this.workflow);
    } catch (e) { this.logger('startup_cleanup_failed', { error: errorText(e) }); }
    await this.tick();
    if (background) this.timer = setInterval(() => {
      if (this.pulseBusy || this.stopping) return;
      this.pulseBusy = true;
      void this.enqueue(async () => {
        const now = this.now();
        if (now >= this.nextReload) await this.reload();
        if (now >= this.nextPoll) await this.cycle();
        else if (this.valid) await this.processRetries();
      }).catch(e => this.logger('tick_failed', { error: errorText(e) })).finally(() => { this.pulseBusy = false; });
    }, 200);
    this.logger('service_started');
  }
  private async reload(): Promise<void> {
    this.nextReload = this.now() + 1000;
    try {
      const workflow = await this.load(this.file), tracker = this.factory(workflow.config, this.logger);
      const changed = JSON.stringify(workflow) !== JSON.stringify(this.workflow);
      this.workflow = workflow; this.tracker = tracker; this.valid = true; this.lastError = null;
      if (changed) { this.observed.clear(); this.nextPoll = 0; this.logger('workflow_reloaded'); }
    } catch (e) {
      this.valid = false; this.lastError = errorText(e);
      this.logger('workflow_reload_failed', { error: this.lastError });
    }
  }
  tick(): Promise<void> { return this.enqueue(async () => { if (!this.stopping) { await this.reload(); await this.cycle(); } }); }
  private async cycle(): Promise<void> {
    if (this.stopping) return;
    await this.reconcile();
    this.nextPoll = this.now() + this.workflow.config.polling.interval_ms;
    if (!this.valid || this.stopping) return;
    await this.processRetries();
    let candidates: Issue[];
    try { candidates = await this.tracker.fetchByStates(this.workflow.config.tracker.active_states); }
    catch (e) { this.trackerError = errorText(e); this.logger('candidate_fetch_failed', { error: this.trackerError }); return; }
    this.trackerError = null; this.trackerUpdatedAt = new Date().toISOString();
    this.observed = new Map(candidates.map(issue => [issue.id, issue]));
    for (const issue of sortIssues(candidates)) {
      if (this.stopping) break;
      if (!eligible(issue, this.workflow) || this.claimed.has(issue.id) || this.running.has(issue.id) || !this.hasSlots(issue)) continue;
      // Revalidate the full snapshot immediately before reserving a workspace.
      try {
        const fresh = (await this.tracker.fetchByIds([issue.id]))[0];
        if (fresh && eligible(fresh, this.workflow) && this.hasSlots(fresh)) this.dispatch(fresh, null);
      } catch (e) { this.logger('dispatch_refresh_failed', { issue_id: issue.id, issue_identifier: issue.identifier, error: errorText(e) }); }
    }
  }
  private hasSlots(issue: Issue): boolean {
    const a = this.workflow.config.agent;
    return this.running.size < a.max_concurrent_agents && [...this.running.values()].filter(r => norm(r.issue.state) === norm(issue.state)).length < (a.limits[norm(issue.state)] ?? a.max_concurrent_agents);
  }
  private dispatch(issue: Issue, attempt: number | null): void {
    if (this.stopping || this.running.has(issue.id) || (this.claimed.has(issue.id) && !this.retries.has(issue.id))) return;
    this.retries.delete(issue.id); this.claimed.add(issue.id);
    const entry: Running = { issue, attempt, abort: new AbortController(), task: Promise.resolve(), workflow: this.workflow,
      started: this.now(), started_at: new Date().toISOString(), last: this.now(), last_event: null, last_event_at: null, session_id: null, turn_count: 0, tokens: tokens() };
    this.running.set(issue.id, entry);
    const context: Log = (event, fields = {}) => {
      this.activities.unshift({ timestamp: new Date().toISOString(), event, issue_identifier: issue.identifier,
        ...(typeof fields.error === 'string' ? { error: fields.error } : {}),
        ...(typeof fields.pull_request_url === 'string' ? { pull_request_url: fields.pull_request_url } : {}) });
      this.activities = this.activities.slice(0, 100);
      this.logger(event, { issue_id: issue.id, issue_identifier: issue.identifier, session_id: entry.session_id, ...fields });
    };
    context('worker_started', { attempt });
    const tracker = this.tracker;
    entry.task = Promise.resolve().then(() => this.run(issue, attempt, entry.workflow, tracker, entry.abort.signal, event => this.onEvent(entry, event), context));
    // Capture this session's adapter before any configuration reload.
    const finish = (error?: unknown) => { void this.enqueue(async () => {
      if (this.running.get(issue.id) !== entry) return;
      this.end(entry);
      if (this.stopping || entry.canceled) { this.claimed.delete(issue.id); return; }
      context(error ? 'worker_failed' : 'worker_completed', error ? { error: errorText(error) } : {});
      if (!error) this.completed.add(issue.id);
      this.schedule(issue, error ? (attempt ?? 0) + 1 : 1, error ? errorText(error) : null);
    }); };
    entry.task.then(() => finish(), e => finish(e));
  }
  private onEvent(entry: Running, event: AgentEvent) {
    if (this.running.get(entry.issue.id) !== entry || entry.canceled) return;
    entry.last = this.now(); entry.last_event = event.event; entry.last_event_at = event.timestamp;
    if (event.event === 'session_started') { entry.session_id = `${event.thread_id}-${event.turn_id}`; entry.turn_count++; this.logger('session_started', { issue_id: entry.issue.id, issue_identifier: entry.issue.identifier, session_id: entry.session_id }); }
    if (event.usage) for (const key of ['input_tokens', 'output_tokens', 'total_tokens'] as const) {
      const next = Math.max(entry.tokens[key], event.usage[key]); this.totals[key] += next - entry.tokens[key]; entry.tokens[key] = next;
    }
    if (event.rate_limits !== undefined) this.rateLimits = event.rate_limits;
  }
  private end(entry: Running) { this.running.delete(entry.issue.id); this.totals.seconds_running += (this.now() - entry.started) / 1000; }
  private schedule(issue: Issue, attempt: number, error: string | null) {
    this.claimed.add(issue.id);
    this.retries.set(issue.id, { issue, attempt, error, due: this.now() + (error === null ? 1000 : retryDelay(attempt, this.workflow.config.agent.max_retry_backoff_ms)) });
  }
  private async cancel(entry: Running, cleanup: boolean, stalled = false) {
    entry.canceled = true; entry.abort.abort();
    await entry.task.catch(() => {});
    this.end(entry); this.claimed.delete(entry.issue.id);
    if (cleanup) await this.cleanup(entry.issue, entry.workflow);
    if (stalled && !this.stopping) this.schedule(entry.issue, (entry.attempt ?? 0) + 1, 'stalled');
    this.logger('worker_canceled', { issue_id: entry.issue.id, issue_identifier: entry.issue.identifier, session_id: entry.session_id, reason: stalled ? 'stalled' : 'reconciliation' });
  }
  private async reconcile() {
    const timeout = this.workflow.config.codex.stall_timeout_ms;
    for (const entry of [...this.running.values()]) if (timeout > 0 && this.now() - entry.last > timeout) await this.cancel(entry, false, true);
    const entries = [...this.running.values()]; if (!entries.length) return;
    let fresh: Issue[];
    try { fresh = await this.tracker.fetchByIds(entries.map(r => r.issue.id)); }
    catch (e) { this.logger('reconciliation_failed', { error: errorText(e) }); return; }
    for (const entry of entries) {
      const issue = fresh.find(i => i.id === entry.issue.id);
      if (issue) this.observed.set(issue.id, issue); else this.observed.delete(entry.issue.id);
      if (issue && eligible(issue, this.workflow)) entry.issue = issue;
      else await this.cancel(entry, !!issue && this.terminal(issue));
    }
  }
  private terminal(issue: Issue) { return this.workflow.config.tracker.terminal_states.map(norm).includes(norm(issue.state)); }
  private async cleanup(issue: Issue, workflow: Workflow) {
    try { await new WorkspaceManager(workflow.config, this.logger, this.tracker.secretEnvironmentNames).remove(issue.identifier); }
    catch (e) { this.logger('workspace_cleanup_failed', { issue_id: issue.id, issue_identifier: issue.identifier, error: errorText(e) }); }
  }
  private async processRetries() {
    for (const [id, retry] of [...this.retries]) {
      if (this.stopping || retry.due > this.now()) continue;
      try {
        const issue = (await this.tracker.fetchByIds([id]))[0];
        if (issue && this.terminal(issue)) await this.cleanup(issue, this.workflow);
        if (!issue || !eligible(issue, this.workflow)) { this.retries.delete(id); this.claimed.delete(id); }
        else if (this.hasSlots(issue)) this.dispatch(issue, retry.attempt);
        else this.schedule(issue, retry.attempt + 1, 'no available orchestrator slots');
      } catch { this.schedule(retry.issue, retry.attempt + 1, 'retry refresh failed'); }
    }
  }
  snapshot() {
    const now = this.now();
    const config = this.workflow?.config;
    const automation = config?.tracker.provider.automation;
    const issues = new Map(this.observed);
    for (const entry of this.running.values()) if (!issues.has(entry.issue.id)) issues.set(entry.issue.id, entry.issue);
    for (const entry of this.retries.values()) if (!issues.has(entry.issue.id)) issues.set(entry.issue.id, entry.issue);
    const board = [...issues.values()].map(issue => {
      const labels = issue.labels.map(norm);
      const status = labels.includes(norm(automation?.review_label ?? 'symphony:review')) ? 'review'
        : labels.includes(norm(automation?.blocked_label ?? 'symphony:blocked')) ? 'blocked'
        : this.running.has(issue.id) ? 'running' : this.retries.has(issue.id) ? 'retrying'
        : config && eligible(issue, this.workflow) ? 'ready' : 'backlog';
      return { id: issue.id, identifier: issue.identifier, title: issue.title, description: issue.description,
        url: issue.url, state: issue.state, labels: issue.labels, priority: issue.priority, status,
        updated_at: issue.updated_at, dispatchable: issue.dispatchable };
    });
    return { generated_at: new Date().toISOString(), counts: { running: this.running.size, retrying: this.retries.size },
      dashboard: { project: config?.tracker.provider.repo ?? config?.tracker.provider.project_slug ?? 'Local workspace',
        tracker: config?.tracker.kind ?? 'unknown', max_concurrent_agents: config?.agent.max_concurrent_agents ?? 0,
        polling_interval_ms: config?.polling.interval_ms ?? 0, required_labels: config?.tracker.required_labels ?? [],
        tracker_updated_at: this.trackerUpdatedAt, tracker_error: this.trackerError, issues: board, activities: [...this.activities] },
      health: { dispatch_enabled: this.valid && !this.stopping, last_error: this.lastError },
      running: [...this.running.values()].map(r => ({ issue_id: r.issue.id, issue_identifier: r.issue.identifier, issue_url: r.issue.url, state: r.issue.state, session_id: r.session_id, turn_count: r.turn_count, started_at: r.started_at, last_event: r.last_event, last_event_at: r.last_event_at, tokens: { ...r.tokens } })),
      retrying: [...this.retries.values()].map(r => ({ issue_id: r.issue.id, issue_identifier: r.issue.identifier, issue_url: r.issue.url, attempt: r.attempt, due_at: new Date(Date.now() + r.due - now).toISOString(), error: r.error })),
      codex_totals: { ...this.totals, seconds_running: this.totals.seconds_running + [...this.running.values()].reduce((n, r) => n + (now - r.started) / 1000, 0) }, rate_limits: this.rateLimits };
  }
  async stop() {
    this.stopping = true; clearInterval(this.timer);
    for (const entry of this.running.values()) entry.abort.abort();
    await this.enqueue(async () => { for (const entry of [...this.running.values()]) await this.cancel(entry, false); this.retries.clear(); this.claimed.clear(); });
    this.logger('service_stopped');
  }
}
