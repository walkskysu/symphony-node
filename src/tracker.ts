import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { localPath, type Config } from './workflow.js';
import { SymphonyError, norm, log, type Issue, type Tracker, type Log } from './types.js';
import { githubAutomationConfig, type GitHubAutomationConfig } from './github-config.js';
import { GitHubApi } from './github-api.js';
import { GitHubRun } from './github-run.js';
import type { RunContext, RunIntegration } from './types.js';
import { githubRepositoryConfigs } from './github-repositories.js';

const nullable = (v: unknown): string | null => typeof v === 'string' ? v : null;
const timestamp = (v: unknown): string | null => typeof v === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/i.test(v) && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
export function normalizeIssue(raw: any): Issue {
  if (!raw || ['id', 'identifier', 'title', 'state'].some(k => typeof raw[k] !== 'string' || !raw[k].trim()) || typeof raw.dispatchable !== 'boolean') throw new SymphonyError('tracker_response', 'Issue lacks required normalized fields');
  return {
    id: raw.id, identifier: raw.identifier, title: raw.title, state: raw.state, dispatchable: raw.dispatchable,
    description: nullable(raw.description), priority: Number.isInteger(raw.priority) ? raw.priority : null,
    branch_name: nullable(raw.branch_name), url: nullable(raw.url), assignee_id: nullable(raw.assignee_id),
    native_ref: raw.native_ref && typeof raw.native_ref === 'object' && !Array.isArray(raw.native_ref) ? raw.native_ref : null,
    labels: [...new Set<string>((Array.isArray(raw.labels) ? raw.labels : []).filter((x: unknown) => typeof x === 'string').map(norm).filter(Boolean))],
    blocked_by: (Array.isArray(raw.blocked_by) ? raw.blocked_by : []).filter((x: any) => x && typeof x === 'object').map((x: any) => ({ id: nullable(x.id), identifier: nullable(x.identifier), state: nullable(x.state) })),
    created_at: timestamp(raw.created_at), updated_at: timestamp(raw.updated_at)
  };
}
export class FileTracker implements Tracker {
  secretEnvironmentNames: string[] = [];
  constructor(private file: string, private logger: Log = log) {}
  private async read(ids?: Set<string>): Promise<Issue[]> {
    let data: any;
    try { data = JSON.parse(await readFile(this.file, 'utf8')); } catch { throw new SymphonyError('tracker_response', 'Cannot read or parse issue JSON'); }
    if (!Array.isArray(data)) throw new SymphonyError('tracker_response', 'Issue JSON must be an array');
    const result: Issue[] = [], seen = new Set<string>(), identifiers = new Set<string>();
    for (const raw of data) {
      if (ids && !ids.has(raw?.id)) continue;
      let issue: Issue;
      try { issue = normalizeIssue(raw); } catch (e) {
        if (ids) throw e;
        this.logger('tracker_record_omitted'); continue;
      }
      if (seen.has(issue.id) || identifiers.has(issue.identifier)) throw new SymphonyError('tracker_response', 'Duplicate issue identity');
      seen.add(issue.id); identifiers.add(issue.identifier); result.push(issue);
    }
    return result;
  }
  async fetchByStates(states: string[]): Promise<Issue[]> {
    if (!states.length) return [];
    const allowed = new Set(states.map(norm));
    return (await this.read()).filter(i => allowed.has(norm(i.state)));
  }
  async fetchByIds(ids: string[]): Promise<Issue[]> { return ids.length ? this.read(new Set(ids)) : []; }
}

