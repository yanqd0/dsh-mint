#!/usr/bin/env node
// Copy the mint skill from this repo's tracked `skill/` directory into
// `dist/skill`, so the npm package ships it (files: ["dist"]). tsup does not
// copy non-TS assets.
//
// `skill/` is the single source of truth and is owned by this repo: the mint
// skill was decoupled from the upstream `mint` submodule (#38). A missing
// source is a hard error — the bundled skill is part of the package contract,
// so the build must not silently produce a skill-less artifact.

import { cp, access, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const src = join(root, 'skill');
const dst = join(root, 'dist', 'skill');

try {
  await access(join(src, 'SKILL.md'));
} catch {
  console.error(`[build-skill] skill source missing: ${src}/SKILL.md`);
  process.exit(1);
}

// Clear the target first: `cp` merges into an existing tree, so files deleted
// from skill/ (e.g. retired references) would otherwise survive into dist/ and
// ship in the package.
await rm(dst, { recursive: true, force: true });
await mkdir(dst, { recursive: true });
await cp(src, dst, { recursive: true });
console.log(`[build-skill] copied ${src} -> ${dst}`);
