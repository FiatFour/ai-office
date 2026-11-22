export const REPEAT_LIMIT = 3;
export const REPEAT_WINDOW_MS = 10 * 60_000;
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

const fingerprint = (a: Attempt): string => `${a.worker}\u0000${a.layer}\u0000${a.tool}\u0000${a.detail}`;

export class BlockedLog {
  private readonly list: BlockedEntry[] = [];
  private readonly times = new Map<string, number[]>();
  private readonly held = new Map<string, { readonly tool: string; readonly detail: string }>();
  private seq = 0;
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number = REPEAT_LIMIT, windowMs: number = REPEAT_WINDOW_MS) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  record(
    attempt: Attempt,
    { counts = true }: { readonly counts?: boolean } = {},
  ): { readonly entry: BlockedEntry; readonly paused: boolean } {
    const key = fingerprint(attempt);
    const recent = [...(this.times.get(key) ?? []).filter((at) => attempt.at - at < this.windowMs), attempt.at];
    this.times.set(key, recent);
    this.seq += 1;
    const entry: BlockedEntry = { ...attempt, seq: this.seq, repeats: recent.length };
    this.list.push(entry);
    if (this.list.length > MAX_ENTRIES) this.list.shift();
    const paused = counts && recent.length >= this.limit && !this.held.has(attempt.worker);
    if (paused) this.held.set(attempt.worker, { tool: attempt.tool, detail: attempt.detail });
    return { entry, paused };
  }

  entries(): readonly BlockedEntry[] {
    return this.list;
  }

  paused(): readonly string[] {
    return [...this.held.keys()].sort();
  }

  isPaused(worker: string): boolean {
    return this.held.has(worker);
  }

  resume(worker: string): boolean {
    for (const key of [...this.times.keys()]) if (key.startsWith(`${worker}\u0000`)) this.times.delete(key);
    return this.held.delete(worker);
  }

  cleared(tool: string, detail: string): readonly string[] {
    for (const key of [...this.times.keys()]) {
      const [, , keyTool, keyDetail] = key.split('\u0000');
      if (keyTool === tool && keyDetail === detail) this.times.delete(key);
    }
    const resumed = [...this.held]
      .filter(([, cause]) => cause.tool === tool && cause.detail === detail)
      .map(([worker]) => worker);
    for (const worker of resumed) this.held.delete(worker);
    return resumed;
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
