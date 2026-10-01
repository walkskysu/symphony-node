import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { childEnvironment, killTree, launch } from './process.js';
import { SymphonyError } from './types.js';
import type { Config } from './workflow.js';

export interface CommandOptions { cwd: string; signal: AbortSignal; timeout: number; secrets: string[]; env?: NodeJS.ProcessEnv }
export interface CommandResult { code: number; stdout: string; stderr: string }
function collect(child: ChildProcessWithoutNullStreams, options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', settled = false, terminating = false;
    const finish = (error?: Error, code = 0) => {
      if (settled) return; settled = true; clearTimeout(timer); options.signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve({ code, stdout, stderr });
    };
    const terminate = (reason: string) => {
      if (terminating || settled) return; terminating = true;
      void killTree(child).then(() => finish(new SymphonyError(reason)), () => finish(new SymphonyError('process_tree_termination_failed')));
    };
    const abort = () => terminate('canceled');
    const timer = setTimeout(() => terminate('command_timeout'), options.timeout);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2 * 1024 * 1024) terminate('command_output_too_large'); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
    child.stdin.on('error', () => {}); child.stdin.end();
    child.once('error', () => finish(new SymphonyError('command_start_failed')));
    child.once('close', code => { if (!terminating) finish(undefined, code ?? -1); });
    options.signal.addEventListener('abort', abort, { once: true }); if (options.signal.aborted) abort();
  });
}
export function executeFile(file: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  options.signal.throwIfAborted();
  return collect(spawn(file, args, { cwd: options.cwd, env: { ...childEnvironment(options.secrets), ...options.env }, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }), options);
}
export function executeShell(script: string, shell: Config['runtime']['shell'], options: CommandOptions): Promise<CommandResult> {
  options.signal.throwIfAborted();
  return collect(launch(script, options.cwd, shell, options.secrets), options);
}
