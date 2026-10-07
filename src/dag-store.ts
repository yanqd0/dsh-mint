/**
 * The plan DAG's file layer (plan #31): `/tmp/mint/dag/<sessionId>.json`.
 *
 * The panel and the tool both read one small JSON document per session, and the
 * write side is a read-modify-write across an out-of-process boundary (the file
 * is shared with anything else watching `/tmp`), so two rules carry the whole
 * design:
 *
 * - **Atomic replace**: a write lands in a temporary file in the same directory
 *   and is `rename`d over the target, so a reader never sees half a document.
 * - **One lock per session**: parallel tool calls (the host runs them
 *   concurrently) are chained on a promise, so the second write starts from the
 *   first one's result instead of clobbering it.
 *
 * The lock is per process by construction; a second harness on the same machine
 * is outside its reach (documented as a known limitation, not a bug).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { isValidDagSession, parseDagDoc } from './dag.js';
import type { DagDoc } from './dag.js';

/**
 * Where the documents live.
 *
 * `/tmp` on purpose: the DAG is a **live** view of a running plan, and a reboot
 * clearing it is the documented, tolerated normal state (the panel then shows
 * its empty state). Nothing here tries to outlive the machine.
 */
export const DAG_DIR = '/tmp/mint/dag';

/** A session id that may not become a path segment. */
export class DagPathError extends Error {}

/** One document's path. The id is validated here, before any concatenation. */
export function dagFilePath(sessionId: string, dir: string = DAG_DIR): string {
  if (!isValidDagSession(sessionId)) {
    throw new DagPathError(`invalid dag session id: ${JSON.stringify(sessionId)}`);
  }
  return join(dir, `${sessionId}.json`);
}

/** What a read found: no file, a document, or a file that cannot be trusted. */
export type DagRead =
  | { state: 'missing'; file: string }
  | { state: 'ok'; file: string; doc: DagDoc }
  | { state: 'unreadable'; file: string; error: string };

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read one session's document.
 *
 * A missing file is a **normal** answer (`state: 'missing'`), never an error:
 * "this session has no DAG yet" is the state every session starts in, and the
 * route answers it as `dag: null` rather than a failure.
 *
 * @param sessionId - the owning (root) session id.
 * @param dir - the DAG directory; tests point it at a temp directory.
 */
export async function readDag(sessionId: string, dir: string = DAG_DIR): Promise<DagRead> {
  const file = dagFilePath(sessionId, dir);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return { state: 'missing', file };
    return { state: 'unreadable', file, error: messageOf(error) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { state: 'unreadable', file, error: `invalid JSON: ${messageOf(error)}` };
  }
  const parsed = parseDagDoc(raw);
  if ('error' in parsed) return { state: 'unreadable', file, error: parsed.error };
  if (parsed.doc.session !== sessionId) {
    return { state: 'unreadable', file, error: `document belongs to session ${parsed.doc.session}` };
  }
  return { state: 'ok', file, doc: parsed.doc };
}

/**
 * What one locked read-modify-write decides.
 *
 * `skip` is the "nothing to do" answer (a subagent settled with no DAG, an
 * unreadable file a lifecycle listener must not clobber); `error` is a refusal
 * the caller reports. Anything else is the document to store.
 */
export type DagMutation = (state: DagRead) => { doc: DagDoc } | { skip: true } | { error: string };

/** The outcome of one {@link updateDag}: the stored document, or why not. */
export type DagUpdate =
  | { ok: true; doc: DagDoc }
  | { ok: true; skipped: true }
  | { ok: false; error: string };

/** In-flight writes per session, so a second one starts after the first lands. */
const locks = new Map<string, Promise<unknown>>();

/**
 * Chain `task` after every write already queued for this session.
 *
 * The map holds the *settled* continuation rather than the task itself, so a
 * rejected task does not poison the next one and the entry disappears once the
 * chain drains (the plugin's lifetime is long; an unbounded map would not be).
 */
function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settle = (): void => {
    if (locks.get(key) === settled) locks.delete(key);
  };
  const settled = run.then(settle, settle);
  locks.set(key, settled);
  return run;
}

/** Replace the file atomically: temporary sibling, then `rename` over the target. */
async function writeAtomic(file: string, doc: DagDoc): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * Run one read-modify-write under the session's lock.
 *
 * @param sessionId - the owning (root) session id.
 * @param mutate - decides the next document from what is on disk right now.
 * @param dir - the DAG directory; tests point it at a temp directory.
 */
export async function updateDag(
  sessionId: string,
  mutate: DagMutation,
  dir: string = DAG_DIR
): Promise<DagUpdate> {
  const file = dagFilePath(sessionId, dir);
  return withLock(file, async (): Promise<DagUpdate> => {
    const state = await readDag(sessionId, dir);
    const decision = mutate(state);
    if ('skip' in decision) return { ok: true, skipped: true };
    if ('error' in decision) return { ok: false, error: decision.error };
    try {
      await writeAtomic(file, decision.doc);
    } catch (error) {
      return { ok: false, error: `写入 DAG 失败：${messageOf(error)}` };
    }
    return { ok: true, doc: decision.doc };
  });
}
