import { SymphonyError } from './types.js';

export class GitHubApiError extends SymphonyError {
  constructor(public status: number, category = 'tracker_status') { super(category, `GitHub HTTP ${status}`); }
}
export class GitHubApi {
  constructor(private endpoint: string, readonly repository: string, private token: string, private transport: typeof fetch = fetch) {}
  private async send(url: URL, method: string, body: unknown, signal: AbortSignal): Promise<any> {
    let response: Response;
    try {
      response = await this.transport(url.href, { method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'symphony-node/0.1.0', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), redirect: 'manual' });
    } catch { signal.throwIfAborted(); throw new SymphonyError('tracker_request', 'GitHub request failed or timed out'); }
    if (!response.ok) throw new GitHubApiError(response.status, response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'))) ? 'tracker_rate_limited' : 'tracker_status');
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw new SymphonyError('tracker_response', 'Invalid GitHub response'); }
  }
  request(method: string, suffix: string, body: unknown, signal: AbortSignal): Promise<any> {
    if (suffix && !suffix.startsWith('/') && !suffix.startsWith('?')) throw new SymphonyError('invalid_tool_arguments');
    return this.send(new URL(`${this.endpoint.replace(/\/$/, '')}/repos/${this.repository}${suffix}`), method, body, signal);
  }
  user(signal: AbortSignal): Promise<any> { return this.send(new URL(`${this.endpoint.replace(/\/$/, '')}/user`), 'GET', undefined, signal); }
  async list(suffix: string, signal: AbortSignal): Promise<any[]> {
    const result: any[] = [];
    for (let page = 1; page <= 1000; page++) {
      const rows = await this.request('GET', `${suffix}${suffix.includes('?') ? '&' : '?'}per_page=100&page=${page}`, undefined, signal);
      if (!Array.isArray(rows)) throw new SymphonyError('tracker_response', 'Expected GitHub array');
      result.push(...rows); if (rows.length < 100) return result;
    }
    throw new SymphonyError('tracker_pagination', 'GitHub page limit exceeded');
  }
}
