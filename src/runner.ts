import { AppServer } from './app-server.js';
import { WorkspaceManager } from './workspace.js';
import { renderPrompt, type Workflow } from './workflow.js';
import { norm, errorText, SymphonyError, type Issue, type Tracker, type AgentEvent, type Log, type RunIntegration } from './types.js';

export function eligible(issue: Issue, workflow: Workflow): boolean {
  const t = workflow.config.tracker, state = norm(issue.state);
  return Boolean(issue.id && issue.identifier && issue.title && issue.state && issue.dispatchable && t.active_states.map(norm).includes(state) && !t.terminal_states.map(norm).includes(state)
    && t.required_labels.every(label => label !== '' && issue.labels.map(norm).includes(label)));
}
export type Run = (issue: Issue, attempt: number | null, workflow: Workflow, tracker: Tracker, signal: AbortSignal, emit: (event: AgentEvent) => void, logger: Log) => Promise<void>;
export const runAgent: Run = async (issue, attempt, workflow, tracker, signal, emit, logger) => {
  const manager = new WorkspaceManager(workflow.config, logger, tracker.secretEnvironmentNames);
  const attemptAbort = new AbortController();
  const attemptSignal = AbortSignal.any([signal, attemptAbort.signal]);
  let workspace: string | undefined, client: AppServer | undefined;
  let integration: RunIntegration | undefined;
  try {
    workspace = await manager.prepare(issue.identifier, attemptSignal);
    integration = tracker.createRunIntegration?.({ issue, workspace, signal: attemptSignal, log: logger });
    if (integration && !await integration.prepare()) return;
    await manager.hook('before_run', workspace, attemptSignal);
    const prompt = await renderPrompt(workflow.prompt, issue, attempt) + (integration ? `\n\n${integration.instructions}` : '');
    signal.throwIfAborted(); await manager.validate(workspace);
    client = new AppServer(workflow.config, workspace, signal, emit, tracker.secretEnvironmentNames, integration?.tools, () => attemptAbort.abort());
    await client.start(`${issue.identifier}: ${issue.title}`);
    for (let turn = 1; turn <= workflow.config.agent.max_turns; turn++) {
      signal.throwIfAborted();
      await client.runTurn(turn === 1 ? prompt : `Continue work on ${issue.identifier} using the existing thread context. Check progress and finish the workflow handoff. Continuation ${turn}/${workflow.config.agent.max_turns}.`);
      if (integration?.complete()) break;
      const refreshed = (await tracker.fetchByIds([issue.id]))[0];
      if (!refreshed || !eligible(refreshed, workflow)) return;
      issue = refreshed;
    }
    if (integration && !integration.complete()) throw new SymphonyError('handoff_not_completed', 'Agent finished without publishing a PR or reporting a blocker');
  } catch (error) {
    // The host's durable handoff is authoritative, even if the model cannot
    // produce its final message (for example, its usage limit was reached).
    if (integration?.complete()) {
      logger('post_handoff_agent_error', { error: errorText(error) });
      return;
    }
    await integration?.failed(error, signal);
    throw error;
  } finally {
    attemptAbort.abort();
    try { await client?.close(); } finally { if (workspace) await manager.hook('after_run', workspace); }
  }
};
