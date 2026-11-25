import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRuntime } from '../agents/runtime.ts';
import { scripted } from '../agents/scripted.ts';
import { github } from '../githost/github.ts';
import { type RunningHq, startHq } from '../hq.ts';
import { cagesMode } from '../modes/cages.ts';
import { FakeGithub } from './fakes/github-api.ts';
import { SCRIPTS, TICKETS } from './fixtures/factory.ts';
import { hasSqlite, human, tempDir } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8').replaceAll('\r\n', '\n');
const CORE = 'packages/core/src/lifecycle.ts';
const LIFECYCLE_DOC = 'docs/lifecycle.md';

type Sources = Readonly<Record<string, string>>;
type Json = Record<string, unknown>;

// A type with a table in the doc. `extra` names declarations whose fields belong to the same table.
export const TYPES: ReadonlyArray<{ name: string; file: string; extra?: readonly string[] }> = [
  { name: 'Snapshot', file: 'server/snapshot.ts' },
  { name: 'State', file: CORE },
  { name: 'Config', file: CORE },
  { name: 'Box', file: CORE, extra: ['BoxBase'] },
  { name: 'Stamped', file: CORE },
  { name: 'RegistryView', file: 'server/registry.ts' },
  { name: 'Factory', file: 'server/registry.ts' },
  { name: 'RepoEntry', file: 'server/registry.ts' },
  { name: 'CageView', file: 'server/sandbox/container.ts' },
  { name: 'Denial', file: 'server/snapshot.ts' },
  { name: 'BlockedEntry', file: 'server/blocked.ts', extra: ['Attempt'] },
  { name: 'OutboxEntry', file: 'server/store/store.ts' },
  { name: 'ModeView', file: 'server/modes/cages.ts' },
  { name: 'Usage', file: 'server/agents/runtime.ts' },
  { name: 'ActionItem', file: 'server/modes/cages.ts' },
];

const BUILTIN = new Set(['Readonly', 'ReadonlyArray', 'Record', 'Partial', 'Omit', 'Array', 'Set', 'Map', 'Promise']);
// Named in a table above through `extra`.
const MERGED = new Set(['BoxBase', 'Attempt']);

const sorted = (items: Iterable<string>): string[] => [...items].sort();
const same = (a: Iterable<string>, b: Iterable<string>): boolean => sorted(a).join('\n') === sorted(b).join('\n');

export const strip = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\w])\/\/.*$/gm, '$1');

// A declaration, not an import of the same name.
const declares = (name: string): RegExp =>
  new RegExp(`(?:export )?(interface|type) ${name}\\b\\s*(?:<[^>]*>)?\\s*(?:=|\\{|extends)`);

// The text of `interface Name ...` or `type Name = ...`, cut by brace depth. Pass comment-free source.
export const declaration = (source: string, name: string): string => {
  const start = declares(name).exec(source);
  if (start === null) throw new Error(`no declaration of ${name}`);
  const isInterface = start[1] === 'interface';
  let depth = 0;
  for (let i = start.index; i < source.length; i += 1) {
    const c = source[i];
    if (c === '{') {
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0 && isInterface) return source.slice(start.index, i + 1);
    } else if (c === ';' && depth === 0 && !isInterface) {
      return source.slice(start.index, i);
    }
  }
  throw new Error(`${name} is not closed`);
};

// Field paths of a declaration. A field of an inline object gets its parent as a prefix, so `hq.pid` is not `pid`.
// Union variants share the top level. `kind` is the union tag and is left out.
export const pathsOf = (text: string): Set<string> => {
  const out = new Set<string>();
  const prefixes: string[] = [''];
  let last = '';
  for (const m of text.matchAll(/(?:readonly\s+)?(\w+)\??\s*:|[{}]/g)) {
    if (m[0] === '{') {
      const before = text.slice(0, m.index).trimEnd().slice(-1);
      prefixes.push(before === ':' ? `${last}.` : (prefixes.at(-1) as string));
    } else if (m[0] === '}') {
      prefixes.pop();
    } else if (m[1] !== 'kind') {
      last = `${prefixes.at(-1)}${m[1]}`;
      out.add(last);
    }
  }
  return out;
};

export const codeFields = (sources: Sources, type: (typeof TYPES)[number]): Set<string> => {
  const source = strip(sources[type.file] as string);
  const out = new Set<string>();
  for (const name of [type.name, ...(type.extra ?? [])])
    for (const path of pathsOf(declaration(source, name))) out.add(path);
  return out;
};

