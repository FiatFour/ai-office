import { FIREWALL_ROWS } from './rows-firewall.mjs';
import { GIT_ROWS } from './rows-git.mjs';
import { HQ_ROWS, NOT_RUN_ROWS } from './rows-hq.mjs';
import { LIVE_ROWS } from './rows-live.mjs';
import { PROTECTED_ROWS } from './rows-protected.mjs';

/**
 * One replayable attack path per id. `run` returns the layers that stopped it (an empty list when nothing did), or a
 * reason it could not run on this host. `lane` is the plan's live lane the row belongs to, or null.
 * @type {Record<string, { lane: number | null, run: (ctx: any) => unknown }>}
 */
export const ATTACKS = {
  ...PROTECTED_ROWS,
  ...LIVE_ROWS,
  ...GIT_ROWS,
  ...FIREWALL_ROWS,
  ...HQ_ROWS,
  ...NOT_RUN_ROWS,
};