const fields = `id identifier title description priority state { name } branchName url assignee { id } labels(first: 250) { nodes { name } pageInfo { hasNextPage } } createdAt updatedAt`;
export class LinearTracker implements Tracker {
  secretEnvironmentNames = ['LINEAR_API_KEY'];
  private endpoint: string; private token: string; private project: string; private assignee?: string;
  constructor(config: Config, private logger: Log = log, private transport: typeof fetch = fetch) {
    const p = config.tracker.provider;
    this.endpoint = p.endpoint ?? 'https://api.linear.app/graphql';
    this.project = p.project_slug;
    this.assignee = p.assignee_id;
    const secret = p.api_key ?? '$LINEAR_API_KEY';
    if (typeof secret !== 'string' || typeof this.project !== 'string' || !this.project.trim() || typeof this.endpoint !== 'string') throw new SymphonyError('invalid_tracker_config', 'linear requires project_slug and api_key');
    let url: URL;
    try { url = new URL(this.endpoint); } catch { throw new SymphonyError('invalid_tracker_config', 'Invalid endpoint URL'); }
    if (url.protocol !== 'https:') throw new SymphonyError('invalid_tracker_config', 'Linear endpoint must use HTTPS');
    if (this.assignee !== undefined && typeof this.assignee !== 'string') throw new SymphonyError('invalid_tracker_config', 'assignee_id must be a string');
    if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(secret)) {
      this.secretEnvironmentNames.push(secret.slice(1)); this.token = process.env[secret.slice(1)] ?? '';
    } else this.token = secret;
    if (!this.token.trim()) throw new SymphonyError('missing_tracker_secret');
  }
  private async query(filter: Record<string, unknown>, strict: boolean): Promise<Issue[]> {
    const result: Issue[] = [], cursors = new Set<string>(), seen = new Set<string>(); let after: string | null = null;
    for (;;) {
      let response: Response;
      try {
        response = await this.transport(this.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: this.token },
          body: JSON.stringify({ query: `query SymphonyIssues($filter: IssueFilter!, $after: String) { issues(first: 50, after: $after, filter: $filter) { nodes { ${fields} } pageInfo { hasNextPage endCursor } } }`, variables: { filter: { and: [{ project: { slugId: { eq: this.project } } }, filter] }, after } }), signal: AbortSignal.timeout(30000) });
      } catch { throw new SymphonyError('tracker_request'); }
      if (response.status === 429) throw new SymphonyError('tracker_rate_limited');
      if (!response.ok) throw new SymphonyError('tracker_status', `HTTP ${response.status}`);
      let data: any;
      try { data = await response.json(); } catch { throw new SymphonyError('tracker_response'); }
      if (data.errors?.length) throw new SymphonyError(data.errors.some((x: any) => x.extensions?.code === 'RATELIMITED') ? 'tracker_rate_limited' : 'tracker_response', 'GraphQL returned errors');
      const page = data.data?.issues;
      if (!Array.isArray(page?.nodes) || typeof page.pageInfo?.hasNextPage !== 'boolean') throw new SymphonyError('tracker_response');
      for (const raw of page.nodes) {
        let issue: Issue;
        try {
          // Never infer a missing required label from a truncated collection.
          if (raw?.labels?.pageInfo?.hasNextPage) throw new SymphonyError('tracker_response', 'Issue labels exceed adapter limit');
          issue = normalizeIssue({ ...raw, state: raw?.state?.name, branch_name: raw?.branchName, assignee_id: raw?.assignee?.id,
            labels: raw?.labels?.nodes?.map((x: any) => x.name), created_at: raw?.createdAt, updated_at: raw?.updatedAt,
            dispatchable: !this.assignee || raw?.assignee?.id === this.assignee, native_ref: { issue_id: raw?.id } });
        } catch (e) { if (strict) throw e; this.logger('tracker_record_omitted'); continue; }
        if (seen.has(issue.id)) throw new SymphonyError('tracker_pagination', 'Duplicate issue in pagination');
        seen.add(issue.id); result.push(issue);
      }
      if (!page.pageInfo.hasNextPage) return result;
      const next = page.pageInfo.endCursor;
      if (typeof next !== 'string' || !next || cursors.has(next)) throw new SymphonyError('tracker_pagination');
      cursors.add(next); after = next;
    }
  }
  async fetchByStates(states: string[]): Promise<Issue[]> {
    if (!states.length) return [];
    // Provider state comparisons can be case-sensitive: fetch scoped pages, compare locally.
    const allowed = new Set(states.map(norm));
    return (await this.query({}, false)).filter(i => allowed.has(norm(i.state)));
  }
  async fetchByIds(ids: string[]): Promise<Issue[]> {
    if (!ids.length) return [];
    const result: Issue[] = [], unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += 50) result.push(...await this.query({ id: { in: unique.slice(i, i + 50) } }, true));
    return result;
  }
}
export function createTracker(config: Config, logger: Log = log): Tracker {
  if (config.tracker.kind === 'github') return config.tracker.provider.repositories !== undefined ? new MultiGitHubTracker(config, logger) : new GitHubTracker(config, logger);
  if (config.tracker.kind === 'linear') return new LinearTracker(config, logger);
  const file = config.tracker.provider.path;
  if (typeof file !== 'string' || !file.trim()) throw new SymphonyError('invalid_tracker_config', 'file provider requires path');
  return new FileTracker(localPath(file, path.dirname(config.workflowPath)), logger);
}

