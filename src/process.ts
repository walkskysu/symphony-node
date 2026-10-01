import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Config } from './workflow.js';

export function childEnvironment(secretNames: string[]): NodeJS.ProcessEnv {
  const blocked = new Set(secretNames.map(x => x.toUpperCase()));
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !blocked.has(key.toUpperCase())));
}
export function launch(command: string, cwd: string, shell: Config['runtime']['shell'], secretNames: string[] = []): ChildProcessWithoutNullStreams {
  const executable = shell === 'powershell' ? 'powershell.exe' : 'bash';
  const args = shell === 'powershell'
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = New-Object System.Text.UTF8Encoding $false\n${command}\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`, 'utf16le').toString('base64')]
    : ['-lc', command];
  return spawn(executable, args, { cwd, env: childEnvironment(secretNames), windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
}
export async function killTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      const failed = () => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        child.kill(); reject(new Error('process_tree_termination_failed: Windows denied taskkill; child termination could not be verified'));
      };
      killer.once('error', failed);
      killer.once('exit', code => { code === 0 ? resolve() : failed(); });
    });
  } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}
