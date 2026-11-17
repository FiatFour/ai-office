import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const MODEL = 'src/floor/model.ts';
const SUITE = ['src/test'];
const SCENE = 'src/floor/Scene.tsx';
const HQ = 'server/hq.ts';
const CLI = 'server/cli.ts';
const MAIN = 'src/floor/main.tsx';
const I18N = 'src/floor/i18n.ts';

/** @type {Array<{ name: string, claim: string, tier?: 'e2e', edits: Array<[file: string, find: string, replace: string]> }>} */
const MUTANTS = [
  {
    name: 'belt-is-code',
    claim: 'a box on the belt is at ORDER',
    edits: [[MODEL, "return { station: 'ORDER', stamp: null };", "return { station: 'CODE', stamp: null };"]],
  },
  {
    name: 'building-is-test',
    claim: 'a building box is at CODE',
    edits: [[MODEL, "return { station: 'CODE', stamp: null };", "return { station: 'TEST', stamp: null };"]],
  },
  {
    name: 'test-is-qc',
    claim: 'a box in test is at TEST',
    edits: [[MODEL, "return { station: 'TEST', stamp: null };", "return { station: 'QC', stamp: null };"]],
  },
  {
    name: 'qc-is-merge',
    claim: 'a box in qc is at QC',
    edits: [
      [
        MODEL,
        "return { station: 'QC', stamp: box.changesRequested ? 'CHANGES' : null };",
        "return { station: 'MERGE', stamp: box.changesRequested ? 'CHANGES' : null };",
      ],
    ],
  },
  {
    name: 'qc-changes-unstamped',
    claim: 'a qc box with changes requested carries CHANGES',
    edits: [[MODEL, "stamp: box.changesRequested ? 'CHANGES' : null }", 'stamp: null }']],
  },
  {
    name: 'qc-always-changes',
    claim: 'a qc box without a changes request carries no stamp',
    edits: [[MODEL, "stamp: box.changesRequested ? 'CHANGES' : null }", "stamp: 'CHANGES' }"]],
  },
  {
    name: 'merge-is-shipping',
    claim: 'a box in merge is at MERGE',
    edits: [[MODEL, "return { station: 'MERGE', stamp: null };", "return { station: 'SHIPPING', stamp: null };"]],
  },
  {
    name: 'shipping-is-merge',
    claim: 'a shipping box is at SHIPPING',
    edits: [[MODEL, "return { station: 'SHIPPING', stamp: null };", "return { station: 'MERGE', stamp: null };"]],
  },
  {
    name: 'shipped-unstamped',
    claim: 'a shipped box carries SHIPPED',
    edits: [
      [MODEL, "return { station: 'SHIPPING', stamp: 'SHIPPED' };", "return { station: 'SHIPPING', stamp: null };"],
    ],
  },
  {
    name: 'shipped-off-belt',
    claim: 'a shipped box stays at SHIPPING',
    edits: [
      [MODEL, "return { station: 'SHIPPING', stamp: 'SHIPPED' };", "return { station: null, stamp: 'SHIPPED' };"],
    ],
  },
  {
    name: 'cancelled-on-belt',
    claim: 'a cancelled box is off the belt',
    edits: [[MODEL, "return { station: null, stamp: 'SCRAPPED' };", "return { station: 'ORDER', stamp: 'SCRAPPED' };"]],
  },
  {
    name: 'cancelled-unstamped',
    claim: 'a cancelled box carries SCRAPPED',
    edits: [[MODEL, "return { station: null, stamp: 'SCRAPPED' };", 'return { station: null, stamp: null };']],
  },
  {
    name: 'counts-skip',
    claim: 'the station counters count every box',
    edits: [[MODEL, 'if (station !== null) counts[station] += 1;', 'if (station !== null) counts[station] += 0;']],
  },
  {
    name: 'shipped-count-off',
    claim: 'the shipped total counts shipped boxes',
    edits: [
      [
        MODEL,
        "shipped: boxes.filter((box) => box.state === 'shipped').length",
        "shipped: boxes.filter((box) => box.state === 'shipping').length",
      ],
    ],
  },
  {
    name: 'boxes-unsorted',
    claim: 'boxes keep their order',
    edits: [[MODEL, '.sort((a, b) => a.seq - b.seq)', '.sort((a, b) => b.seq - a.seq)']],
  },
  {
    name: 'merge-not-needs',
    claim: 'a box at MERGE needs its builder',
    edits: [[MODEL, "if (box.state === 'merge') add(", "if (box.state === 'never') add("]],
  },
  {
    name: 'closed-not-needs',
    claim: 'a closed PR needs its builder',
    edits: [
      [
        MODEL,
        "box.state === 'cancelled' && box.reason === 'closed'",
        "box.state === 'cancelled' && box.reason === 'never'",
      ],
    ],
  },
  {
    name: 'needs-owner-reviewer',
    claim: 'the builder, not the reviewer, needs you',
    edits: [
      [
        MODEL,
        'worker: box === undefined ? null : (owners(box)[0] ?? null)',
        "worker: box === undefined || box.state === 'merge' ? null : (owners(box)[0] ?? null)",
      ],
    ],
  },
  {
    name: 'qc-any-reviewer',
    claim: 'only the reviewer of a qc box is At QC',
    edits: [[MODEL, "box.state === 'qc' && box.reviewer === name", "box.state === 'qc'"]],
  },
  {
    name: 'working-not-test',
    claim: 'a worker stays Working while the box is in test',
    edits: [[MODEL, "new Set<Box['state']>(['building', 'test', 'qc'])", "new Set<Box['state']>(['building', 'qc'])"]],
  },
  {
    name: 'working-not-qc',
    claim: 'a worker stays Working while the box is in qc',
    edits: [
      [MODEL, "new Set<Box['state']>(['building', 'test', 'qc'])", "new Set<Box['state']>(['building', 'test'])"],
    ],
  },
  {
    name: 'working-after-merge',
    claim: 'a worker is On break once the box leaves qc',
    edits: [
      [
        MODEL,
        "new Set<Box['state']>(['building', 'test', 'qc'])",
        "new Set<Box['state']>(['building', 'test', 'qc', 'merge', 'shipped'])",
      ],
    ],
  },
  {
    name: 'priority-qc-first',
    claim: 'Needs you wins over At QC',
    edits: [
      [
        MODEL,
        "if (mine !== undefined) return { mood: 'needs', task: mine.task };\n  const reviewing = boxes.find((box) => box.state === 'qc' && box.reviewer === name);\n  if (reviewing !== undefined) return { mood: 'qc', task: reviewing.id };",
        "const reviewing = boxes.find((box) => box.state === 'qc' && box.reviewer === name);\n  if (reviewing !== undefined) return { mood: 'qc', task: reviewing.id };\n  if (mine !== undefined) return { mood: 'needs', task: mine.task };",
      ],
    ],
  },
  {
    name: 'priority-working-first',
    claim: 'At QC wins over Working',
    edits: [
      [
        MODEL,
        "const reviewing = boxes.find((box) => box.state === 'qc' && box.reviewer === name);\n  if (reviewing !== undefined) return { mood: 'qc', task: reviewing.id };\n  const working = boxes.find((box) => box.worker === name && BUILDING.has(box.state));\n  if (working !== undefined) return { mood: 'working', task: working.id };",
        "const working = boxes.find((box) => box.worker === name && BUILDING.has(box.state));\n  if (working !== undefined) return { mood: 'working', task: working.id };\n  const reviewing = boxes.find((box) => box.state === 'qc' && box.reviewer === name);\n  if (reviewing !== undefined) return { mood: 'qc', task: reviewing.id };",
      ],
    ],
  },
  {
    name: 'working-any-worker',
    claim: 'only the box worker is Working',
    edits: [[MODEL, 'box.worker === name && BUILDING.has(box.state)', 'BUILDING.has(box.state)']],
  },
  {
    name: 'workers-unsorted-reversed',
    claim: 'workers are sorted by name',
    edits: [[MODEL, 'const workers = [...names].sort().map(', 'const workers = [...names].sort().reverse().map(']],
  },
  {
    name: 'actions-url-lost-on-merge',
    claim: 'an HQ item for a task already listed adds its host link',
    edits: [[MODEL, 'if (seen.url === null && view.url !== null) out.set(key, { ...seen, url: view.url });', '']],
  },
  {
    name: 'actions-unknown-kind-kept',
    claim: 'kinds the floor does not know are dropped',
    edits: [
      [MODEL, '    default:\n      return null;', "    default:\n      return { kind: 'alert', detail: action.kind };"],
    ],
  },
  {
    name: 'actions-url-dropped',
    claim: 'the host link of an item is kept',
    edits: [[MODEL, 'task: action.task ?? null, url: action.url ?? null', 'task: action.task ?? null, url: null']],
  },
  {
    name: 'actions-detail-dropped',
    claim: 'the site of a website item is kept',
    edits: [
      [MODEL, "return { kind: 'website', detail: action.site ?? null };", "return { kind: 'website', detail: null };"],
    ],
  },
  {
    name: 'worker-station-dropped',
    claim: 'a worker reports the station of its box',
    edits: [
      [MODEL, 'const station = boxViews.find((box) => box.id === task)?.station ?? null;', 'const station = null;'],
    ],
  },
  {
    name: 'locale-key-missing-th',
    claim: 'a key missing from th.json is caught',
    edits: [['src/locales/th.json', '"empty": "ไม่มีอะไรรอคุณ",\n', '']],
  },
  {
    name: 'locale-key-missing-en',
    claim: 'a key missing from en.json is caught',
    edits: [['src/locales/en.json', '"empty": "Nothing is waiting on you.",\n', '']],
  },
  {
    name: 'locale-placeholder-lost',
    claim: 'a placeholder lost in one language is caught',
    edits: [
      [
        'src/locales/th.json',
        '"openActionItems": "{{name}} รอคุณอยู่ เปิด Action items"',
        '"openActionItems": "รอคุณอยู่ เปิด Action items"',
      ],
    ],
  },
  {
    name: 'locale-stamp-translated',
    claim: 'an English stamp must not enter the locale files',
    edits: [['src/locales/en.json', '"delivered": "Shipment delivered"', '"delivered": "SHIPPED"']],
  },

  {
    name: 'human-cancel-needs-you',
    claim: 'a box scrapped by a person asks nothing of its builder',
    edits: [[MODEL, "box.state === 'cancelled' && box.reason === 'closed'", "box.state === 'cancelled'"]],
  },
  {
    name: 'cancelled-counted-at-ORDER',
    claim: 'a scrapped box counts at no station',
    edits: [[MODEL, 'if (station !== null) counts[station] += 1;', "counts[station ?? 'ORDER'] += 1;"]],
  },
  {
    name: 'shipping-counted-as-shipped',
    claim: 'a box on the truck that has not left is not shipped',
    edits: [
      [
        MODEL,
        "shipped: boxes.filter((box) => box.state === 'shipped').length",
        "shipped: boxes.filter((box) => box.state === 'shipped' || box.state === 'shipping').length",
      ],
    ],
  },
  {
    name: 'stations-order-QC-MERGE-swapped',
    claim: 'the stations run ORDER CODE TEST QC MERGE SHIPPING',
    edits: [
      [
        MODEL,
        "['ORDER', 'CODE', 'TEST', 'QC', 'MERGE', 'SHIPPING']",
        "['ORDER', 'CODE', 'TEST', 'MERGE', 'QC', 'SHIPPING']",
      ],
    ],
  },
  {
    name: 'codeOf-no-upper',
    claim: 'the box code is upper case',
    edits: [[MODEL, "(id.split('/').pop() ?? id).toUpperCase()", "(id.split('/').pop() ?? id)"]],
  },
  { name: 'rev-zero', claim: 'the view carries the snapshot rev', edits: [[MODEL, 'rev: snapshot.rev,', 'rev: 0,']] },
  {
    name: 'action-worker-last-owner',
    claim: 'the first builder is asked, not the last owner',
    edits: [[MODEL, '(owners(box)[0] ?? null)', '(owners(box).at(-1) ?? null)']],
  },
  {
    name: 'workers-only-staff',
    claim: 'a worker on a box but not in the staff is listed',
    edits: [[MODEL, 'for (const box of boxes) for (const owner of owners(box)) names.add(owner);', '']],
  },
  {
    name: 'owners-drop-worker',
    claim: 'the worker of a box is one of its owners',
    edits: [[MODEL, '...(box.worker === null ? [] : [box.worker])', '']],
  },
  {
    name: 'layout-MERGE-drawn-at-QC',
    claim: 'each station has its own gantry x',
    edits: [['src/floor/layout.ts', 'MERGE: 309,', 'MERGE: 284,']],
  },
  {
    name: 'layout-max-workers-4',
    claim: 'six workers are drawn',
    edits: [['src/floor/layout.ts', 'export const MAX_WORKERS = 6;', 'export const MAX_WORKERS = 4;']],
  },
  {
    name: 'scene-bang-on-qc',
    claim: 'the "!" button sits on the worker that needs you',
    tier: 'e2e',
    edits: [
      [
        SCENE,
        "{worker.mood === 'needs' ? (\n              <button",
        "{worker.mood === 'qc' ? (\n              <button",
      ],
    ],
  },
  {
    name: 'scene-no-stamp',
    claim: 'a stamped box shows its stamp',
    tier: 'e2e',
    edits: [[SCENE, '{box.stamp === null ? null : (', '{true ? null : (']],
  },
  {
    name: 'css-reduced-motion-transitions-kept',
    claim: 'with prefers-reduced-motion a moving box jumps, it does not glide',
    tier: 'e2e',
    edits: [['src/floor/floor.css', '  .mover,\n  .hit {\n    transition: none;\n  }', '  .mover,\n  .hit {\n  }']],
  },
  {
    name: 'css-reduced-motion-animations-kept',
    claim: 'with prefers-reduced-motion nothing animates',
    tier: 'e2e',
    edits: [['src/floor/floor.css', '  .belt {\n    animation: none;\n  }', '  .belt {\n  }']],
  },
  {
    name: 'css-not-pixelated',
    claim: 'the scene is drawn with hard pixels',
    tier: 'e2e',
    edits: [['src/floor/floor.css', 'image-rendering: pixelated;', 'image-rendering: auto;']],
  },
  {
    name: 'css-thai-pixel-monospace',
    claim: 'Thai in the pixel font falls back to a Thai font',
    tier: 'e2e',
    edits: [
      [
        'src/floor/floor.css',
        'font-family: "Silkscreen", "Sarabun", monospace;',
        'font-family: "Silkscreen", monospace;',
      ],
    ],
  },
  {
    name: 'css-warn-colour',
    claim: 'N NEED YOU is the canvas yellow',
    tier: 'e2e',
    edits: [['src/floor/floor.css', '.warn {\n  color: var(--yellow);', '.warn {\n  color: #ff8a80;']],
  },
  {
    name: 'i18n-langFromLocale-exact',
    claim: 'any th-* locale picks Thai',
    edits: [[I18N, "locale?.toLowerCase().startsWith('th')", "locale?.toLowerCase() === 'th'"]],
  },
  {
    name: 'i18n-fallback-th',
    claim: 'a missing key falls back to English',
    edits: [[I18N, "fallbackLng: 'en',", "fallbackLng: 'th',"]],
  },
  {
    name: 'main-saved-lang-ignored',
    claim: 'the saved language is read back',
    edits: [[I18N, '[asked, saved].find(', '[asked].find(']],
  },
  {
    name: 'main-saved-lang-not-passed',
    claim: 'the page reads the saved language on load',
    tier: 'e2e',
    edits: [[MAIN, 'localStorage.getItem(STORAGE_KEY),', 'null,']],
  },
  {
    name: 'main-html-lang-not-updated',
    claim: 'switching language sets the lang of the page',
    edits: [[I18N, '  root.lang = lang;\n', '']],
  },
  {
    name: 'main-switch-not-persisted',
    claim: 'the switch writes the page lang and the saved choice',
    tier: 'e2e',
    edits: [[MAIN, '    persistLang(next, document.documentElement, localStorage);\n', '']],
  },
  {
    name: 'toast-string-frozen',
    claim: 'the delivered toast follows the language',
    tier: 'e2e',
    edits: [
      ['src/floor/App.tsx', "<span>{t('floor.hud.deliveredDetail', { task: toast })}</span>", '<span>{toast}</span>'],
    ],
  },
  {
    name: 'nav-aria-not-translated',
    claim: 'the HQ nav label comes from the locale files',
    tier: 'e2e',
    edits: [['src/floor/App.tsx', "<nav aria-label={t('floor.hud.menu')}>", '<nav aria-label="HQ">']],
  },
  {
    name: 'locale-plural-other-missing-en',
    claim: 'a plural form missing from en.json is caught',
    edits: [['src/locales/en.json', '"boxesTotal_other": "{{count}} boxes",\n', '']],
  },
  {
    name: 'locale-plural-other-missing-th',
    claim: 'a plural form missing from th.json is caught',
    edits: [['src/locales/th.json', '"boxesTotal_other": "{{count}} กล่อง",\n', '']],
  },
  {
    name: 'locale-plural-lost-count',
    claim: 'a plural form without {{count}} is caught',
    edits: [['src/locales/en.json', '"boxesTotal_one": "{{count}} box"', '"boxesTotal_one": "one box"']],
  },
  {
    name: 'locale-demo-chip-wording',
    claim: 'the demo chip says Demo data as on the canvas',
    tier: 'e2e',
    edits: [['src/locales/en.json', '"demo": "Demo data"', '"demo": "Demo replay"']],
  },
  {
    name: 'scene-firewall-label-no-bar',
    claim: 'the FIREWALL art label is 4.5 to 1 or better',
    tier: 'e2e',
    edits: [[SCENE, '<rect x="213" y="50" width="53" height="7" fill="#15181c" />', '']],
  },
  {
    name: 'scene-cage-plate-removed',
    claim: 'every cage has its CAGE n plate',
    tier: 'e2e',
    edits: [[SCENE, 'names[slot] === undefined', 'true']],
  },
  {
    name: 'index-external-font',
    claim: 'the floor loads nothing from another host',
    tier: 'e2e',
    edits: [
      [
        'src/index.html',
        '</head>',
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=VT323"></head>',
      ],
    ],
  },
  {
    name: 'assets-any-method',
    claim: 'only GET reads an asset',
    edits: [[HQ, "method === 'GET' && options.assets !== undefined", 'options.assets !== undefined']],
  },
  {
    name: 'assets-symlink-followed',
    claim: 'a symlink in the asset folder is refused',
    edits: [['server/assets.ts', ' || realpathSync(wanted) !== wanted', '']],
  },
  {
    name: 'assets-no-root-prefix-check',
    claim: 'a path that climbs out of the folder is refused',
    edits: [['server/assets.ts', '!wanted.startsWith(base + sep) || ', '']],
  },
  {
    name: 'hq-no-nosniff',
    claim: 'every response says nosniff',
    edits: [[HQ, "    res.setHeader('x-content-type-options', 'nosniff');\n", '']],
  },
  {
    name: 'hq-csp-inline-script',
    claim: 'the policy allows no inline script',
    edits: [
      [
        HQ,
        'const FLOOR_POLICY = POLICY("\'self\'", "\'self\'");',
        "const FLOOR_POLICY = POLICY(\"'self' 'unsafe-inline'\", \"'self'\");",
      ],
    ],
  },
  {
    name: 'hq-csp-external-host',
    claim: 'the policy names no external host',
    edits: [[HQ, "font-src 'self';", "font-src 'self' https://fonts.gstatic.com;"]],
  },
  {
    name: 'demo-write-allowed',
    claim: 'demo mode refuses writes',
    edits: [
      [HQ, "if (options.readOnly !== undefined && method !== 'GET') throw", "if (options.readOnly === 'never') throw"],
    ],
  },
  {
    name: 'cli-demo-not-read-only',
    claim: '--demo starts HQ read-only',
    edits: [[CLI, '      readOnly: DEMO_READ_ONLY,\n', '']],
  },
  {
    name: 'cli-demo-home-kept',
    claim: '--demo removes its throw-away home',
    edits: [[CLI, 'const wipe = () => rmSync(home, { recursive: true, force: true });', 'const wipe = () => {};']],
  },
  {
    name: 'cli-demo-uses-real-home',
    claim: '--demo never touches ~/.agent-works',
    edits: [
      [
        CLI,
        "const home = mkdtempSync(join(tmpdir(), 'aw-demo-'));",
        'const home = resolveHome(env);\n  mkdirSync(home, { recursive: true });',
      ],
    ],
  },
  {
    name: 'cli-demo-no-sighup',
    claim: '--demo cleans up on SIGHUP',
    edits: [[CLI, "['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']", "['SIGTERM', 'SIGINT', 'SIGQUIT']"]],
  },
  {
    name: 'cli-demo-no-sigquit',
    claim: '--demo cleans up on SIGQUIT',
    edits: [[CLI, "['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']", "['SIGTERM', 'SIGINT', 'SIGHUP']"]],
  },
  {
    name: 'cli-demo-bad-fixture-code',
    claim: 'a bad events file exits 2',
    edits: [
      [
        CLI,
        'throw new CliError(error.message, 2);\n    throw error;\n  }\n};\n\nconst runDemo',
        'throw new CliError(error.message, 1);\n    throw error;\n  }\n};\n\nconst runDemo',
      ],
    ],
  },
  {
    name: 'demo-fixture-line-unnamed',
    claim: 'a bad events line is named with its file and line number',
    edits: [['server/modes/demo.ts', '} line $', '} lne $']],
  },
  {
    name: 'fixture-poll-by-non-author',
    claim: 'a poll in the fixture reports only reviews the PR author could post on one account',
    edits: [
      [
        'fixtures/demo/events.jsonl',
        '"reviews":[{"reviewer":"FiatFour","verdict":"comment"}],"source":"poll","state":"merged"',
        '"reviews":[{"reviewer":"vega","verdict":"approve"}],"source":"poll","state":"merged"',
      ],
    ],
  },
];