export class GitHubTracker implements Tracker {
  secretEnvironmentNames = ['GITHUB_TOKEN', 'GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
  private repository: string;
  private listUrl: URL;
  private token: string;
  private assignee?: string;
  private automation?: GitHubAutomationConfig;
  constructor(private config: Config, private logger: Log = log, private transport: typeof fetch = fetch) {
    if (config.tracker.provider.repositories !== undefined) throw new SymphonyError('invalid_tracker_config', 'Use MultiGitHubTracker for repositories');
    const p = config.tracker.provider;
    if (typeof p.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.repo) || p.repo.split('/').some((s: string) => s === '.' || s === '..')) throw new SymphonyError('invalid_tracker_config', 'github requires repo in owner/repository format');
    this.repository = p.repo.toLowerCase();
    let endpoint: URL;
    try { endpoint = new URL(p.endpoint ?? 'https://api.github.com'); }
    catch { throw new SymphonyError('invalid_tracker_config', 'Invalid GitHub API endpoint'); }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new SymphonyError('invalid_tracker_config', 'GitHub API endpoint must be an HTTPS base URL without credentials or query');
    this.listUrl = new URL(`${endpoint.href.replace(/\/$/, '')}/repos/${this.repository}/issues`);
    const secret = p.api_key ?? '$GITHUB_TOKEN';
    if (typeof secret !== 'string') throw new SymphonyError('invalid_tracker_config', 'api_key must be a string or environment reference');
    if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(secret)) {
      this.secretEnvironmentNames.push(secret.slice(1)); this.token = process.env[secret.slice(1)] ?? '';
    } else this.token = secret;
    if (!this.token.trim()) throw new SymphonyError('missing_tracker_secret', 'GitHub token is missing');
    if (p.assignee !== undefined && (typeof p.assignee !== 'string' || !p.assignee.trim())) throw new SymphonyError('invalid_tracker_config', 'assignee must be a non-empty GitHub username');
    this.assignee = p.assignee === undefined ? undefined : norm(p.assignee);
    if ([...config.tracker.active_states, ...config.tracker.terminal_states].some(s => !['open', 'closed'].includes(norm(s)))) throw new SymphonyError('invalid_tracker_config', 'GitHub Issues states must be open or closed; use labels for workflow selection');
    this.automation = githubAutomationConfig(config);
  }
  createRunIntegration(context: RunContext): RunIntegration | undefined {
    if (!this.automation) return;
    return new GitHubRun(this.config, this.automation, context, new GitHubApi(this.config.tracker.provider.endpoint ?? 'https://api.github.com', this.repository, this.token, this.transport), this.token, this.secretEnvironmentNames);
  }
  private async request(url: URL, allowMissing = false): Promise<{ response: Response; body: unknown } | null> {
    let response: Response;
    try {
      response = await this.transport(url.href, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'symphony-node/0.1.0' }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    } catch { throw new SymphonyError('tracker_request', 'GitHub request failed or timed out'); }
    if (response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))) throw new SymphonyError('tracker_rate_limited');
    if (allowMissing && [404, 410].includes(response.status)) return null;
    if (!response.ok) throw new SymphonyError('tracker_status', `GitHub HTTP ${response.status}`);
    try { return { response, body: await response.json() }; } catch { throw new SymphonyError('tracker_response', 'Invalid GitHub JSON response'); }
  }
  private normalize(raw: any): Issue {
    if (!raw || !Number.isSafeInteger(raw.number) || raw.number <= 0 || !['open', 'closed'].includes(raw.state)) throw new SymphonyError('tracker_response', 'Invalid GitHub issue identity or state');
    const assignees: any[] = Array.isArray(raw.assignees) ? raw.assignees : raw.assignee ? [raw.assignee] : [];
    const id = `${this.repository}#${raw.number}`;
    const issue = normalizeIssue({
      id, identifier: id, title: raw.title, state: raw.state, description: raw.body, url: raw.html_url,
      labels: Array.isArray(raw.labels) ? raw.labels.map((l: any) => typeof l === 'string' ? l : l?.name) : [],
      assignee_id: typeof assignees[0]?.id === 'number' ? String(assignees[0].id) : null,
      dispatchable: !this.assignee || assignees.some(a => typeof a?.login === 'string' && norm(a.login) === this.assignee),
      native_ref: { repository: this.repository, issue_number: raw.number, issue_id: Number.isSafeInteger(raw.id) ? raw.id : null },
      created_at: raw.created_at, updated_at: raw.updated_at
    });
    if (this.automation && [this.automation.reviewLabel, this.automation.blockedLabel].some(label => issue.labels.includes(norm(label)))) issue.dispatchable = false;
    return issue;
  }
  private nextPage(header: string | null): URL | null {
    if (!header) return null;
    const links = header.split(',').filter(part => /;\s*rel="[^"]*\bnext\b[^"]*"/.test(part));
    if (!links.length) return null;
    if (links.length !== 1) throw new SymphonyError('tracker_pagination', 'Ambiguous next link');
    const match = links[0].match(/^\s*<([^>]+)>/);
    if (!match) throw new SymphonyError('tracker_pagination', 'Invalid next link');
    let next: URL;
    try { next = new URL(match[1]); } catch { throw new SymphonyError('tracker_pagination', 'Invalid next URL'); }
    // Never send credentials to a host or repository supplied by a pagination link.
    if (next.origin !== this.listUrl.origin || next.pathname !== this.listUrl.pathname || next.username || next.password || next.hash) throw new SymphonyError('tracker_pagination', 'Next page left configured repository scope');
    return next;
  }
  async fetchByStates(states: string[]): Promise<Issue[]> {
    const allowed = new Set<string>(states.map(norm).filter(s => s === 'open' || s === 'closed'));
    if (!allowed.size) return [];
    let url: URL | null = new URL(this.listUrl);
    url.search = new URLSearchParams({ state: allowed.size === 2 ? 'all' : [...allowed][0], per_page: '100', sort: 'created', direction: 'asc' }).toString();
    const pages = new Set<string>(), ids = new Set<string>(), result: Issue[] = [];
    while (url) {
      if (pages.has(url.href)) throw new SymphonyError('tracker_pagination', 'Repeated GitHub page');
      pages.add(url.href);
      const page = (await this.request(url))!;
      if (!Array.isArray(page.body)) throw new SymphonyError('tracker_response', 'Expected GitHub issue array');
      for (const raw of page.body) {
        if (raw?.pull_request) continue;
        let issue: Issue;
        try { issue = this.normalize(raw); } catch { this.logger('tracker_record_omitted', { tracker: 'github' }); continue; }
        if (ids.has(issue.id)) throw new SymphonyError('tracker_pagination', 'Duplicate GitHub issue across pages');
        ids.add(issue.id); if (allowed.has(norm(issue.state))) result.push(issue);
      }
      url = this.nextPage(page.response.headers.get('link'));
    }
    return result;
  }
  async fetchByIds(ids: string[]): Promise<Issue[]> {
    const result: Issue[] = [], prefix = `${this.repository}#`;
    for (const id of new Set(ids)) {
      // Opaque IDs are decoded only inside this adapter; foreign scope never triggers a request.
      if (!id.startsWith(prefix)) continue;
      const number = id.slice(prefix.length);
      if (!/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number))) continue;
      const page = await this.request(new URL(`${this.listUrl.href}/${number}`), true);
      if (!page) continue;
      const raw = page.body as any;
      if (raw?.pull_request) continue;
      const issue = this.normalize(raw);
      if (issue.id !== id) throw new SymphonyError('tracker_response', 'GitHub issue identity mismatch');
      result.push(issue);
    }
    return result;
  }
}

