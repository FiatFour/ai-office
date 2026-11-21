import { readFileSync, writeFileSync } from 'node:fs';
import { ADR, BLOCK, DIFFERENCES, markdown, PR_BODY, parseDifferences } from '../e2e/canvas-compare.mjs';

const table = markdown(parseDifferences(readFileSync(DIFFERENCES, 'utf8')));
for (const file of [PR_BODY, ADR]) {
  const text = readFileSync(file, 'utf8');
  if (!BLOCK.test(text)) throw new Error(`${file} has no differences block`);
  writeFileSync(
    file,
    text.replace(BLOCK, () => `<!-- differences:start -->\n${table}\n<!-- differences:end -->`),
  );
}
console.log(`wrote ${table.split('\n').length - 2} differences into the PR body source and ADR 0005`);