const ROW = /^\|\s*`([\w.]+)`\s*\|(.*)\|\s*$/gm;

// A row inside an HTML comment is not documented.
export const visible = (doc: string): string => doc.replace(/<!--[\s\S]*?-->/g, '');

const section = (doc: string, name: string): string => {
  doc = visible(doc);
  const at = doc.search(new RegExp(`^### ${name}$`, 'm'));
  if (at < 0) throw new Error(`the doc has no section for ${name}`);
  const rest = doc.slice(doc.indexOf('\n', at) + 1);
  const next = rest.search(/^#{1,3} /m);
  return rest.slice(0, next < 0 ? undefined : next);
};

// The first backticked cell of each table row under `### Name`, as a full dotted path.
export const docFields = (doc: string, name: string): Set<string> =>
  new Set([...section(doc, name).matchAll(ROW)].map((m) => m[1] as string));

const docCell = (doc: string, name: string, field: string): string => {
  const row = [...section(doc, name).matchAll(ROW)].find((m) => m[1] === field);
  if (row === undefined) throw new Error(`${name} has no row for ${field}`);
  return row[2] as string;
};

const ticks = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
const literals = (text: string): string[] => [...text.matchAll(/'([\w-]+)'/g)].map((m) => m[1] as string);

// Every type that `start` reaches through its field types, found by following imports.
export const reachable = (sources: Sources, start: string, file: string): Map<string, string> => {
  const found = new Map<string, string>();
  const sourceOf = (path: string): string => strip(sources[path] ?? read(path));
  const locate = (name: string, from: string): string | null => {
    const code = sourceOf(from);
    if (declares(name).test(code)) return from;
    for (const m of code.matchAll(/import (?:type )?\{([^}]+)\} from '([^']+)'/g)) {
      const names = (m[1] as string).split(',').map((n) => n.trim().replace(/^type /, ''));
      if (!names.includes(name)) continue;
      const spec = m[2] as string;
      return spec.startsWith('.') ? normalize(join(dirname(from), spec)).replaceAll('\\', '/') : CORE;
    }
    return null;
  };
  const visit = (name: string, from: string): void => {
    const where = locate(name, from);
    if (where === null) {
      if (name.length > 1 && !BUILTIN.has(name))
        throw new Error(`cannot find ${name} from ${from}: ${[...found].map(([n, f]) => `${n}@${f}`).join(' ')}`);
      return;
    }
    if (found.get(name) === where) return;
    found.set(name, where);
    const body = declaration(sourceOf(where), name).replace(/^(?:export )?(?:interface|type) \w+/, '');
    for (const m of body.matchAll(/\b[A-Z][a-z]\w*\b/g)) if (!BUILTIN.has(m[0]) && m[0] !== name) visit(m[0], where);
  };
  visit(start, file);
  return found;
};

export const compare = (doc: string, sources: Sources, lifecycle: string): string[] => {
  const problems: string[] = [];
  for (const type of TYPES) {
    const code = codeFields(sources, type);
    const named = docFields(doc, type.name);
    for (const field of named) if (!code.has(field)) problems.push(`${type.name}.${field} is in the doc, not in code`);
    for (const field of code) if (!named.has(field)) problems.push(`${type.name}.${field} is in code, not in the doc`);
  }
  const tabled = new Set(TYPES.map((t) => t.name));
  for (const [name, file] of reachable(sources, 'Snapshot', 'server/snapshot.ts')) {
    if (tabled.has(name) || MERGED.has(name)) continue;
    const text = declaration(strip(sources[file] ?? read(file)), name);
    if (!text.includes('{') || /=\s*string\s*&/.test(text)) continue;
    if (file === CORE && lifecycle.includes(`\`${name}\``)) continue;
    problems.push(`${name} is reachable from Snapshot and has no table`);
  }
  return problems;
};

