export interface Issue {
  id: string; identifier: string; title: string; description: string | null;
  priority: number | null; state: string; branch_name: string | null; url: string | null;
  assignee_id: string | null; labels: string[];
  blocked_by: { id: string | null; identifier: string | null; state: string | null }[];
  dispatchable: boolean; native_ref: Record<string, unknown> | null;
  created_at: string | null; updated_at: string | null;
}
export interface Tracker {
  fetchByStates(states: string[]): Promise<Issue[]>;
  fetchByIds(ids: string[]): Promise<Issue[]>;
  secretEnvironmentNames: string[];
  restartIssue?(id: string): Promise<Issue>;
  createRunIntegration?(context: RunContext): RunIntegration | undefined;
}
export interface RunContext { issue: Issue; workspace: string; signal: AbortSignal; log: Log }
export interface AgentTool {
  name: string; description: string; inputSchema: Record<string, unknown>;
  execute(arguments_: unknown): Promise<unknown>;
}
export interface RunIntegration {
  tools: AgentTool[];
  instructions: string;
  prepare(): Promise<boolean>; // false means an existing handoff was recovered; no agent needed.
  complete(): boolean;
  failed(error: unknown, signal?: AbortSignal): Promise<void>;
}
export class SymphonyError extends Error {
  constructor(public category: string, message: string = category) { super(message); this.name = 'SymphonyError'; }
}
export const norm = (s: string): string => s.trim().toLowerCase();
export const errorText = (e: unknown): string => e instanceof SymphonyError ? `${e.category}: ${e.message}` : e instanceof Error ? e.message : String(e);
export type Log = (event: string, fields?: Record<string, unknown>) => void;
export const log: Log = (event, fields = {}) => {
  try { process.stderr.write(JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields }) + '\n'); } catch { /* A broken logging sink must not kill scheduling. */ }
};
export interface AgentEvent { event: string; timestamp: string; pid?: number; thread_id?: string; turn_id?: string; usage?: { input_tokens: number; output_tokens: number; total_tokens: number }; rate_limits?: unknown }
