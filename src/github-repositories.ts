import type { Config } from './workflow.js';
import { SymphonyError } from './types.js';

// Resolve once into single-repository configurations so reads and publication
// always use the same repository-specific credentials and automation settings.
export function githubRepositoryConfigs(config: Config): Config[] {
  const p = config.tracker.provider;
  const invalid = (message: string): never => { throw new SymphonyError('invalid_tracker_config', message); };
  if (p.automation !== undefined && (!p.automation || typeof p.automation !== 'object' || Array.isArray(p.automation))) invalid('GitHub automation must be a map');
  if (p.repositories !== undefined && p.repo !== undefined) invalid('Use repo or repositories, not both');
  const entries = p.repositories === undefined ? [p.repo] : p.repositories;
  if (!Array.isArray(entries) || !entries.length) invalid('repositories must be a non-empty list');
  const seen = new Set<string>();
  return entries.map((entry: unknown) => {
    const override = typeof entry === 'string' ? { repo: entry } : entry;
    if (!override || typeof override !== 'object' || Array.isArray(override)) return invalid('Each repository must be owner/repository or a configuration map');
    const values = override as Record<string, any>;
    if (Object.keys(values).some(key => !['repo', 'api_key', 'assignee', 'automation'].includes(key))) invalid('Unsupported repository override; use repo, api_key, assignee or automation');
    if (typeof values.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repo) || values.repo.split('/').some((s: string) => s === '.' || s === '..')) invalid('github requires repo in owner/repository format');
    const repo = values.repo.toLowerCase();
    if (seen.has(repo)) invalid('Duplicate GitHub repository');
    seen.add(repo);
    const provider: Record<string, any> = { ...p, ...values, repo };
    delete provider.repositories;
    if (values.automation !== undefined) {
      if (!values.automation || typeof values.automation !== 'object' || Array.isArray(values.automation)) invalid('Repository automation must be a map');
      provider.automation = { ...p.automation, ...values.automation };
    }
    return { ...config, tracker: { ...config.tracker, provider } };
  });
}
