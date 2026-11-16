import { readFileSync } from 'node:fs';

const MINIMUM_RATE = 10_000;
const MINIMUM_SMALL_RUNS = 3;
const MINIMUM_SMALL_EVENTS = 200_000;
const MINIMUM_LARGE_EVENTS = 20_000;
const MINIMUM_LARGE_CHUNKS = 4;
const file = process.argv[2];
if (!file) throw new Error('usage: check-throughput.mjs <vitest output file>');
const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const text = readFileSync(file, 'utf8').replace(COLOUR, '');

const small = [...text.matchAll(/^throughput small run (\d+): (\d+) events, .* (\d+) events\/s$/gm)].map((match) => ({
  events: Number(match[2]),
  rate: Number(match[3]),
}));
const largeHeader = /^throughput large state: (\d+) events/m.exec(text);
const largeMedian = /^median (\d+) events\/s over (\d+) chunks/m.exec(text);
const chunkRates = [...text.matchAll(/^chunk (\d+) of (\d+): .* (\d+) events\/s$/gm)].map((match) => Number(match[3]));
const problems = [];
if (small.length !== MINIMUM_SMALL_RUNS)
  problems.push(
    `expected ${MINIMUM_SMALL_RUNS} small-state throughput lines with a numeric events/s value, found ${small.length}`,
  );
if (small.some((run) => run.events < MINIMUM_SMALL_EVENTS))
  problems.push(
    `a small-state run covered fewer than ${MINIMUM_SMALL_EVENTS} events: ${small.map((run) => run.events).join(', ')}`,
  );
if (small.some((run) => !(run.rate >= MINIMUM_RATE)))
  problems.push(`a small-state run is below ${MINIMUM_RATE} events/s: ${small.map((run) => run.rate).join(', ')}`);
if (!largeHeader || !largeMedian) problems.push('no large-state throughput line with a numeric median events/s');
if (largeHeader && Number(largeHeader[1]) < MINIMUM_LARGE_EVENTS)
  problems.push(`the large-state run covered ${largeHeader[1]} events, fewer than ${MINIMUM_LARGE_EVENTS}`);
if (largeMedian && Number(largeMedian[2]) < MINIMUM_LARGE_CHUNKS)
  problems.push(`the large-state run has ${largeMedian[2]} chunk rates, fewer than ${MINIMUM_LARGE_CHUNKS}`);
if (chunkRates.length < MINIMUM_LARGE_CHUNKS || chunkRates.some((rate) => !(rate > 0)))
  problems.push(
    `expected at least ${MINIMUM_LARGE_CHUNKS} positive chunk rates, found ${chunkRates.join(', ') || 'none'}`,
  );
if (/skipped/i.test(text)) problems.push('vitest reported skipped tests, so the probe did not run');
if (!/Tests +\d+ passed/.test(text)) problems.push('vitest did not report passed tests');

if (problems.length > 0) {
  for (const problem of problems) console.error(`throughput check failed: ${problem}`);
  process.exit(1);
}
console.log(
  `throughput check passed: small runs ${small.map((run) => run.rate).join(', ')} events/s over ${small[0]?.events} events each, large-state median ${largeMedian?.[1]} events/s over ${largeMedian?.[2]} chunks and ${largeHeader?.[1]} events`,
);
