import { SymphonyError, norm } from './types.js';
import type { Config } from './workflow.js';

export interface GitHubAutomationConfig {
  baseBranch?: string; testCommand: string; testTimeout: number; gitTimeout: number;
  reviewLabel: string; blockedLabel: string; dispatchLabel: string;
  draft: boolean; authorName: string; authorEmail: string;
}
export function githubAutomationConfig(config: Config): GitHubAutomationConfig | undefined {
  const value = config.tracker.provider.automation;
  if (value === undefined) return;
  const invalid = (message: string): never => { throw new SymphonyError('invalid_tracker_config', `github automation: ${message}`); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('must be a map');
  if (value.enabled === false) return;
  if (value.enabled !== true) invalid('enabled must be true or false');
  const str = (key: string, fallback?: string): string => {
    const v = value[key] ?? fallback;
    if (typeof v !== 'string' || !v.trim()) return invalid(`${key} must be a non-empty string`);
    return v;
  };
  const timeout = (key: string, fallback: number): number => {
    const v = value[key] ?? fallback;
    if (!Number.isSafeInteger(v) || v <= 0) return invalid(`${key} must be a positive integer`);
    return v;
  };
  const baseBranch = value.base_branch === undefined ? undefined : str('base_branch');
  if (baseBranch && (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(baseBranch) || baseBranch.includes('..') || baseBranch.endsWith('.lock') || baseBranch.endsWith('/'))) invalid('invalid base_branch');
  const reviewLabel = str('review_label', 'symphony:review'), blockedLabel = str('blocked_label', 'symphony:blocked');
  const dispatchLabel = config.tracker.required_labels[0];
  if (!dispatchLabel || !config.tracker.required_labels.every(Boolean)) invalid('at least one required_labels entry is required');
  if (norm(reviewLabel) === norm(blockedLabel) || [reviewLabel, blockedLabel].some(l => config.tracker.required_labels.includes(norm(l)))) invalid('review/blocked labels must be distinct from dispatch labels');
  if (value.draft !== undefined && typeof value.draft !== 'boolean') invalid('draft must be boolean');
  return { baseBranch, testCommand: str('test_command'), testTimeout: timeout('test_timeout_ms', 600000), gitTimeout: timeout('git_timeout_ms', 120000),
    reviewLabel, blockedLabel, dispatchLabel, draft: value.draft ?? true, authorName: str('author_name', 'Symphony'), authorEmail: str('author_email', 'symphony@localhost') };
}
