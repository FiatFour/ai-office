import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const script = join(import.meta.dirname, 'check-throughput.mjs');
const tempDir = mkdtempSync(join(tmpdir(), 'check-throughput-'));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

const small = (events: number, rate = 230_000) =>
  [1, 2, 3].map(
    (n) => `throughput small run ${n}: ${events} events, 5000 sequences, 900 commands, 4.30 s, ${rate} events/s`,
  );
const large = (events: number, rates: number[]) => [
  `throughput large state: ${events} events, 3000 tasks ordered and merged`,
  ...rates.map((rate, i) => `chunk ${i + 1} of ${rates.length}: 600 boxes, 600 changes, ${rate} events/s`),
  `median 1138 events/s over ${rates.length} chunks, end state 3000 boxes of which 3000 shipped`,
];
const report = (lines: string[], tail = [' Tests  2 passed (2)']) => [...lines, ...tail].join('\n');

function check(text: string) {
  const file = join(tempDir, `out-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(file, text);
  const result = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  return { status: result.status, output: result.stdout + result.stderr };
}

describe('the throughput checker', () => {
  it('passes a full run', () => {
    const result = check(report([...small(1_000_000), ...large(24_000, [7021, 1503, 772, 476])]));
    expect(result.status).toBe(0);
  });

  it('fails a small-state run of ten events', () => {
    const result = check(report([...small(10), ...large(24_000, [7021, 1503, 772, 476])]));
    expect(result.status).toBe(1);
    expect(result.output).toContain('fewer than 200000 events');
  });

  it('fails a large-state run with ten tasks (80 events, no chunk)', () => {
    const result = check(report([...small(1_000_000), ...large(80, [])]));
    expect(result.status).toBe(1);
    expect(result.output).toContain('fewer than 20000');
    expect(result.output).toContain('chunk rates');
  });

  it('fails a large-state run with fewer than four chunk rates', () => {
    const result = check(report([...small(1_000_000), ...large(24_000, [7021, 1503, 772])]));
    expect(result.status).toBe(1);
    expect(result.output).toContain('fewer than 4');
  });

  it('fails a small-state rate under the floor and a run that reports no passed tests', () => {
    expect(check(report([...small(1_000_000, 9_000), ...large(24_000, [7021, 1503, 772, 476])])).status).toBe(1);
    expect(check(report([...small(1_000_000), ...large(24_000, [7021, 1503, 772, 476])], [])).status).toBe(1);
  });
});
