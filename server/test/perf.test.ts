import { describe, expect, it } from 'vitest';
import { coldStarts, pushLatencies, stats } from '../perf/probe.ts';

const canRun =
  (process.features as { typescript?: boolean | string }).typescript !== undefined &&
  (process.features as { typescript?: boolean | string }).typescript !== false;

describe('perf probe', () => {
  it('computes the median and the p95 the rule uses', () => {
    const s = stats([5, 1, 3, 2, 4]);
    expect(s).toMatchObject({ n: 5, min: 1, median: 3, p95: 5, max: 5 });
    expect(stats([1, 2, 3, 4]).median).toBe(2.5);
  });

  it.skipIf(!canRun)(
    'measures a small cold start and push run on this machine',
    async () => {
      const [cold] = await coldStarts(1);
      expect(cold).toBeGreaterThan(0);
      const push = await pushLatencies(20);
      expect(push.client).toHaveLength(20);
      expect(stats(push.client).p95).toBeLessThan(1000);
    },
    120_000,
  );
});
