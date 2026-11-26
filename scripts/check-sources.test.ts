import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const script = join(import.meta.dirname, 'check-sources.mjs');
const repoRoot = join(import.meta.dirname, '..');

const tempDir = mkdtempSync(join(tmpdir(), 'check-sources-'));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

function runChecker(...files: string[]) {
  const result = spawnSync(process.execPath, [script, ...files], { cwd: tempDir, encoding: 'utf8' });
  return { status: result.status, output: result.stdout + result.stderr };
}

function writeTemp(name: string, text: string) {
  const file = join(tempDir, name);
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

const priorArt = [
  '| Id | Project | Failure mode | Issue | Handled by | How this design handles it |',
  '| --- | --- | --- | --- | --- | --- |',
  '| F-1 | a | Stuck agent. | [#1](https://github.com/o/a/issues/1) | P0-7 | Events. |',
  '| F-2 | b | Rate limit. | [#2](https://github.com/o/b/issues/2) | P0-7 | Backoff. |',
  '| F-3 | c | Lost state. | [#3](https://github.com/o/c/issues/3) | P1-1 | Storage. |',
];

describe('check-sources', () => {
  it('passes the committed docs when run from outside the repo', () => {
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

  it('fails a sources file with no source table', () => {
    const { status, output } = runChecker(writeTemp('sources.md', '# Nothing here\n'));
    expect(status).toBe(1);
    expect(output).toContain('sources.md:1: no source table');
  });

  it('fails a sources file that holds only a prior-art table', () => {
    const { status, output } = runChecker(writeTemp('sources.md', priorArt.join('\n')));
    expect(status).toBe(1);
    expect(output).toContain('sources.md:1: no source table');
  });

  it('fails a table whose header is not a known header', () => {
    const renamed = header[0]?.replace('| Link |', '| URL |') ?? '';
    const rows = [...goodRows, row('S-4', 'see the docs', '', 'P0-2')];
    const { status, output } = runChecker(writeTemp('sources.md', [renamed, header[1], ...rows].join('\n')));
    expect(status).toBe(1);
    expect(output).toContain('sources.md:1: unknown table header');
  });

  it('fails a row-shaped line after a blank line ends the table', () => {
    const text = [...header, ...goodRows, '', '| S-90 | x | x | | | | |'].join('\n');
    const { status, output } = runChecker(writeTemp('sources.md', text));
    expect(status).toBe(1);
    expect(output).toContain('sources.md:7: table row outside a table');
  });

  it('matches whole plan PR ids that exist in the plan', () => {
    const rows = [row('S-1', goodLink, 'Docker 29.1', 'P0-20, P0-3, P0-4, P0-5')];
    const { status, output } = runChecker(writeTemp('sources.md', [...header, ...rows].join('\n')));
    expect(status).toBe(1);
    expect(output).toContain('row S-1: P0-20 is not a plan PR id');
    expect(output).toContain('no source row is used by P0-2');
  });

  it('fails duplicate ids, wrong column counts, impossible dates and unknown versions', () => {
    const rows = [
      ...goodRows,
      row('S-1', goodLink, 'Docker 29.1', 'P0-2'),
      '| S-6 | Docker | A | fact. | [docs](https://a.example) | Docker 29.1 | 2026-11-16 | P0-2 |',
      row('S-7', goodLink, 'Docker 29.1', 'P0-2').replace('2026-11-16', '2026-02-30'),
      row('S-8', goodLink, 'unknown', 'P0-2'),
      row('S-9', goodLink, 'Docker 29.1', 'P0-2').replace('2026-11-16', '9999-99-99'),
    ];
    const { status, output } = runChecker(writeTemp('sources.md', [...header, ...rows].join('\n')));
    expect(status).toBe(1);
    expect(output).toContain(':6 row S-1: duplicate id');
    expect(output).toContain(':7 row S-6: has 8 cells, header has 7');
    expect(output).toContain(':8 row S-7: no check date (YYYY-MM-DD)');
    expect(output).toContain(':9 row S-8: no checked version');
    expect(output).toContain(':10 row S-9: no check date (YYYY-MM-DD)');
  });

  it('fails a sources row where every cell is a link', () => {
    const allLinks = `| ${Array(7).fill('[x](https://a.example)').join(' | ')} |`;
    const { status, output } = runChecker(writeTemp('sources.md', [...header, ...goodRows, allLinks].join('\n')));
    expect(status).toBe(1);
    expect(output).toContain(':6 row [x](https://a.example): every cell is a link');
  });

  it('does not report all-link for a row that has text cells', () => {
    const { output } = runChecker(writeTemp('sources.md', [...header, ...goodRows].join('\n')));
    expect(output).not.toContain('every cell is a link');
  });

  it('fails a prior-art row where every cell is a link', () => {
    const allLinks = `| ${Array(6).fill('[x](https://a.example)').join(' | ')} |`;
    const { status, output } = runChecker(writeTemp('prior-art.md', [...priorArt, allLinks].join('\n')));
    expect(status).toBe(1);
    expect(output).toContain(':6 row [x](https://a.example): every cell is a link');
  });

  it('fails a prior-art row without a plan PR id', () => {
    const text = [...priorArt.slice(0, 3), priorArt[3]?.replace('P0-7', 'later'), priorArt[4]].join('\n');
    const { status, output } = runChecker(writeTemp('prior-art.md', text));
    expect(status).toBe(1);
    expect(output).toContain('row F-2: later is not a plan PR id');
  });
});
