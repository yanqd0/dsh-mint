import { installSkill } from './install-skill.js';

// The postinstall entry (`node dist/install-skill.js`). Executed directly by
// the package manager — never imported by the plugin. The sync never fails the
// install: installSkill resolves every failure to `{ ok: false }` after a log
// line, and this module has no top-level await or throw.
installSkill();
