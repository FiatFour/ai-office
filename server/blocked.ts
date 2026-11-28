export const REPEAT_LIMIT = 3;
export const DISTINCT_LIMIT = 10;
export const REPEAT_WINDOW_MS = 10 * 60_000;
export const MAX_STREAKS = 256;
export const MAX_SITES = 100;
export const SITE_TTL_MS = 24 * 60 * 60_000;
const MAX_ENTRIES = 500;
const MAX_TEXT = 240;
const LAYER = /^(L[1-5]|PF|MS|GS|HG|WH|CG|F[1-5][a-z]?|W[1-3])$/;

export interface Attempt {
  readonly worker: string;
  readonly task: string | null;
  readonly tool: string;
  readonly detail: string;
  readonly layer: string;
  readonly run: string;
  readonly at: number;
}

export interface BlockedEntry extends Attempt {
  readonly seq: number;
  readonly repeats: number;
}

export class InvalidAttempt extends Error {}

const clean = (text: string): string =>
  [...text]
    .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c))
    .join('')
    .slice(0, MAX_TEXT);

const text = (o: Record<string, unknown>, key: string): string => {
  const v = o[key];
  if (typeof v !== 'string' || v === '') throw new InvalidAttempt(`${key} must be a non-empty string`);
  return clean(v);
};

export const parseAttempt = (raw: unknown, now: number): Attempt => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new InvalidAttempt('an attempt is an object');
  const o = raw as Record<string, unknown>;
  const layer = text(o, 'layer');
  if (!LAYER.test(layer)) throw new InvalidAttempt(`layer ${layer} is not a layer code`);
  const task = o.task;
  if (task !== undefined && task !== null && typeof task !== 'string')
    throw new InvalidAttempt('task must be a string');
  return {
    worker: text(o, 'worker'),
    task: typeof task === 'string' && task !== '' ? clean(task) : null,
    tool: text(o, 'tool'),
    detail: text(o, 'detail'),
    layer,
    run: o.run === undefined ? 'hq' : text(o, 'run'),
    at: now,
  };
};

/** One worker's denials at one layer. It ends when `windowMs` passes with no new denial, so a slow retry stays in it. */
interface Streak {
  readonly last: number;
  /** Attempts per distinct tool call and detail. Holds at most `distinct` keys. */
  readonly counts: Map<string, number>;
}

export interface Limits {
  readonly repeat?: number;
  readonly distinct?: number;
  readonly windowMs?: number;
  readonly streaks?: number;
}

export class BlockedLog {
  private readonly list: BlockedEntry[] = [];
  /** Keyed by worker and layer, oldest `last` first. */
  private readonly streaks = new Map<string, Streak>();
  private readonly held = new Set<string>();
  private seq = 0;
  private readonly limits: Required<Limits>;

  constructor(limits: Limits = {}) {
    this.limits = {
      repeat: REPEAT_LIMIT,
      distinct: DISTINCT_LIMIT,
      windowMs: REPEAT_WINDOW_MS,
      streaks: MAX_STREAKS,
      ...limits,
    };
  }

  record(attempt: Attempt): { readonly entry: BlockedEntry; readonly paused: boolean } {
    const { repeat, distinct, windowMs, streaks } = this.limits;
    for (const [id, streak] of this.streaks) {
      if (attempt.at - streak.last < windowMs) break;
      this.streaks.delete(id);
    }
    const id = `${attempt.worker}\u0000${attempt.layer}`;
    const counts = this.streaks.get(id)?.counts ?? new Map<string, number>();
    const key = `${attempt.tool}\u0000${attempt.detail}`;
    const repeats = (counts.get(key) ?? 0) + 1;
    if (counts.has(key) || counts.size < distinct) counts.set(key, repeats);
    this.streaks.delete(id);
    this.streaks.set(id, { last: attempt.at, counts });
    if (this.streaks.size > streaks) this.streaks.delete(this.streaks.keys().next().value as string);

    this.seq += 1;
    const entry: BlockedEntry = { ...attempt, seq: this.seq, repeats };
    this.list.push(entry);
    if (this.list.length > MAX_ENTRIES) this.list.shift();
    const paused = (repeats >= repeat || counts.size >= distinct) && !this.held.has(attempt.worker);
    if (paused) this.held.add(attempt.worker);
    return { entry, paused };
  }

