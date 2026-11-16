import { readFileSync } from 'node:fs';

const MINIMUM = 10_000;
const file = process.argv[2];
if (!file) throw new Error('usage: check-throughput.mjs <vitest output file>');
const text = readFileSync(file, 'utf8');

const small = [...text.matchAll(/^throughput small run (\d+): .* (\d+) events\/s$/gm)].map((match) => Number(match[2]));
const large = /^median (\d+) events\/s over (\d+) chunks/m.exec(text);
const problems = [];
if (small.length !== 3)
  problems.push(`expected 3 small-state throughput lines with a numeric events/s value, found ${small.length}`);
if (small.some((rate) => !(rate >= MINIMUM)))
  problems.push(`a small-state run is below ${MINIMUM} events/s: ${small.join(', ')}`);
if (!large) problems.push('no large-state throughput line with a numeric median events/s');
if (/skipped/i.test(text)) problems.push('vitest reported skipped tests, so the probe did not run');
if (!/Tests +\d+ passed/.test(text)) problems.push('vitest did not report passed tests');

if (problems.length > 0) {
  for (const problem of problems) console.error(`throughput check failed: ${problem}`);
  process.exit(1);
}
console.log(
  `throughput check passed: small runs ${small.join(', ')} events/s, large-state median ${large?.[1]} events/s`,
);
