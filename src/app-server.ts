import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { launch, killTree } from './process.js';
import { SymphonyError, errorText, type AgentEvent, type AgentTool } from './types.js';
import type { Config } from './workflow.js';

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
export class AppServer {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private buffer = '';
  private fatal?: Error;
  private turn?: { id?: string; early: Map<string, any>; resolve: () => void; reject: (e: Error) => void; timer?: NodeJS.Timeout };
  private threadId = '';
  private onAbort: () => void;
  private closing?: Promise<void>;
  private toolQueue: Promise<void> = Promise.resolve();
  constructor(private config: Config, private cwd: string, private signal: AbortSignal, private emit: (event: AgentEvent) => void, secrets: string[] = [], private tools: AgentTool[] = [], private onStop: () => void = () => {}) {
    signal.throwIfAborted();
    this.child = launch(config.codex.command, cwd, config.runtime.shell, secrets);
    const decoder = new StringDecoder('utf8');
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.resetSilence();
      this.buffer += decoder.write(chunk);
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > 10 * 1024 * 1024) { this.fail(new SymphonyError('protocol_line_too_large')); return; }
        this.receive(line);
      }
      if (Buffer.byteLength(this.buffer) > 10 * 1024 * 1024) this.fail(new SymphonyError('protocol_line_too_large'));
    });
    // Drain diagnostics separately, without leaking prompt data or secrets into service logs.
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.fail(new SymphonyError('port_exit')));
    this.child.once('error', () => this.fail(new SymphonyError('codex_not_found')));
    this.child.once('exit', code => this.fail(new SymphonyError('port_exit', `App-server exit ${code}`)));
    this.onAbort = () => this.fail(new SymphonyError('canceled'));
    signal.addEventListener('abort', this.onAbort, { once: true });
    if (signal.aborted) this.onAbort();
  }
  private event(event: string, fields: Partial<AgentEvent> = {}) {
    this.emit({ event, timestamp: new Date().toISOString(), pid: this.child.pid, ...fields });
  }
  private send(message: unknown) { if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(message) + '\n'); }
  private request(method: string, params: unknown): Promise<any> {
    if (this.fatal) return Promise.reject(this.fatal);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new SymphonyError('response_timeout', method)); }, this.config.codex.read_timeout_ms);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  private receive(line: string) {
    if (this.fatal) return;
    let message: any;
    try { message = JSON.parse(line); } catch { this.event('malformed'); return; }
    if (!message || typeof message !== 'object') { this.event('malformed'); return; }
    const { method, params = {}, id } = message;
    if (!params || typeof params !== 'object' || Array.isArray(params)) { this.event('malformed'); return; }
    if (!method && id !== undefined) {
      const waiting = this.pending.get(id);
      if (waiting) { clearTimeout(waiting.timer); this.pending.delete(id); message.error ? waiting.reject(new SymphonyError('response_error', 'App-server rejected request')) : waiting.resolve(message.result); }
      return;
    }
    if (id !== undefined && method) {
      if (method === 'item/tool/call') {
        const tool = this.tools.find(t => t.name === params.tool);
        if (!tool || params.threadId !== this.threadId || params.namespace) {
          this.send({ id, result: { success: false, contentItems: [{ type: 'inputText', text: 'Unsupported tool or session' }] } });
          this.event('unsupported_tool_call'); return;
        }
        this.toolQueue = this.toolQueue.then(async () => {
          if (this.fatal || this.closing) return;
          const interval = Math.max(10, Math.min(1000, this.config.codex.turn_timeout_ms / 3, this.config.codex.stall_timeout_ms > 0 ? this.config.codex.stall_timeout_ms / 3 : 1000));
          const heartbeat = setInterval(() => { this.resetSilence(); this.event('host_tool_running'); }, interval);
          this.resetSilence();
          this.event('host_tool_started');
          try {
            const output = await tool.execute(params.arguments);
            if (!this.fatal) this.send({ id, result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(output) }] } });
            this.event('host_tool_completed');
          } catch (e) {
            if (!this.fatal) this.send({ id, result: { success: false, contentItems: [{ type: 'inputText', text: errorText(e).slice(0, 8000) }] } });
            this.event('host_tool_failed');
          } finally { clearInterval(heartbeat); }
        });
        return;
      }
      this.send({ id, error: { code: -32601, message: 'Unattended Symphony does not accept interactive requests' } });
      this.fail(new SymphonyError(method.includes('requestApproval') ? 'approval_required' : 'turn_input_required')); return;
    }
    if (typeof method !== 'string') { this.event('other_message'); return; }
    const fields: Partial<AgentEvent> = { thread_id: params.threadId, turn_id: params.turnId };
    if (method === 'thread/tokenUsage/updated') {
      const total = params.tokenUsage?.total;
      if (total && ['inputTokens', 'outputTokens', 'totalTokens'].every(k => Number.isFinite(total[k]) && total[k] >= 0)) fields.usage = { input_tokens: total.inputTokens, output_tokens: total.outputTokens, total_tokens: total.totalTokens };
    }
    if (method === 'account/rateLimits/updated') fields.rate_limits = params.rateLimits;
    this.event(method, fields);
    if (method === 'turn/completed' && params.threadId === this.threadId && this.turn) {
      if (!this.turn.id) this.turn.early.set(params.turn?.id, params.turn);
      else if (params.turn?.id === this.turn.id) this.finishTurn(params.turn);
    }
  }
  private finishTurn(turn: any) {
    const active = this.turn; if (!active) return;
    clearTimeout(active.timer); this.turn = undefined;
    turn.status === 'completed' ? active.resolve() : active.reject(new SymphonyError(turn.status === 'interrupted' ? 'turn_cancelled' : 'turn_failed'));
  }
  private resetSilence() {
    if (!this.turn) return;
    clearTimeout(this.turn.timer);
    this.turn.timer = setTimeout(() => this.fail(new SymphonyError('turn_timeout')), this.config.codex.turn_timeout_ms);
  }
  private fail(error: Error) {
    if (this.fatal) return; this.fatal = error;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    if (this.turn) { clearTimeout(this.turn.timer); this.turn.reject(error); this.turn = undefined; }
    void this.close().catch(() => this.event('process_tree_termination_failed'));
  }
  async start(title: string): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'symphony_node', title: 'Symphony Node', version: '0.1.0' }, ...(this.tools.length ? { capabilities: { experimentalApi: true } } : {}) });
    this.send({ method: 'initialized', params: {} });
    const result = await this.request('thread/start', { cwd: this.cwd, approvalPolicy: this.config.codex.approval_policy, sandbox: this.config.codex.thread_sandbox,
      ...(this.tools.length ? { dynamicTools: this.tools.map(({ name, description, inputSchema }) => ({ type: 'function', name, description, inputSchema })) } : {}) });
    if (typeof result?.thread?.id !== 'string') throw new SymphonyError('response_error', 'Missing thread identity');
    this.threadId = result.thread.id;
    await this.request('thread/name/set', { threadId: this.threadId, name: title });
  }
  async runTurn(prompt: string): Promise<void> {
    if (this.fatal) throw this.fatal;
    let resolve!: () => void, reject!: (e: Error) => void;
    const completion = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    // Completion may arrive before the response to turn/start. Observe errors immediately.
    void completion.catch(() => {});
    this.turn = { resolve, reject, early: new Map() }; this.resetSilence();
    try {
      const result = await this.request('turn/start', { threadId: this.threadId, cwd: this.cwd, approvalPolicy: this.config.codex.approval_policy,
        sandboxPolicy: this.config.codex.turn_sandbox_policy, input: [{ type: 'text', text: prompt, text_elements: [] }] });
      const id = result?.turn?.id;
      if (typeof id !== 'string') throw new SymphonyError('response_error', 'Missing turn identity');
      this.event('session_started', { thread_id: this.threadId, turn_id: id });
      if (this.turn) { this.turn.id = id; const early = this.turn.early.get(id); this.turn.early.clear(); if (early) this.finishTurn(early); }
      await completion;
    } catch (e) {
      this.fail(e instanceof Error ? e : new SymphonyError('turn_failed')); throw e;
    }
  }
  async close(): Promise<void> {
    if (!this.closing) {
      this.signal.removeEventListener('abort', this.onAbort);
      this.onStop();
      this.closing = Promise.all([killTree(this.child), this.toolQueue]).then(() => {});
    }
    await this.closing;
  }
}