export class MultiGitHubTracker implements Tracker {
  readonly secretEnvironmentNames: string[];
  private readonly trackers: Map<string, GitHubTracker>;
  constructor(config: Config, logger: Log = log, transport: typeof fetch = fetch) {
    this.trackers = new Map(githubRepositoryConfigs(config).map(scoped => [scoped.tracker.provider.repo, new GitHubTracker(scoped, logger, transport)]));
    const sharedSecret = config.tracker.provider.api_key;
    const sharedNames = typeof sharedSecret === 'string' && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(sharedSecret) ? [sharedSecret.slice(1)] : [];
    this.secretEnvironmentNames = [...new Set([...sharedNames, ...[...this.trackers.values()].flatMap(t => t.secretEnvironmentNames)])];
    // An agent/test/hook for repository A must not inherit repository B's token.
    for (const tracker of this.trackers.values()) tracker.secretEnvironmentNames = [...this.secretEnvironmentNames];
  }
  private async collect(requests: Promise<Issue[]>[]): Promise<Issue[]> {
    const results = await Promise.allSettled(requests);
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    return results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  }
  fetchByStates(states: string[]): Promise<Issue[]> {
    return this.collect([...this.trackers.values()].map(tracker => tracker.fetchByStates(states)));
  }
  fetchByIds(ids: string[]): Promise<Issue[]> {
    return this.collect([...this.trackers].map(([repo, tracker]) => tracker.fetchByIds(ids.filter(id => id.startsWith(`${repo}#`)))));
  }
  createRunIntegration(context: RunContext): RunIntegration | undefined {
    const repo = context.issue.native_ref?.repository;
    const tracker = typeof repo === 'string' ? this.trackers.get(repo) : undefined;
    if (!tracker || !context.issue.id.startsWith(`${repo}#`)) throw new SymphonyError('invalid_issue_context', 'Issue is outside configured repositories');
    return tracker.createRunIntegration(context);
  }
}
