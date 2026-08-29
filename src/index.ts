import { z } from 'zod';

/** dsh-mint — DSH plugin integrating the mint issue tracker into DSH sessions. */
export const name = 'dsh-mint';

/** Services this plugin consumes (filled in by #3–#6). */
export const inject = {};

export const Config = z.object({
  /** Reserved for mount-line config — features land in #3–#6. */
  debug: z.boolean().default(false),
});

export type Config = z.infer<typeof Config>;

/**
 * Host-face entry. Currently a skeleton — context injection (#3), event
 * reminders (#4), plan binding (#5) and the mint_query tool (#6) land here.
 * `ctx` is the DSH host Context; typed precisely once features land (#3–#6).
 */
export function apply(_ctx: unknown, _config: Config): void {
  // #3–#6
}
