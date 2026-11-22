import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type CanarySet, percentEncoded } from './canary.ts';

export interface Finding {
  readonly where: string;
  readonly kinds: readonly string[];
}

export interface Artifact {
  readonly where: string;
  readonly text: string;
}

export type Gh = (args: readonly string[]) => string;

export const scanArtifacts = (canaries: CanarySet, artifacts: readonly Artifact[]): Finding[] =>
  artifacts.flatMap((a) => {
    const kinds = canaries.find(a.text);
    return kinds.length === 0 ? [] : [{ where: a.where, kinds }];
  });

const encodedPrefixes = (prefix: string): string[] => {
  const bytes = Buffer.from(prefix);
  const base64 = [0, 1, 2].map((pad) => {
    const encoded = Buffer.concat([Buffer.alloc(pad), bytes]).toString('base64');
    return encoded.slice(Math.ceil((8 * pad) / 6), Math.floor((8 * (pad + bytes.length)) / 6));
  });
  return [
    bytes.toString('hex'),
    bytes.toString('hex').toUpperCase(),
    ...percentEncoded(prefix),
    ...base64,
    ...base64.map((b) => b.replace(/\+/g, '-').replace(/\//g, '_')),
  ];
};

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

const ENCODED_CANARY = new RegExp(['AWCANARY-', 'CANARY_'].flatMap(encodedPrefixes).map(escapeRegex).join('|'));

const SHAPES: readonly (readonly [string, RegExp])[] = [
  ['canary-of-any-run', /AWCANARY-[0-9a-f]+-[a-z-]+-[0-9a-f]{18}/],
  ['fixture-canary', /\bCANARY_[A-Z]+_[0-9a-f]{8}\b/],
  ['encoded-canary-prefix', ENCODED_CANARY],
  ['fake-key-block', /-----BEGIN FAKE KEY-----/],
  ['private-key-block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/],
  ['anthropic-key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['aws-key-id', /\bAKIA[0-9A-Z]{16}\b/],
  ['bearer-credential', /authorization:\s*bearer\s+[A-Za-z0-9._-]{20,}/i],
];

export const scanShapes = (artifacts: readonly Artifact[]): Finding[] =>
  artifacts.flatMap((a) => {
    const kinds = SHAPES.filter(([, shape]) => shape.test(a.text)).map(([kind]) => kind);
    return kinds.length === 0 ? [] : [{ where: a.where, kinds }];
  });

export const readDir = (dir: string): Artifact[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return readDir(path);
    if (!entry.isFile() || statSync(path).size > 8 * 1024 * 1024) return [];
    return [{ where: path, text: readFileSync(path, 'utf8') }];
  });

export const realGh: Gh = (args) => execFileSync('gh', [...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const pages = (gh: Gh, path: string): Record<string, unknown>[] => {
  const raw = gh(['api', '--paginate', '--slurp', path]);
  const parsed = JSON.parse(raw) as unknown;
  return (Array.isArray(parsed) ? parsed.flat() : []) as Record<string, unknown>[];
};

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

export const hostArtifacts = (gh: Gh, repo: string): Artifact[] => {
  const out: Artifact[] = [];
  for (const pr of pages(gh, `repos/${repo}/pulls?state=all&per_page=100`)) {
    const head = (pr.head ?? {}) as Record<string, unknown>;
    out.push({ where: `pr#${String(pr.number)} title`, text: text(pr.title) });
    out.push({ where: `pr#${String(pr.number)} body`, text: text(pr.body) });
    out.push({ where: `pr#${String(pr.number)} branch`, text: text(head.ref) });
    for (const r of pages(gh, `repos/${repo}/pulls/${String(pr.number)}/reviews?per_page=100`))
      out.push({ where: `pr#${String(pr.number)} review ${String(r.id)}`, text: text(r.body) });
  }
  for (const c of pages(gh, `repos/${repo}/issues/comments?per_page=100`))
    out.push({ where: `comment ${String(c.id)}`, text: text(c.body) });
  for (const c of pages(gh, `repos/${repo}/pulls/comments?per_page=100`))
    out.push({ where: `review comment ${String(c.id)}`, text: text(c.body) });
  for (const b of pages(gh, `repos/${repo}/branches?per_page=100`))
    out.push({ where: `branch ${text(b.name)}`, text: text(b.name) });
  return out;
};
