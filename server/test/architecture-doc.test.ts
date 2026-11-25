import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

// Every type the Snapshot reaches, with the source file that declares it.
// `extra` names a second declaration whose fields belong to the same table.
export const TYPES: ReadonlyArray<{ name: string; file: string; extra?: string }> = [
  { name: 'Snapshot', file: 'server/snapshot.ts' },
  { name: 'State', file: 'packages/core/src/lifecycle.ts' },
  { name: 'RegistryView', file: 'server/registry.ts' },
  { name: 'Factory', file: 'server/registry.ts' },
  { name: 'RepoEntry', file: 'server/registry.ts' },
  { name: 'CageView', file: 'server/sandbox/container.ts' },
  { name: 'Denial', file: 'server/snapshot.ts' },
  { name: 'BlockedEntry', file: 'server/blocked.ts', extra: 'Attempt' },
  { name: 'OutboxEntry', file: 'server/store/store.ts' },
  { name: 'ModeView', file: 'server/modes/cages.ts' },
  { name: 'Usage', file: 'server/agents/runtime.ts' },
  { name: 'ActionItem', file: 'server/modes/cages.ts' },
];

// The text of `export interface Name ...` or `export type Name = ...`, cut by brace depth.
export const declaration = (source: string, name: string): string => {
  const start = new RegExp(`export (?:interface|type) ${name}\\b`).exec(source);
  if (start === null) throw new Error(`no declaration of ${name}`);
  let depth = 0;
  let opened = false;
  for (let i = start.index; i < source.length; i += 1) {
    const c = source[i];
    if (c === '{') {
      depth += 1;
      opened = true;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0 && source.startsWith('export interface', start.index)) return source.slice(start.index, i + 1);
    } else if (c === ';' && depth === 0 && opened && source.startsWith('export type', start.index)) {
      return source.slice(start.index, i);
    }
  }
  throw new Error(`${name} is not closed`);
};

export const codeFields = (source: string, name: string): Set<string> =>
  new Set(
    [...declaration(source, name).matchAll(/readonly (\w+)\??:/g)]
      .map((m) => m[1] as string)
      .filter((f) => f !== 'kind'),
  );

// The first backticked cell of each table row under `### Name`. A dotted name counts as its last part.
export const docFields = (doc: string, name: string): Set<string> => {
  const at = doc.search(new RegExp(`^### ${name}$`, 'm'));
  if (at < 0) throw new Error(`the doc has no section for ${name}`);
  const rest = doc.slice(doc.indexOf('\n', at) + 1);
  const next = rest.search(/^#{1,3} /m);
  const body = rest.slice(0, next < 0 ? undefined : next);
  return new Set([...body.matchAll(/^\| `([\w.]+)` \|/gm)].map((m) => (m[1] as string).split('.').pop() as string));
};

export const compare = (doc: string, sources: Readonly<Record<string, string>>) => {
  const problems: string[] = [];
  for (const type of TYPES) {
    const source = sources[type.file] as string;
    const code = codeFields(source, type.name);
    for (const field of type.extra === undefined ? [] : codeFields(source, type.extra)) code.add(field);
    const named = docFields(doc, type.name);
    for (const field of named) if (!code.has(field)) problems.push(`${type.name}.${field} is in the doc, not in code`);
    for (const field of code) if (!named.has(field)) problems.push(`${type.name}.${field} is in code, not in the doc`);
  }
  return problems;
};

const sourcesOf = (): Record<string, string> =>
  Object.fromEntries([...new Set(TYPES.map((t) => t.file))].map((file) => [file, read(file)]));

describe('docs/architecture.md snapshot schema', () => {
  const doc = read('docs/architecture.md');
  const sources = sourcesOf();

  it('names every snapshot field that exists, and every field in code', () => {
    expect(compare(doc, sources)).toEqual([]);
  });

  it('lists the ActionItem kinds that exist', () => {
    const kinds = [
      ...declaration(sources['server/modes/cages.ts'] as string, 'ActionItem').matchAll(/kind: '(\w+)'/g),
    ].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) expect(doc).toContain(`\`${kind}\``);
  });

  it('fails when the doc names a field the code does not have', () => {
    const mutated = doc.replace('| `paused` |', '| `pausedWorkers` |');
    const problems = compare(mutated, sources);
    expect(problems).toContain('Snapshot.pausedWorkers is in the doc, not in code');
    expect(problems).toContain('Snapshot.paused is in code, not in the doc');
  });

  it('fails when the code gains a field the doc lacks', () => {
    const file = 'server/snapshot.ts';
    const mutated = {
      ...sources,
      [file]: (sources[file] as string).replace('readonly paused:', 'readonly extra: number;\n  readonly paused:'),
    };
    expect(compare(doc, mutated)).toContain('Snapshot.extra is in code, not in the doc');
  });

  it('fails when a nested field is added or dropped', () => {
    const file = 'server/snapshot.ts';
    const added = {
      ...sources,
      [file]: (sources[file] as string).replace(
        'readonly pid: number;',
        'readonly pid: number; readonly host: string;',
      ),
    };
    expect(compare(doc, added)).toContain('Snapshot.host is in code, not in the doc');
    expect(compare(doc.replace('| `hq.pid` |', '| `hq.gone` |'), sources)).toContain(
      'Snapshot.gone is in the doc, not in code',
    );
  });

  it('fails when a section is missing', () => {
    expect(() => compare(doc.replace('### CageView', '### Cages'), sources)).toThrow('no section for CageView');
  });
});
