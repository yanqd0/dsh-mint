import { runMint } from './mint.js';
import type { ContentBlockLike, DshContext, ShellLike, ToolDefinitionLike } from './types.js';

export type QueryScope = 'issue' | 'plan' | 'milestone';

export interface MintQueryArgs {
  scope: QueryScope;
  status?: string;
  kind?: string;
  plan?: number;
  label?: string;
  limit?: number;
}

export interface MintIssue {
  id: number;
  title: string;
  status: string;
  priority: number;
  labels: string[];
  plan_id: number | null;
}

export interface MintPlan {
  id: number;
  title: string;
  status: string;
}

export interface MintMilestone {
  id: number;
  title: string;
  version: string;
  status: string;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

interface RawItem {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  priority?: unknown;
  labels?: unknown;
  plan_id?: unknown;
  version?: unknown;
}

/** Map query args to the mint CLI command line for the chosen scope. */
export function buildMintArgs(args: MintQueryArgs): string[] {
  switch (args.scope) {
    case 'issue': {
      const cmd = ['list', '--json', '--no-page'];
      if (args.status) cmd.push('--status', args.status);
      if (args.kind) cmd.push('--kind', args.kind);
      if (args.plan !== undefined) cmd.push('--plan', String(args.plan));
      if (args.label) cmd.push('--label', args.label);
      return cmd;
    }
    case 'plan':
      return ['plan', 'list', '--json'];
    case 'milestone':
      return ['milestone', 'list', '--json'];
  }
}

/** Keep only the fields a model needs; drop transport/durable noise. */
export function compactIssues(items: RawItem[]): MintIssue[] {
  return items.map((item) => ({
    id: typeof item.id === 'number' ? item.id : 0,
    title: typeof item.title === 'string' ? item.title : '',
    status: typeof item.status === 'string' ? item.status : '',
    priority: typeof item.priority === 'number' ? item.priority : 0,
    labels: Array.isArray(item.labels) ? item.labels.filter((l): l is string => typeof l === 'string') : [],
    plan_id: typeof item.plan_id === 'number' ? item.plan_id : null,
  }));
}

function compact(scope: QueryScope, items: RawItem[]): unknown {
  switch (scope) {
    case 'issue':
      return { issues: compactIssues(items) };
    case 'plan':
      return {
        plans: items.map((item) => ({
          id: typeof item.id === 'number' ? item.id : 0,
          title: typeof item.title === 'string' ? item.title : '',
          status: typeof item.status === 'string' ? item.status : '',
        })),
      };
    case 'milestone':
      return {
        milestones: items.map((item) => ({
          id: typeof item.id === 'number' ? item.id : 0,
          title: typeof item.title === 'string' ? item.title : '',
          version: typeof item.version === 'string' ? item.version : '',
          status: typeof item.status === 'string' ? item.status : '',
        })),
      };
  }
}

export interface QueryResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** Run a mint query through the host shell and return a compact summary. */
export async function executeQuery(shell: ShellLike, args: MintQueryArgs): Promise<QueryResult> {
  const result = await runMint(shell, buildMintArgs(args));
  if (!result.ok) {
    return { ok: false, error: result.error ?? 'mint query failed' };
  }
  try {
    const parsed = JSON.parse(result.text ?? '{}') as { items?: RawItem[] };
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    return { ok: true, value: compact(args.scope, items.slice(0, limit)) };
  } catch {
    return { ok: false, error: 'invalid mint JSON output' };
  }
}

/** Render a compact query result as model-facing text. */
export function renderQuery(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Register the `mint_query` tool on `ctx.tools` (closure over ctx.shell). */
export function installMintQuery(ctx: DshContext): (() => void) | undefined {
  const tools = ctx.tools;
  const shell = ctx.shell;
  if (!tools || !shell) {
    return undefined;
  }
  const definition: ToolDefinitionLike = {
    name: 'mint_query',
    description:
      "Query the current project's mint issue tracker (issues/plans/milestones) and return a compact JSON summary.",
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['issue', 'plan', 'milestone'],
          description: 'What to query.',
        },
        status: { type: 'string', description: 'Filter issues by status (open/planned/dev/test/done/dropped).' },
        kind: { type: 'string', enum: ['problem', 'requirement', 'task'], description: 'Filter issues by kind.' },
        plan: { type: 'integer', description: 'Filter issues by plan id.' },
        label: { type: 'string', description: 'Filter issues by label.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results (default 10).' },
      },
      required: ['scope'],
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderQuery(value) } satisfies ContentBlockLike],
    },
    execute: async (rawArgs) => {
      const result = await executeQuery(shell, rawArgs as MintQueryArgs);
      if (!result.ok) {
        throw new Error(result.error ?? 'mint_query failed');
      }
      return result.value;
    },
  };
  return tools.register(definition);
}
