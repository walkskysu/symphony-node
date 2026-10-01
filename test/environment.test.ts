import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvironment } from '../src/environment.js';
import { childEnvironment } from '../src/process.js';
import { temp } from './helpers.js';

test('.env supports comments/quotes, preserves existing values, and tolerates a missing file', async () => {
  const root = await temp(), file = path.join(root, '.env');
  const first = 'SYMPHONY_DOTENV_TEST_TOKEN', second = 'SYMPHONY_DOTENV_TEST_EXISTING';
  const previous = [process.env[first], process.env[second]];
  try {
    delete process.env[first]; process.env[second] = 'from-shell';
    await writeFile(file, `# local config\r\n${first}="from-file#quoted"\r\n${second}=from-file\r\n`);
    loadEnvironment(file);
    assert.equal(process.env[first], 'from-file#quoted');
    assert.equal(process.env[second], 'from-shell');
    assert.equal(childEnvironment([first])[first], undefined);
    assert.doesNotThrow(() => loadEnvironment(path.join(root, 'missing')));
  } finally {
    for (const [key, value] of [[first, previous[0]], [second, previous[1]]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  }
});
test('.env read errors are surfaced without file contents', async () => {
  await assert.rejects(async () => loadEnvironment(await temp()), { category: 'env_file_error', message: 'Cannot load .env file' });
});
test('CLI --check loads cwd/.env before validating GitHub even with workflow in a different directory', async () => {
  const cwd = await temp(), workflowRoot = await temp(), file = path.join(workflowRoot, 'WORKFLOW.md');
  const token = 'fake-token-for-local-config-test';
  await writeFile(path.join(cwd, '.env'), `GITHUB_TOKEN=${token}\n`);
  await writeFile(file, '---\ntracker:\n  kind: github\n  provider:\n    repo: owner/repo\n    api_key: $GITHUB_TOKEN\n---\n{{ issue.title }}');
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const output = execFileSync(process.execPath, [cli, file, '--check'], { cwd, env: childEnvironment(['GITHUB_TOKEN']), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(output.includes(token), false);
});
