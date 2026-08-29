#!/usr/bin/env node
// Copy the mint skill from the `mint` submodule into dist/skill so the npm
// package ships it (files: ["dist"]). tsup does not copy non-TS assets.
//
// If the submodule is not initialized (fresh clone without submodule update),
// warn and skip — the package still builds, just without the bundled skill.

import { cp, access, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const src = join(root, 'mint', 'claude-plugin', 'mint-faa-cn', 'skills', 'mint');
const dst = join(root, 'dist', 'skill');

try {
  await access(src);
} catch {
  console.warn('[build-skill] submodule `mint` not initialized — skipping skill copy');
  process.exit(0);
}

await mkdir(dst, { recursive: true });
await cp(src, dst, { recursive: true });
console.log(`[build-skill] copied ${src} -> ${dst}`);
