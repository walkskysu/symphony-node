import path from 'node:path';
import { lstat, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { executeFile, executeShell, type CommandOptions } from './command.js';
import { SymphonyError, type RunContext } from './types.js';
import type { Config } from './workflow.js';
import type { GitHubAutomationConfig } from './github-config.js';
import { WorkspaceManager } from './workspace.js';

interface Ownership { repository: string; issueId: string; branch: string; base: string; baseSha?: string }
export interface PublishResult { sha: string; branch: string; checks: string }
export class GitWorkspace {
  private ownership!: Ownership;
  private get branch() { return `symphony/issue-${this.number}`; }
  constructor(private context: RunContext, private config: Config, private automation: GitHubAutomationConfig,
    private repository: string, private number: number, private remote: string, private token: string, private secrets: string[]) {}
  private options(auth = false, timeout = this.automation.gitTimeout): CommandOptions {
    const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_COUNT: '0' };
    if (auth && /^https:\/\//.test(this.remote)) {
      env.GIT_CONFIG_COUNT = '1'; env.GIT_CONFIG_KEY_0 = `http.${new URL(this.remote).origin}/.extraheader`;
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${this.token}`).toString('base64')}`;
    }
    return { cwd: this.context.workspace, signal: this.context.signal, timeout, secrets: [...this.secrets, ...Object.keys(process.env).filter(k => k.toUpperCase().startsWith('GIT_'))], env };
  }
  private async git(args: string[], auth = false, allowed = [0]): Promise<string> {
    this.context.signal.throwIfAborted(); await new WorkspaceManager(this.config).validate(this.context.workspace);
    const result = await executeFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'http.followRedirects=false',
      '-c', `user.name=${this.automation.authorName}`, '-c', `user.email=${this.automation.authorEmail}`, ...args], this.options(auth));
    if (!allowed.includes(result.code)) throw new SymphonyError('git_failed', `git ${args[0]} failed (exit ${result.code}); check repository access, branch history and Git installation`);
    return result.stdout.trim();
  }
  private async saveOwnership() {
    const file = path.join(this.context.workspace, '.git', 'symphony-owner.json');
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.ownership)); await rename(temporary, file);
  }
  async prepare(base: string): Promise<void> {
    if (base === this.branch) throw new SymphonyError('invalid_tracker_config', 'Base branch cannot be the Symphony issue branch');
    await this.git(['check-ref-format', '--branch', base]);
    const dotgit = path.join(this.context.workspace, '.git');
    let exists = false;
    try { const stat = await lstat(dotgit); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SymphonyError('git_workspace_invalid'); exists = true; }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    this.ownership = { repository: this.repository, issueId: this.context.issue.id, branch: this.branch, base };
    if (!exists) {
      await this.git(['init', '.']); await this.saveOwnership();
      await this.git(['remote', 'add', 'origin', this.remote]);
    } else {
      let previous: Ownership;
      try { previous = JSON.parse(await readFile(path.join(dotgit, 'symphony-owner.json'), 'utf8')); }
      catch { throw new SymphonyError('git_workspace_unowned', 'Existing repository has no Symphony ownership record; use a new workspace root'); }
      if (previous.repository !== this.repository || previous.issueId !== this.context.issue.id || previous.branch !== this.branch || previous.base !== base) throw new SymphonyError('git_workspace_mismatch');
      this.ownership = previous;
    }
    const origin = await this.git(['config', '--get', 'remote.origin.url'], false, [0, 1]);
    if (!origin) await this.git(['remote', 'add', 'origin', this.remote]);
    else if (origin !== this.remote) throw new SymphonyError('git_remote_mismatch');
    await this.git(['fetch', '--no-tags', this.remote, `refs/heads/${base}`], true);
    if (!this.ownership.baseSha) { this.ownership.baseSha = await this.git(['rev-parse', 'FETCH_HEAD']); await this.saveOwnership(); }
    const local = await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${this.branch}`], false, [0, 1]);
    if (!local) {
      const remoteBranch = await this.git(['ls-remote', '--heads', this.remote, `refs/heads/${this.branch}`], true);
      if (remoteBranch) {
        await this.git(['fetch', '--no-tags', this.remote, `refs/heads/${this.branch}`], true);
        await this.git(['checkout', '-b', this.branch, 'FETCH_HEAD']);
      } else await this.git(['checkout', '-b', this.branch, this.ownership.baseSha!]);
    }
    if (await this.git(['branch', '--show-current']) !== this.branch) throw new SymphonyError('git_branch_mismatch', 'Workspace changed branch; refusing to overwrite local work');
    this.context.log('repository_prepared', { branch: this.branch, base });
  }
  private async guard() {
    const dotgit = await lstat(path.join(this.context.workspace, '.git'));
    if (!dotgit.isDirectory() || dotgit.isSymbolicLink()) throw new SymphonyError('git_workspace_invalid');
    if (await this.git(['branch', '--show-current']) !== this.branch) throw new SymphonyError('git_branch_mismatch');
    if (await this.git(['config', '--get', 'remote.origin.url']) !== this.remote) throw new SymphonyError('git_remote_mismatch');
  }
  async publish(commitMessage: string): Promise<PublishResult> {
    await this.guard();
    this.context.log('checks_started');
    const result = await executeShell(this.automation.testCommand, this.config.runtime.shell, { ...this.options(false, this.automation.testTimeout), env: undefined });
    if (result.code !== 0) {
      // Return useful bounded diagnostics to the agent; tracker secrets are absent from this child.
      throw new SymphonyError('checks_failed', `Checks exited ${result.code}\n${(result.stdout + '\n' + result.stderr).slice(-6000)}`);
    }
    await this.guard();
    const files = await this.git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
    if (files.split('\0').some(file => /(^|\/)\.env(?:\.|$)/i.test(file) && !/\.env\.(example|sample)$/i.test(file))) throw new SymphonyError('sensitive_file_in_commit', 'An environment file is tracked or unignored; remove it from the commit before publishing');
    await this.git(['add', '--all', '--', '.']);
    const changes = await this.git(['diff', '--cached', '--name-only']);
    if (changes) await this.git(['commit', '-m', commitMessage]);
    if (!Number(await this.git(['rev-list', '--count', `${this.ownership.baseSha}..HEAD`]))) throw new SymphonyError('no_changes', 'There are no commits for a pull request');
    const sha = await this.git(['rev-parse', 'HEAD']);
    // Explicit single branch refspec; never force-push or push a configured default branch.
    await this.git(['push', this.remote, `HEAD:refs/heads/${this.branch}`], true);
    this.context.log('branch_pushed', { branch: this.branch, sha });
    return { sha, branch: this.branch, checks: this.automation.testCommand };
  }
}
