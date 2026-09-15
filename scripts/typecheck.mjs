// Standalone type-check (no emit) driven through the TypeScript compiler API.
import { ROOT, compileOnce } from './compile.mjs';
import fs from 'node:fs';
import path from 'node:path';

const tmp = path.join(ROOT, '.typecheck');
const { ok } = compileOnce(tmp);
fs.rmSync(tmp, { recursive: true, force: true });
if (!ok) process.exit(1);
console.log('Type check passed.');
