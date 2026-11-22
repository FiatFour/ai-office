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
  `scanned ${artifacts.length} texts of ${repo} (${prs.size} PRs: titles, bodies, branches, reviews, issue and review comments, branch names) for credential shapes and the canary shapes of this suite (AWCANARY, CANARY_<KIND>_<8 hex>, FAKE KEY blocks, hex (either case), percent-encoded and base64 copies of those prefixes). Not scanned: branch contents, commit diffs and messages, issue bodies that are not PRs, base64 split by line wraps, anything outside these texts`,
);
console.log(`findings: ${found.length}`);
for (const f of found) console.log(`${f.where}: ${f.kinds.join(',')}`);
process.exit(found.length === 0 ? 0 : 1);
