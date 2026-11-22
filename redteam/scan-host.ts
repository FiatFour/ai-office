import { parseArgs } from 'node:util';
import { hostArtifacts, realGh, scanShapes } from './scan.ts';

const { values } = parseArgs({ options: { repo: { type: 'string' } } });
const repo = String(values.repo ?? '');
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error('usage: node redteam/scan-host.ts --repo owner/repo');
  process.exit(2);
}
const artifacts = hostArtifacts(realGh, repo);
const found = scanShapes(artifacts);
const prs = new Set(artifacts.map((a) => /^pr#(\d+) /.exec(a.where)?.[1]).filter(Boolean));
console.log(
  `scanned ${artifacts.length} texts of ${repo} (${prs.size} PRs: titles, bodies, branches, reviews, issue and review comments, branch names) for credential shapes and canary values of any run`,
);
console.log(`findings: ${found.length}`);
for (const f of found) console.log(`${f.where}: ${f.kinds.join(',')}`);
process.exit(found.length === 0 ? 0 : 1);
