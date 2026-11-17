import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const MODEL = 'src/floor/model.ts';
const SUITE = ['src/test/floor-state.test.ts', 'src/test/i18n-parity.test.ts'];

/** @type {Array<{ name: string, claim: string, edits: Array<[file: string, find: string, replace: string]> }>} */
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
];

const only = process.argv.slice(2);
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
    const caught = vitest().status !== 0;
    if (!caught) bad += 1;
    log(`${caught ? 'OK  ' : 'BAD '} ${mutant.name}: ${caught ? 'caught' : 'survived'}. Claim: ${mutant.claim}`);
  } finally {
    for (const [path, text] of originals) writeFileSync(path, text);
  }
}
log(`${MUTANTS.length} mutants, ${bad} survived`);
writeFileSync(process.env.MUTANT_OUT ?? '/tmp/swarm-P1-3/owner/mutants-p1-3.txt', `${lines.join('\n')}\n`);
process.exit(bad === 0 ? 0 : 1);