const only = process.argv.slice(2);
const e2e = () => {
  const build = spawnSync('pnpm', ['--filter', '@agent-works/floor', 'build'], { cwd: ROOT, encoding: 'utf8' });
  if (build.status !== 0) return 'build failed';
  const lanes = spawnSync('node', ['src/e2e/lanes.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, OUT: join(process.env.TMPDIR ?? '/tmp', 'mutant-lanes') },
  });
  return lanes.status === 0 ? null : (lanes.stdout.match(/FAIL lane [\d.]+/g) ?? ['lanes crashed']).join(', ');
};
const vitest = () =>
  spawnSync('pnpm', ['vitest', 'run', ...SUITE], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 300_000,
  });

/** @type {string[]} */
const lines = [];
/** @param {string} line */
const log = (line) => {
  console.log(line);
  lines.push(line);
};

const baseline = vitest();
log(`baseline ${baseline.status === 0 ? 'PASS' : 'FAIL'}`);
if (baseline.status !== 0) {
  console.error(baseline.stdout.slice(-2000));
  process.exit(1);
}

let bad = 0;
for (const mutant of MUTANTS) {
  if (only.length > 0 && !only.includes(mutant.name)) continue;
  /** @type {Map<string, string>} */
  const originals = new Map();
  try {
    for (const [file, find, replace] of mutant.edits) {
      const path = join(ROOT, file);
      const current = readFileSync(path, 'utf8');
      originals.set(path, originals.get(path) ?? current);
      if (!current.includes(find)) throw new Error(`${mutant.name}: pattern not found in ${file}`);
      writeFileSync(path, current.replace(find, replace));
    }
    let how = vitest().status !== 0 ? 'unit tests' : null;
    if (how === null && mutant.tier === 'e2e') how = e2e();
    if (how === null) bad += 1;
    log(
      `${how === null ? 'BAD ' : 'OK  '} ${mutant.name}: ${how === null ? 'survived' : `caught by ${how}`}. Claim: ${mutant.claim}`,
    );
  } finally {
    for (const [path, text] of originals) writeFileSync(path, text);
    if (mutant.tier === 'e2e') spawnSync('pnpm', ['--filter', '@agent-works/floor', 'build'], { cwd: ROOT });
  }
}
log(`${MUTANTS.length} mutants, ${bad} survived`);
writeFileSync(process.env.MUTANT_OUT ?? '/tmp/swarm-P1-3/owner/mutants-p1-3.txt', `${lines.join('\n')}\n`);
process.exit(bad === 0 ? 0 : 1);
