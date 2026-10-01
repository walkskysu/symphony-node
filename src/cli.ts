import path from 'node:path';
import { parseArgs } from 'node:util';
import { Orchestrator } from './orchestrator.js';
import { startServer } from './server.js';
import { loadWorkflow } from './workflow.js';
import { createTracker } from './tracker.js';
import { errorText, log } from './types.js';
import { loadEnvironment } from './environment.js';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { port: { type: 'string' }, check: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) { console.log('Usage: npm start -- [WORKFLOW.md] [--port 8080] [--check]\n--check validates configuration without running agents.'); return; }
  if (positionals.length > 1) throw new Error('Expected at most one workflow path');
  loadEnvironment();
  const file = path.resolve(positionals[0] ?? 'WORKFLOW.md');
  const workflow = await loadWorkflow(file); createTracker(workflow.config);
  const port = values.port === undefined ? workflow.config.server.port : /^\d+$/.test(values.port) ? Number(values.port) : NaN;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error('Invalid --port');
  if (values.check) { log('configuration_valid', { workflow: file }); return; }
  const orchestrator = new Orchestrator(file);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    if (server) { server.close(); server.closeIdleConnections(); }
    await orchestrator.stop();
  };
  try {
    // Bind before dispatch, so port failures cannot leave unattended workers running.
    if (port !== undefined) { server = await startServer(orchestrator, port); log('http_started', { address: server.address() }); }
    await orchestrator.start();
    process.on('SIGINT', () => { void shutdown(); });
    process.on('SIGTERM', () => { void shutdown(); });
    process.on('message', message => { if (message === 'shutdown') void shutdown(); });
  } catch (e) { await shutdown(); throw e; }
}
main().catch(e => { log('startup_failed', { error: errorText(e) }); process.exitCode = 1; });
