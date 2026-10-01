import type { Config } from './workflow.js';
import { GitHubApi, GitHubApiError } from './github-api.js';
import { GitWorkspace, type PublishResult } from './git-workspace.js';
import { type GitHubAutomationConfig } from './github-config.js';
import { SymphonyError, errorText, norm, type AgentTool, type RunContext, type RunIntegration } from './types.js';

export interface GitPublisher { prepare(base: string): Promise<void>; publish(message: string): Promise<PublishResult> }
export class GitHubRun implements RunIntegration {
  readonly tools: AgentTool[];
  readonly instructions: string;
  private done = false;
  private base = '';
  private actorId?: number;
  private prepared = false;
  private readonly number: number;
  private readonly branch: string;
  private readonly marker: string;
  private readonly git: GitPublisher;
  constructor(private config: Config, private automation: GitHubAutomationConfig, private context: RunContext, private api: GitHubApi,
    token: string, secrets: string[], git?: GitPublisher) {
    this.number = Number(context.issue.native_ref?.issue_number);
    if (!Number.isSafeInteger(this.number) || this.number <= 0 || context.issue.id !== `${api.repository}#${this.number}`) throw new SymphonyError('invalid_issue_context');
    this.branch = `symphony/issue-${this.number}`;
    this.marker = `<!-- symphony:${api.repository}#${this.number} -->`;
    const endpoint = new URL(config.tracker.provider.endpoint ?? 'https://api.github.com');
    const origin = endpoint.hostname === 'api.github.com' ? 'https://github.com' : endpoint.origin;
    this.git = git ?? new GitWorkspace(context, config, automation, api.repository, this.number, `${origin}/${api.repository}.git`, token, secrets);
    this.tools = [
      this.tool('github_issue_context', 'Read this issue and the latest 50 discussion comments in the configured GitHub repository.', {}, [], async () => ({ issue: await this.getIssue(), comments: (await this.api.list(`/issues/${this.number}/comments`, this.context.signal)).slice(-50).map(c => ({ author: c.user?.login, body: typeof c.body === 'string' ? c.body.slice(0, 8000) : '' })) })),
      this.tool('github_update_progress', 'Update the single Symphony progress comment on this issue.', { summary: { type: 'string' } }, ['summary'], async args => { this.assertOpen(); await this.progress('In progress', this.string(args, 'summary')); return { updated: true }; }),
      this.tool('github_publish_pull_request', 'Run mandatory configured tests, commit workspace changes, push only the issue branch and create/recover a pull request. On success, hand off the issue for review. Test failure returns diagnostics; fix them and retry.',
        { title: { type: 'string' }, summary: { type: 'string' } }, ['title', 'summary'], async args => this.publish(this.string(args, 'title', 240), this.string(args, 'summary'))),
      this.tool('github_report_blocked', 'Report a concrete blocker requiring human action and pause this issue.', { reason: { type: 'string' } }, ['reason'], async args => {
        this.assertOpen(); await this.progress('Blocked — human input required', this.string(args, 'reason')); await this.addLabel(this.automation.blockedLabel); this.done = true; this.context.log('issue_blocked'); return { blocked: true };
      })
    ];
    this.instructions = `GitHub automation is enabled for ${context.issue.identifier}. The host prepared branch ${this.branch}.\nUse github_issue_context to read the discussion. Implement and test the issue in this workspace. Use github_update_progress for useful milestones.\nWhen ready, you MUST call github_publish_pull_request with a concise title and summary. The host runs the configured checks, commits, pushes and creates the PR. If the tool reports failed checks, fix the problem and retry. Do not report success until the tool succeeds. Do not run git push or GitHub write commands yourself.\nIf you cannot proceed without human input, call github_report_blocked with a specific reason. After successful publish or blocked handoff, finish the turn without modifying more files. Test command: ${automation.testCommand}`;
  }
  private tool(name: string, description: string, properties: Record<string, unknown>, required: string[], execute: (args: Record<string, unknown>) => Promise<unknown>): AgentTool {
    return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, execute: async value => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !Object.hasOwn(properties, k)) || required.some(k => !Object.hasOwn(value, k))) throw new SymphonyError('invalid_tool_arguments');
      this.context.signal.throwIfAborted(); return execute(value as Record<string, unknown>);
    } };
  }
  private string(args: Record<string, unknown>, name: string, limit = 16000): string {
    const value = args[name]; if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new SymphonyError('invalid_tool_arguments', `${name} must contain 1..${limit} characters`); return value.trim();
  }
  private assertOpen() { if (this.done) throw new SymphonyError('handoff_already_complete'); }
  private getIssue() { return this.api.request('GET', `/issues/${this.number}`, undefined, this.context.signal); }
  private async eligibleNow(): Promise<boolean> {
    const issue = await this.getIssue();
    const labels = (issue.labels ?? []).map((l: any) => norm(typeof l === 'string' ? l : l.name ?? ''));
    return issue.state === 'open' && !issue.pull_request && this.config.tracker.required_labels.every(l => labels.includes(l)) && !labels.includes(norm(this.automation.reviewLabel)) && !labels.includes(norm(this.automation.blockedLabel))
      && (!this.config.tracker.provider.assignee || (issue.assignees ?? []).some((a: any) => norm(a.login ?? '') === norm(this.config.tracker.provider.assignee)));
  }
  private async existingPR(): Promise<any | undefined> {
    const query = new URLSearchParams({ state: 'all', head: `${this.api.repository.split('/')[0]}:${this.branch}`, base: this.base });
    const prs = await this.api.list(`/pulls?${query}`, this.context.signal);
    const matches = prs.filter(p => p.head?.ref === this.branch && norm(p.head?.repo?.full_name ?? '') === this.api.repository && p.base?.ref === this.base);
    const found = matches.find(p => typeof p.body === 'string' && p.body.includes(this.marker));
    if (matches.length && !found) throw new SymphonyError('github_branch_conflict', 'Issue branch already belongs to an unrelated pull request');
    return found;
  }
  private async progress(status: string, body: string, signal = this.context.signal): Promise<void> {
    if (!this.actorId) { const user = await this.api.user(signal); if (!Number.isSafeInteger(user?.id)) throw new SymphonyError('tracker_response', 'Missing GitHub user identity'); this.actorId = user.id; }
    const comments = await this.api.list(`/issues/${this.number}/comments`, signal);
    const previous = comments.find(c => c.user?.id === this.actorId && typeof c.body === 'string' && c.body.startsWith(this.marker));
    const payload = { body: `${this.marker}\n### Symphony: ${status}\n\n${body}` };
    if (previous) await this.api.request('PATCH', `/issues/comments/${previous.id}`, payload, signal);
    else await this.api.request('POST', `/issues/${this.number}/comments`, payload, signal);
  }
  private async addLabel(label: string) {
    try { await this.api.request('GET', `/labels/${encodeURIComponent(label)}`, undefined, this.context.signal); }
    catch (e) {
      if (!(e instanceof GitHubApiError) || e.status !== 404) throw e;
      try { await this.api.request('POST', '/labels', { name: label, color: '7057ff', description: 'Symphony workflow status' }, this.context.signal); }
      catch (created) { if (!(created instanceof GitHubApiError) || created.status !== 422) throw created; }
    }
    await this.api.request('POST', `/issues/${this.number}/labels`, { labels: [label] }, this.context.signal);
  }
  private async handoff(pr: any): Promise<void> {
    if (typeof pr.html_url !== 'string' || !Number.isSafeInteger(pr.number)) throw new SymphonyError('tracker_response', 'Invalid pull request response');
    const closed = pr.state === 'closed' && !pr.merged_at;
    await this.progress(closed ? 'Pull request closed — human input required' : 'Ready for review', `[Pull request #${pr.number}](${pr.html_url})\n\nBranch: \`${this.branch}\`\n${closed ? 'The existing PR was closed without merging. Review the issue before restarting.' : 'Changes are published. Review and merge the PR when ready.'}`);
    await this.addLabel(closed ? this.automation.blockedLabel : this.automation.reviewLabel);
    this.done = true;
    try { await this.api.request('DELETE', `/issues/${this.number}/labels/${encodeURIComponent(this.automation.dispatchLabel)}`, undefined, this.context.signal); }
    catch (e) { if (!this.context.signal.aborted && (!(e instanceof GitHubApiError) || e.status !== 404)) this.context.log('dispatch_label_remove_failed', { error: errorText(e) }); }
    this.context.log('pull_request_handoff', { pull_request_url: pr.html_url, branch: this.branch });
  }
  async prepare(): Promise<boolean> {
    if (!await this.eligibleNow()) { this.done = true; return false; }
    const metadata = await this.api.request('GET', '', undefined, this.context.signal);
    if (norm(metadata.full_name ?? '') !== this.api.repository) throw new SymphonyError('tracker_response', 'Repository scope mismatch');
    this.base = this.automation.baseBranch ?? metadata.default_branch;
    if (typeof this.base !== 'string' || !this.base) throw new SymphonyError('tracker_response', 'Missing default branch');
    const existing = await this.existingPR();
    if (existing) { await this.handoff(existing); return false; }
    await this.git.prepare(this.base); this.prepared = true;
    await this.progress('In progress', `Working on \`${this.branch}\` against \`${this.base}\`. Changes will be checked before publication.`);
    return true;
  }
  private async publish(title: string, summary: string): Promise<unknown> {
    if (!this.prepared) throw new SymphonyError('repository_not_prepared');
    this.assertOpen();
    if (!await this.eligibleNow()) throw new SymphonyError('issue_no_longer_eligible');
    const existing = await this.existingPR();
    if (existing) { await this.handoff(existing); return { url: existing.html_url, recovered: true }; }
    const published = await this.git.publish(title);
    this.context.signal.throwIfAborted();
    const body = `${this.marker}\n${summary}\n\n## Validation\nPassed configured checks: \`${published.checks}\`\nCommit: \`${published.sha}\`\n\nCloses #${this.number}`;
    let pr: any;
    try { pr = await this.api.request('POST', '/pulls', { title, head: this.branch, base: this.base, body, draft: this.automation.draft }, this.context.signal); }
    catch (e) {
      // A response may be lost after GitHub created the PR. Recover before retrying a write.
      pr = await this.existingPR(); if (!pr) throw e;
    }
    await this.handoff(pr);
    return { url: pr.html_url, number: pr.number, branch: this.branch, sha: published.sha, draft: this.automation.draft };
  }
  complete(): boolean { return this.done; }
  async failed(error: unknown, signal = this.context.signal): Promise<void> {
    if (this.done || signal.aborted) return;
    try { await this.progress('Attempt failed — retry scheduled', `The current attempt failed (${error instanceof SymphonyError ? error.category : 'worker_failed'}). Symphony will retry; inspect local logs for details.`, signal); }
    catch { this.context.log('failure_comment_failed'); }
  }
}
