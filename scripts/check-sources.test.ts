import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = join(import.meta.dirname, 'check-sources.mjs');
const repoRoot = join(import.meta.dirname, '..');

function runChecker(...files: string[]) {
  const result = spawnSync(process.execPath, [script, ...files], { cwd: repoRoot, encoding: 'utf8' });
  return { status: result.status, output: result.stdout + result.stderr };
}

function writeTemp(name: string, text: string) {
  const file = join(mkdtempSync(join(tmpdir(), 'check-sources-')), name);
  writeFileSync(file, text);
  return file;
}

const header = [
  '| Id | Area | Fact | Link | Version checked | Date checked | Used by |',
  '| --- | --- | --- | --- | --- | --- | --- |',
];
const row = (id: string, link: string, version: string, usedBy: string) =>
  `| ${id} | Docker | A fact. | ${link} | ${version} | 2026-11-16 | ${usedBy} |`;
const goodLink = '[docs](https://docs.docker.com/reference/cli/docker/network/create/)';
const goodRows = [
  row('S-1', goodLink, 'Docker 29.1', 'P0-2'),
  row('S-2', goodLink, 'Docker 29.1', 'P0-3, P0-4'),
  row('S-3', goodLink, 'Docker 29.1', 'P0-5'),
];

describe('check-sources', () => {
  it('passes the committed docs', () => {
    const { status, output } = runChecker();
    expect(output).toContain('ok');
    expect(status).toBe(0);
  });

  it('passes a complete sources table', () => {
    const { status } = runChecker(writeTemp('sources.md', [...header, ...goodRows].join('\n')));
    expect(status).toBe(0);
  });

  it('fails and names the row when a link is missing', () => {
    const rows = [...goodRows, row('S-4', 'see the docs', 'Docker 29.1', 'P0-2')];
    const { status, output } = runChecker(writeTemp('sources.md', [...header, ...rows].join('\n')));
    expect(status).toBe(1);
    expect(output).toMatch(/:6 row S-4: no link/);
  });

  it('fails and names the row when the checked version is missing', () => {
    const rows = [...goodRows, row('S-5', goodLink, ' ', 'P0-2')];
    const { status, output } = runChecker(writeTemp('sources.md', [...header, ...rows].join('\r\n')));
    expect(status).toBe(1);
    expect(output).toContain('row S-5: no checked version');
  });

  it('fails when a spike has no source row', () => {
    const { status, output } = runChecker(writeTemp('sources.md', [...header, ...goodRows.slice(0, 2)].join('\n')));
    expect(status).toBe(1);
    expect(output).toContain('no source row is used by P0-5');
  });

  it('fails when the committed sources lose one link', () => {
    const real = readFileSync(join(repoRoot, 'docs/sources.md'), 'utf8');
    const broken = real.replace(/\[[^\]]*\]\(https:\/\/[^)]+\)/, 'removed');
    const { status, output } = runChecker(writeTemp('sources.md', broken));
    expect(status).toBe(1);
    expect(output).toMatch(/row S-\d+: no link/);
  });

  it('fails a file with no recognised table', () => {
    const { status, output } = runChecker(writeTemp('empty.md', '# Nothing here\n'));
    expect(status).toBe(1);
    expect(output).toContain('no source or prior-art table found');
  });

  it('fails a prior-art row without a plan PR id', () => {
    const text = [
      '| Id | Project | Failure mode | Issue | Handled by |',
      '| --- | --- | --- | --- | --- |',
      '| F-1 | a | Stuck agent. | [#1](https://github.com/o/a/issues/1) | P0-7 |',
      '| F-2 | b | Rate limit. | [#2](https://github.com/o/b/issues/2) | later |',
      '| F-3 | c | Lost state. | [#3](https://github.com/o/c/issues/3) | P1-1 |',
    ].join('\n');
    const { status, output } = runChecker(writeTemp('prior-art.md', text));
    expect(status).toBe(1);
    expect(output).toContain('row F-2: no plan PR id');
  });
});
