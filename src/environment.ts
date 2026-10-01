import { loadEnvFile } from 'node:process';
import path from 'node:path';
import { SymphonyError } from './types.js';

/** Load cwd/.env once at startup; explicitly supplied environment values win. */
export function loadEnvironment(file = path.resolve('.env')): void {
  try { loadEnvFile(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    // Do not include file contents or parser details that might contain secrets.
    throw new SymphonyError('env_file_error', 'Cannot load .env file');
  }
}