// Each variant of Box against the station table, and the variants against STATIONS.
export const stationProblems = (doc: string, core: string): string[] => {
  const problems: string[] = [];
  const code = strip(core);
  const variants = new Map<string, Set<string>>();
  for (const m of declaration(code, 'Box').matchAll(/\{([^{}]*)\}/g)) {
    const state = /state:\s*'(\w+)'/.exec(m[1] as string);
    if (state === null) continue;
    const extra = pathsOf(m[1] as string);
    extra.delete('state');
    variants.set(state[1] as string, extra);
  }
  const stations = literals(/STATIONS = \[([^\]]*)\]/.exec(code)?.[1] ?? '');
  if (!same(stations, variants.keys())) problems.push('STATIONS and the Box variants differ');
  const rows = new Map<string, Set<string>>();
  for (const m of section(doc, 'Box stations').matchAll(ROW))
    rows.set(m[1] as string, new Set(ticks((m[2] as string).replace(/\([^)]*\)/g, ''))));
  for (const [station, fields] of variants) {
    const row = rows.get(station);
    if (row === undefined) problems.push(`station ${station} has no row`);
    else if (!same(row, fields)) problems.push(`station ${station} lists the wrong fields`);
  }
  for (const station of rows.keys()) if (!variants.has(station)) problems.push(`station ${station} is not in code`);
  return problems;
};

// Enum values in code against the backticked values in the doc.
export const valueProblems = (doc: string, sources: Sources): string[] => {
  const problems: string[] = [];
  const status = literals(declaration(strip(sources['server/store/store.ts'] as string), 'OutboxStatus'));
  if (!same(ticks(docCell(doc, 'OutboxEntry', 'status')), status))
    problems.push('OutboxEntry.status values differ from OutboxStatus');
  const reason = /reason:\s*((?:'\w+'\s*\|?\s*)+)/.exec(declaration(strip(sources[CORE] as string), 'Box'));
  const cancelled = section(doc, 'Box stations').match(/^\|\s*`cancelled`.*$/m)?.[0] ?? '';
  const inParens = ticks(/\(([^)]*)\)/.exec(cancelled)?.[1] ?? '');
  if (!same(inParens, literals(reason?.[1] ?? ''))) problems.push('the cancelled reasons differ from Box');
  return problems;
};

const flatten = (value: Json, docPaths: ReadonlySet<string>, prefix = ''): string[] =>
  Object.entries(value).flatMap(([key, child]) => {
    const path = `${prefix}${key}`;
    const nested = [...docPaths].some((p) => p.startsWith(`${path}.`));
    return nested && child !== null && typeof child === 'object'
      ? [path, ...flatten(child as Json, docPaths, `${path}.`)]
      : [path];
  });

// What HQ serializes, against the tables. Item keys are compared as sets, so a key the serializer adds shows up.
export const shapeProblems = (doc: string, snap: Json): string[] => {
  const problems: string[] = [];
  const check = (label: string, got: Iterable<string>, want: Iterable<string>): void => {
    if (!same(got, want)) problems.push(`${label} keys differ: ${sorted(got)} against ${sorted(want)}`);
  };
  const state = snap.state as { config: Json; boxes: Record<string, Json> };
  const registry = snap.registry as { factories: Json[]; repos: Json[] };
  check('Snapshot', flatten(snap, docFields(doc, 'Snapshot')), docFields(doc, 'Snapshot'));
  check('State', Object.keys(state), docFields(doc, 'State'));
  check('Config', Object.keys(state.config), docFields(doc, 'Config'));
  check('RegistryView', Object.keys(registry), docFields(doc, 'RegistryView'));
  for (const item of registry.factories) check('Factory', Object.keys(item), docFields(doc, 'Factory'));
  for (const item of registry.repos) check('RepoEntry', Object.keys(item), docFields(doc, 'RepoEntry'));
  for (const item of snap.denials as Json[]) check('Denial', Object.keys(item), docFields(doc, 'Denial'));
  for (const item of snap.blocked as Json[]) check('BlockedEntry', Object.keys(item), docFields(doc, 'BlockedEntry'));
  const boxDoc = docFields(doc, 'Box');
  for (const box of Object.values(state.boxes)) {
    for (const key of Object.keys(box)) if (!boxDoc.has(key)) problems.push(`Box.${key} is serialized, not in the doc`);
    for (const key of ['id', 'shipment', 'seq', 'worker', 'builders', 'cancelled', 'state'])
      if (!(key in box)) problems.push(`Box.${key} is in the doc, not serialized`);
  }
  return problems;
};