  /** How many worker and layer streaks are held, and the most distinct keys one of them holds. */
  size(): { readonly streaks: number; readonly keys: number } {
    return { streaks: this.streaks.size, keys: Math.max(0, ...[...this.streaks.values()].map((s) => s.counts.size)) };
  }

  entries(): readonly BlockedEntry[] {
    return this.list;
  }

  paused(): readonly string[] {
    return [...this.held].sort();
  }

  isPaused(worker: string): boolean {
    return this.held.has(worker);
  }

  resume(worker: string): boolean {
    for (const id of [...this.streaks.keys()]) if (id.startsWith(`${worker}\u0000`)) this.streaks.delete(id);
    return this.held.delete(worker);
  }
}

export interface BlockedSite {
  readonly site: string;
  readonly host: string;
  readonly port: number;
  readonly agent: string;
  readonly count: number;
  readonly allow: boolean;
}

/**
 * The blocked websites that wait on a person, one entry per site. A site that once drew a denial no Allow can fix
 * (`allow: false`) is never evicted to make room, so a flood of other sites cannot make HQ offer Allow for it again.
 * It leaves only when it has been quiet for `ttlMs`.
 */
export class BlockedSites {
  /** Oldest `last` first. */
  private readonly sites = new Map<string, { readonly view: BlockedSite; readonly last: number }>();
  private readonly max: number;
  private readonly ttlMs: number;

  constructor(max: number = MAX_SITES, ttlMs: number = SITE_TTL_MS) {
    this.max = max;
    this.ttlMs = ttlMs;
  }

  note(denial: Omit<BlockedSite, 'count'>, now: number): void {
    this.expire(now);
    const before = this.sites.get(denial.site)?.view;
    if (before === undefined && this.sites.size >= this.max) {
      const victim = [...this.sites].find(([, held]) => held.view.allow);
      if (victim === undefined) return;
      this.sites.delete(victim[0]);
    }
    this.sites.delete(denial.site);
    this.sites.set(denial.site, {
      view: { ...denial, count: (before?.count ?? 0) + 1, allow: (before?.allow ?? true) && denial.allow },
      last: now,
    });
  }

  get(site: string, now: number): BlockedSite | undefined {
    this.expire(now);
    return this.sites.get(site)?.view;
  }

  list(now: number): readonly BlockedSite[] {
    this.expire(now);
    return [...this.sites.values()].map((held) => held.view);
  }

  private expire(now: number): void {
    for (const [site, held] of this.sites) {
      if (now - held.last < this.ttlMs) break;
      this.sites.delete(site);
    }
  }
}

const htmlEscape = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

export const renderBlocked = (entries: readonly BlockedEntry[], paused: readonly string[]): string => {
  const rows = entries
    .map(
      (e) =>
        `<tr><td>${e.seq}</td><td>${htmlEscape(e.worker)}</td><td>${htmlEscape(e.task ?? '-')}</td><td><code>${htmlEscape(e.tool)}</code> <code>${htmlEscape(e.detail)}</code></td><td>${htmlEscape(e.layer)}</td><td>${e.repeats}</td><td>${htmlEscape(e.run)}</td></tr>`,
    )
    .join('\n');
  const held =
    paused.length === 0
      ? '<p>No worker is paused.</p>'
      : `<p class="paused">Paused: ${paused.map(htmlEscape).join(', ')}</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>BLOCKED ATTEMPTS</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;background:#15181c;color:#e8eaed}h1{font-size:18px;letter-spacing:.08em}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #2c3138;padding:6px 10px;text-align:left;vertical-align:top}th{color:#9aa0a6}code{font:12px ui-monospace,monospace}.paused{color:#ffca28;font-weight:600}</style></head>
<body><h1>BLOCKED ATTEMPTS (${entries.length})</h1>${held}
<table><thead><tr><th>#</th><th>Worker</th><th>Task</th><th>Tool call</th><th>Layer</th><th>Repeats</th><th>Run</th></tr></thead>
<tbody>
${rows}
</tbody></table></body></html>
`;
};
