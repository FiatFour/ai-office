export const OWNED: Readonly<Record<string, readonly string[]>> = {
  'P3-1': ['bench/setb/**', 'bench/run.ts', 'bench/report.ts', 'docs/bench-set-b.md'],
  'P3-2': ['bench/results/**'],
  'P3-3': ['bench/reviewer/**', 'server/agents/review-prompt.ts'],
  'P3-4': [
    '.github/workflows/ci.yml',
    'bench/test/mutants.mjs',
    'server/test/mutants-p1-2.mjs',
    'scripts/contract-table.mjs',
    'test/contract/**',
  ],
  'P3-5': [
    'server/agents/claude-code.ts',
    'server/agents/runtime.ts',
    'server/githost/host.ts',
    'server/test/agents.test.ts',
    'server/test/githost.contract.test.ts',
  ],
  'P3-6': ['redteam/**', 'src/test/demo-cli.test.ts', 'docs/decisions/0004-cages-mode-jobs.md'],
  'P3-7': [
    'src/e2e/**',
    'src/locales/**',
    'src/floor/i18n.ts',
    'src/floor/App.tsx',
    'src/screens/**',
    'src/test/i18n-parity.test.ts',
    'docs/review/canvas/**',
  ],
  'P3-8': ['docs/architecture.md', 'docs/plans/agent-works-plan.md', 'docs/decisions/0005-*'],
  'P3-9': ['packages/core/src/lifecycle.ts', 'server/githost/watch*.ts', 'src/floor/useHq.ts'],
  'P3-10': ['server/preflight/**', 'server/snapshot/host.ts'],
  'P3-11': [
    'server/blocked.ts',
    'server/modes/cages.ts',
    'server/sandbox/firewall.ts',
    'server/sandbox/proxy/allowlist.mjs',
    'src/floor/Scene.tsx',
  ],
  'P3-12': ['server/terminal/**'],
  'P3-14': ['server/tickets.ts'],
  'P3-15': ['server/agents/captain.ts'],
  'P3-16': ['server/snapshot/changes.ts'],
  'P3-17': ['server/brief/**'],
  'P3-18': ['server/modes/budget.ts'],
  'P3-20': ['server/config.ts'],
  'P3-21': ['server/secrets.ts'],
  'P3-22': ['server/factory-config.ts'],
  hotspot: ['server/snapshot.ts', 'server/hq.ts'],
  workflows: ['.github/**'],
};

const globToRe = (glob: string): RegExp =>
  new RegExp(
    `^${glob
      .split('**')
      .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
      .join('.*')}$`,
  );

const COMPILED = Object.entries(OWNED).flatMap(([owner, globs]) =>
  globs.map((glob) => [owner, globToRe(glob)] as const),
);

export const ownerOf = (path: string): string | null =>
  COMPILED.find(([, re]) => re.test(path.replace(/^\.\//, '')))?.[0] ?? null;