// Change code or doc text. It throws when nothing matched, so a mutant never passes by missing its target.
const mutate = (text: string, pattern: RegExp, to: string): string => {
  if (!pattern.test(text)) throw new Error(`mutant target ${pattern} is not in the text`);
  return text.replace(pattern, to);
};
const rowPattern = (field: string): string => `^(\\|\\s*)\`${field.replace('.', '\\.')}\`(\\s*\\|[^\\n]*\\n)`;
const renameRow = (doc: string, from: string, to: string): string =>
  mutate(doc, new RegExp(rowPattern(from), 'm'), `$1\`${to}\`$2`);
const dropRow = (doc: string, under: string, field: string): string => {
  const at = doc.search(new RegExp(`^### ${under}$`, 'm'));
  const head = doc.slice(0, at);
  return head + mutate(doc.slice(at), new RegExp(rowPattern(field), 'm'), '');
};

const sourcesOf = (): Record<string, string> =>
  Object.fromEntries([...new Set(TYPES.map((t) => t.file))].map((file) => [file, read(file)]));

describe('docs/architecture.md snapshot schema', () => {
  const doc = read('docs/architecture.md');
  const lifecycle = read(LIFECYCLE_DOC);
  const sources = sourcesOf();
  const SNAPSHOT = 'server/snapshot.ts';
  const snapshotWith = (pattern: RegExp, to: string): Record<string, string> => ({
    ...sources,
    [SNAPSHOT]: mutate(sources[SNAPSHOT] as string, pattern, to),
  });

  it('names every snapshot field that exists, and every field in code', () => {
    expect(compare(doc, sources, lifecycle)).toEqual([]);
  });

  it('lists the box stations, their fields and the enum values', () => {
    expect(stationProblems(doc, sources[CORE] as string)).toEqual([]);
    expect(valueProblems(doc, sources)).toEqual([]);
  });

  it('lists the ActionItem kinds that exist', () => {
    const kinds = [
      ...declaration(strip(sources['server/modes/cages.ts'] as string), 'ActionItem').matchAll(/kind: '(\w+)'/g),
    ].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) expect(doc).toContain(`\`${kind}\``);
  });

  it('fails when the doc names a field the code does not have', () => {
    const problems = compare(renameRow(doc, 'paused', 'pausedWorkers'), sources, lifecycle);
    expect(problems).toContain('Snapshot.pausedWorkers is in the doc, not in code');
    expect(problems).toContain('Snapshot.paused is in code, not in the doc');
  });

  it('fails when the code gains a field, with or without readonly', () => {
    for (const line of ['readonly extra: number;', 'extra: number;'])
      expect(compare(doc, snapshotWith(/readonly paused\s*:/, `${line}\n  readonly paused:`), lifecycle)).toContain(
        'Snapshot.extra is in code, not in the doc',
      );
  });

  it('ignores a field that only a comment names', () => {
    for (const comment of ['// readonly ghost: number;', '/* readonly ghost: number; */'])
      expect(compare(doc, snapshotWith(/readonly paused\s*:/, `${comment}\n  readonly paused:`), lifecycle)).toEqual(
        [],
      );
  });

  it('checks a dotted path against its parent', () => {
    expect(compare(renameRow(doc, 'hq.pid', 'outbox.pid'), sources, lifecycle)).toContain(
      'Snapshot.outbox.pid is in the doc, not in code',
    );
    expect(compare(renameRow(doc, 'hq.pid', 'pid'), sources, lifecycle)).toContain(
      'Snapshot.hq.pid is in code, not in the doc',
    );
    const added = snapshotWith(/readonly pid: number;/, 'readonly pid: number; readonly host: string;');
    expect(compare(doc, added, lifecycle)).toContain('Snapshot.hq.host is in code, not in the doc');
  });

  it('does not count a row inside an HTML comment as documented', () => {
    const hidden = mutate(doc, /^(\|\s*`paused`[^\n]*)$/m, '<!-- $1 -->');
    expect(compare(hidden, sources, lifecycle)).toContain('Snapshot.paused is in code, not in the doc');
    const multiline = mutate(doc, /^(\|\s*`hq\.pid`[^\n]*)$/m, '<!--\n$1\n-->');
    expect(compare(multiline, sources, lifecycle)).toContain('Snapshot.hq.pid is in code, not in the doc');
  });

  it('fails when a section is missing', () => {
    expect(() => compare(mutate(doc, /^### CageView$/m, '### Cages'), sources, lifecycle)).toThrow(
      'no section for CageView',
    );
  });

  it('fails when a type reachable from Snapshot has no table', () => {
    const added = snapshotWith(/readonly paused\s*:/, 'readonly extra: Extra;\n  readonly paused:');
    added[SNAPSHOT] += '\nexport interface Extra { readonly a: number }\n';
    expect(compare(doc, added, lifecycle)).toContain('Extra is reachable from Snapshot and has no table');
  });

  it('fails when a station row or an enum value drifts', () => {
    expect(stationProblems(renameRow(doc, 'qc', 'review'), sources[CORE] as string)).toContain('station qc has no row');
    const core = mutate(sources[CORE] as string, /'shipped',/, "'shipped', 'lost',");
    expect(stationProblems(doc, core)).toContain('STATIONS and the Box variants differ');
    const store = mutate(sources['server/store/store.ts'] as string, /'skipped'/, "'skipped' | 'stuck'");
    expect(valueProblems(doc, { ...sources, 'server/store/store.ts': store })).toContain(
      'OutboxEntry.status values differ from OutboxStatus',
    );
  });
});

// CageView is the one snapshot type this file cannot serialize. Only `SandboxDriver.startCage` makes one, and it
// needs a container engine. The CageView table is checked against the TypeScript declaration only, and the
// contract tests in test/contract run the real driver where docker or podman exists.
describe.skipIf(!hasSqlite)('docs/architecture.md against the serialized snapshot', () => {
  const doc = read('docs/architecture.md');
  const running: RunningHq[] = [];
  afterEach(async () => {
    await Promise.all(running.splice(0).map((hq) => hq.close()));
  });

  const serialized = async (): Promise<Json> => {
    const sink: { push: (d: { host: string; port: number; agent: string; reason: string; at: string }) => void } = {
      push: () => {},
    };
    const hq = await startHq({
      home: tempDir('arch-doc'),
      port: 0,
      makeDriver: async (_hq, onDenial) => {
        sink.push = onDenial;
        return null;
      },
    });
    running.push(hq);
    const post = (path: string, body: unknown) =>
      fetch(`${hq.url}${path}`, { method: 'POST', body: JSON.stringify(body) });
    await post('/api/cages', {});
    sink.push({ host: 'example.com', port: 443, agent: 'nova', reason: 'sni-mismatch', at: 'now' });
    const root = tempDir('arch-factory');
    const made = (await (await post('/api/factories', { root })).json()) as { factory: { id: string } };
    await post('/api/repos', { factory: made.factory.id, path: root });
    for (const event of [human.addWorker('nova'), human.order('acme/t1'), human.hire('acme/t1', 'nova')])
      expect((await post('/api/events', event)).status).toBe(200);
    return (await (await fetch(`${hq.url}/api/snapshot`)).json()) as Json;
  };

  it('serializes the keys the tables list', async () => {
    const snap = await serialized();
    expect((snap.denials as Json[]).length).toBeGreaterThan(0);
    expect((snap.blocked as Json[]).length).toBeGreaterThan(0);
    expect((snap.registry as { repos: Json[] }).repos.length).toBeGreaterThan(0);
    expect(Object.keys((snap.state as { boxes: Json }).boxes).length).toBeGreaterThan(0);
    expect(shapeProblems(doc, snap)).toEqual([]);
  });

  it('fails when the serializer emits a key the doc lacks', async () => {
    const snap = await serialized();
    expect(shapeProblems(dropRow(doc, 'Denial', 'at'), snap).join('\n')).toContain('Denial keys differ');
    expect(shapeProblems(dropRow(doc, 'BlockedEntry', 'seq'), snap).join('\n')).toContain('BlockedEntry keys differ');
    expect(shapeProblems(dropRow(doc, 'Box', 'builders'), snap)).toContain(
      'Box.builders is serialized, not in the doc',
    );
  });
});

// A real cages mode with a fake git host, a fake proxy and a scripted runtime that reports usage. No docker.
describe.skipIf(!hasSqlite)('docs/architecture.md against the cages mode and the outbox', () => {
  const doc = read('docs/architecture.md');
  const running: RunningHq[] = [];
  afterEach(async () => {
    await Promise.all(running.splice(0).map((hq) => hq.close()));
  });

  const USAGE = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, webRequests: 5 };
  const until = async (hq: RunningHq, test: () => boolean): Promise<void> => {
    const deadline = Date.now() + 8000;
    while (!test()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(hq.snapshot().actions)}`);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  };

  it('serializes the ActionItem, ModeView and Usage keys the tables list', { timeout: 15_000 }, async () => {
    const reached = new Set<string>();
    let deny: (d: { host: string; port: number; agent: string; reason: string; at: string }) => void = () => {};
    const base = scripted({
      scripts: SCRIPTS,
      egress: {
        reach: async (agent: string, host: string) => {
          if (reached.has(host)) return true;
          deny({ host, port: 443, agent, reason: 'not-allowlisted', at: new Date().toISOString() });
          return false;
        },
      },
      retryMs: 10,
    });
    const runtime: AgentRuntime = {
      id: base.id,
      run: async (job) => ({ ...(await base.run(job)), usage: USAGE }) as Awaited<ReturnType<AgentRuntime['run']>>,
    };
    const fake = new FakeGithub();
    const send = (login: string) =>
      github({ repo: 'acme/app', base: 'main', send: fake.transport(login), log: () => {} });
    const hq = await startHq({
      home: tempDir('arch-mode'),
      port: 0,
      makeDriver: async (_hq, onDenial) => {
        deny = onDenial;
        return null;
      },
      mode: cagesMode({
        host: send('aw-nova'),
        reviewHost: send('vega'),
        repo: 'acme/app',
        base: 'main',
        tickets: TICKETS,
        author: 'nova',
        reviewer: 'vega',
        workers: { nova: runtime, vega: runtime },
        egress: {
          allow: async (site) => {
            reached.add(site.replace(/:443$/, ''));
          },
        },
        pollMs: 30,
        reviewRetryMs: 5,
      }),
    });
    running.push(hq);
    await fetch(`${hq.url}/api/cages`, { method: 'POST', body: JSON.stringify({}) });
    for (const id of ['alpha/t2', 'alpha/web'])
      expect((await fetch(`${hq.url}/api/tickets`, { method: 'POST', body: JSON.stringify({ id }) })).status).toBe(200);
    const kinds = () => new Set(hq.snapshot().actions.map((a) => a.kind));
    await until(hq, () => kinds().has('ready_to_merge') && kinds().has('website'));
    const snap = hq.snapshot() as unknown as { actions: Json[]; mode: Json };

    const itemKeys = docFields(doc, 'ActionItem');
    for (const item of snap.actions) {
      const { kind, ...rest } = item;
      for (const key of Object.keys(rest)) {
        expect(itemKeys.has(key), `${String(kind)}.${key} is serialized, not in the doc`).toBe(true);
        expect(docCell(doc, 'ActionItem', key), `${key} is not documented for ${String(kind)}`).toContain(
          `\`${String(kind)}\``,
        );
      }
      const documented = [...itemKeys].filter((key) => docCell(doc, 'ActionItem', key).includes(`\`${String(kind)}\``));
      if (kind === 'website') expect(sorted(Object.keys(rest))).toEqual(sorted(documented));
    }

    expect(shapeProblems(doc, { ...snap, denials: [], blocked: [] } as unknown as Json)).toEqual([]);
    expect(sorted(Object.keys(snap.mode))).toEqual(sorted(docFields(doc, 'ModeView')));
    const entries = Object.values(snap.mode.usage as Record<string, Json[]>).flat();
    expect(entries.length).toBeGreaterThan(0);
    for (const used of entries) expect(sorted(Object.keys(used))).toEqual(sorted(docFields(doc, 'Usage')));
  });

  it('serializes the OutboxEntry keys the table lists', async () => {
    const hq = await startHq({
      home: tempDir('arch-outbox'),
      port: 0,
      executors: {
        alert_human: async () => {
          throw new Error('no one to tell');
        },
      },
    });
    running.push(hq);
    const post = (event: unknown) => fetch(`${hq.url}/api/events`, { method: 'POST', body: JSON.stringify(event) });
    await post(human.order('acme/t1', { id: 's1', size: 1 }));
    // A second order into a full shipment is refused with an alert, and the executor fails every time.
    for (let i = 0; i < 6 && hq.snapshot().outbox.failed.length === 0; i++) {
      await post(human.order(`acme/over${i}`, { id: 's1', size: 1 }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const failed = hq.snapshot().outbox.failed as unknown as Json[];
    expect(failed.length).toBeGreaterThan(0);
    for (const entry of failed) expect(sorted(Object.keys(entry))).toEqual(sorted(docFields(doc, 'OutboxEntry')));
  });
});
