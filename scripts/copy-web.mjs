import { cp, mkdir } from 'node:fs/promises';
await mkdir(new URL('../dist/src/dashboard/', import.meta.url), { recursive: true });
await cp(new URL('../src/dashboard/', import.meta.url), new URL('../dist/src/dashboard/', import.meta.url), { recursive: true });
