import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SymphonyError, log, errorText, type Log } from './types.js';
import type { Config } from './workflow.js';
import { launch, killTree } from './process.js';

export function workspaceKey(identifier: string): string {
  const key = identifier.replace(/[^A-Za-z0-9._-]/g, '_');
  // Windows device names, trailing dots and dot traversal cannot be directory keys.
  if (!key || /^\.{1,2}$/.test(key) || /[.]$/.test(key) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(key)) throw new SymphonyError('invalid_workspace_key');
  return key === identifier ? key : `${key}-${createHash('sha256').update(identifier).digest('hex').slice(0, 16)}`;
}
export function assertContained(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new SymphonyError('invalid_workspace_cwd');
}
export class WorkspaceManager {
  constructor(private config: Config, private logger: Log = log, private secrets: string[] = []) {}
  pathFor(identifier: string): string {
    const target = path.resolve(this.config.workspace.root, workspaceKey(identifier));
    assertContained(this.config.workspace.root, target); return target;
  }
  async validate(target: string): Promise<void> {
    assertContained(this.config.workspace.root, target);
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SymphonyError('invalid_workspace_cwd', 'Workspace must be a real directory');
    assertContained(await realpath(this.config.workspace.root), await realpath(target));
  }
  async prepare(identifier: string, signal?: AbortSignal): Promise<string> {
    const target = this.pathFor(identifier);
    signal?.throwIfAborted();
    await mkdir(this.config.workspace.root, { recursive: true });
    let created = false;
    try { await mkdir(target); created = true; } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
    await this.validate(target);
    if (created) {
      try { await this.hook('after_create', target, signal); }
      catch (e) { await this.validate(target); await rm(target, { recursive: true }); throw e; }
    }
    return target;
  }
  async hook(name: string, target: string, signal?: AbortSignal): Promise<void> {
    const script = this.config.hooks.scripts[name];
    if (!script) return;
    const bestEffort = ['after_run', 'before_remove'].includes(name);
    try {
      signal?.throwIfAborted(); await this.validate(target);
      this.logger('hook_started', { hook: name });
      const child = launch(script, target, this.config.runtime.shell, this.secrets);
      child.stdout.resume(); child.stderr.resume();
      await new Promise<void>((resolve, reject) => {
        let finished = false, terminationError: Error | undefined;
        const finish = (e?: Error) => {
          if (finished) return; finished = true;
          clearTimeout(timer); signal?.removeEventListener('abort', abort);
          e ? reject(e) : resolve();
        };
        const terminate = (e: Error) => { terminationError = e; void killTree(child).then(() => finish(e), failure => finish(failure)); };
        const abort = () => terminate(new SymphonyError('hook_canceled'));
        const timer = setTimeout(() => terminate(new SymphonyError('hook_timeout')), this.config.hooks.timeout_ms);
        child.once('error', () => finish(new SymphonyError('hook_failed', 'Shell could not start')));
        child.once('close', code => finish(terminationError ?? (code === 0 ? undefined : new SymphonyError('hook_failed', `Exit ${code}`))));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      this.logger('hook_completed', { hook: name });
    } catch (e) { this.logger('hook_failed', { hook: name, error: errorText(e) }); if (!bestEffort) throw e; }
  }
  async remove(identifier: string): Promise<void> {
    const target = this.pathFor(identifier);
    try { await lstat(target); } catch (e: any) { if (e.code === 'ENOENT') return; throw e; }
    await this.validate(target); await this.hook('before_remove', target); await this.validate(target);
    await rm(target, { recursive: true, force: true });
  }
}
