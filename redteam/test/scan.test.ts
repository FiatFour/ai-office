import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CanarySet } from '../canary.ts';
import { type Gh, hostArtifacts, readDir, scanArtifacts } from '../scan.ts';

const gh =
  (canary: string): Gh =>
  (args) => {
    const path = String(args.at(-1));
    if (path.includes('/pulls?'))
      return JSON.stringify([[{ number: 1, title: 't', body: `see ${canary}`, head: { ref: 'aw/a' } }]]);
    if (path.includes('/issues/comments')) return JSON.stringify([[{ id: 5, body: 'fine' }]]);
    if (path.includes('/pulls/comments')) return JSON.stringify([[{ id: 6, body: 'also fine' }]]);
    return JSON.stringify([[{ name: 'main' }, { name: `aw/${canary}` }]]);
  };

describe('scanArtifacts', () => {
  it('reports where a canary value sits', () => {
    const set = new CanarySet('s1');
    const value = set.issue('env-token');
    const found = scanArtifacts(set, [
      { where: 'a', text: 'clean' },
      { where: 'b', text: `x ${Buffer.from(value).toString('base64')} y` },
    ]);
    expect(found).toEqual([{ where: 'b', kinds: ['env-token'] }]);
  });

  it('reads a directory tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-scan-'));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'a.txt'), 'hello');
    expect(readDir(dir).map((a) => a.text)).toEqual(['hello']);
  });
});

describe('hostArtifacts', () => {
  it('lists PR titles, bodies, branches, comments, review comments and branch names, and the scan finds a leak in a body and a branch', () => {
    const set = new CanarySet('s2');
    const value = set.issue('env-token');
    const artifacts = hostArtifacts(gh(value), 'o/r');
    expect(artifacts.map((a) => a.where)).toEqual([
      'pr#1 title',
      'pr#1 body',
      'pr#1 branch',
      'comment 5',
      'review comment 6',
      'branch main',
      `branch aw/${value}`,
    ]);
    expect(scanArtifacts(set, artifacts).map((f) => f.where)).toEqual(['pr#1 body', `branch aw/${value}`]);
  });

  it('finds nothing when the host is clean', () => {
    const set = new CanarySet('s3');
    set.issue('env-token');
    expect(scanArtifacts(set, hostArtifacts(gh('nothing-here'), 'o/r'))).toEqual([]);
  });
});
