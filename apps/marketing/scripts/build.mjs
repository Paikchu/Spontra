import { cpSync, mkdirSync, rmSync } from 'node:fs';

const output = new URL('../dist/', import.meta.url);
rmSync(output, { recursive: true, force: true });
mkdirSync(new URL('en/', output), { recursive: true });
cpSync(new URL('../public/', import.meta.url), output, { recursive: true });
rmSync(new URL('product/.gitkeep', output), { force: true });
await import('./render-marketing.mjs');
