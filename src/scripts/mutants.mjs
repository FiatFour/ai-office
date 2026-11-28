// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the mutants edit source text that holds ${}
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const MODEL = 'src/floor/model.ts';
const SUITE = ['src/test'];
const SCENE = 'src/floor/Scene.tsx';
const HQ = 'server/hq.ts';
const CLI = 'server/cli.ts';
const MAIN = 'src/floor/main.tsx';
const I18N = 'src/floor/i18n.ts';
const DIFFS = 'docs/review/P1-3-canvas-differences.md';
const INVENTORY = 'src/scripts/inventory.mjs';
const CC = 'src/e2e/canvas-compare.mjs';
const GATES = 'src/e2e/gates.mjs';
const HARNESS = 'src/e2e/harness.mjs';
const SCREENS = 'src/floor/screens.ts';
const HOST = 'src/floor/ScreenHost.tsx';
const PARITY = 'src/test/i18n-parity.test.ts';
const APP = 'src/floor/App.tsx';
const PF_MODEL = 'src/screens/preflight/model.ts';
const PF_SCREEN = 'src/screens/preflight/screen.tsx';
const DRAWER = 'src/floor/Drawer.tsx';

/** @type {Array<{ name: string, claim: string, tier?: 'e2e' | 'lane9' | 'gates' | 'interrupt' | 'preflight' | 'prs', edits: Array<[file: string, find: string, replace: string]>, copies?: Array<[to: string, from: string]> }>} */
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
    edits: [[MODEL, 'counts[panelOf(station)] += 1;', 'counts[panelOf(station)] += 0;']],
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
    edits: [['src/locales/th/floor.json', '"empty": "ไม่มีอะไรรอคุณ",\n', '']],
  },
  {
    name: 'locale-key-missing-en',
    claim: 'a key missing from en.json is caught',
    edits: [['src/locales/en/floor.json', '"empty": "Nothing is waiting on you.",\n', '']],
  },
  {
    name: 'locale-placeholder-lost',
    claim: 'a placeholder lost in one language is caught',
    edits: [
      [
        'src/locales/th/floor.json',
        '"openActionItems": "{{name}} รอคุณอยู่ เปิด Action items"',
        '"openActionItems": "รอคุณอยู่ เปิด Action items"',
      ],
    ],
  },
  {
    name: 'locale-stamp-translated',
    claim: 'an English stamp must not enter the locale files',
    edits: [['src/locales/en/floor.json', '"delivered": "Shipment delivered"', '"delivered": "SHIPPED"']],
  },

  {
    name: 'human-cancel-needs-you',
    claim: 'a box scrapped by a person asks nothing of its builder',
    edits: [[MODEL, "box.state === 'cancelled' && box.reason === 'closed'", "box.state === 'cancelled'"]],
  },
  {
    name: 'cancelled-counted-at-ORDER',
    claim: 'a scrapped box counts at no station',
    edits: [
      [MODEL, 'if (station !== null) counts[panelOf(station)] += 1;', "counts[panelOf(station ?? 'ORDER')] += 1;"],
    ],
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
    name: 'panel-merge-own-cell',
    claim: 'a box at MERGE counts under SHIP, the canvas has five cells',
    edits: [
      [
        MODEL,
        "station === 'MERGE' || station === 'SHIPPING' ? 'SHIP' : station",
        "station === 'SHIPPING' ? 'SHIP' : (station as PanelLabel)",
      ],
    ],
  },
  {
    name: 'needs-chip-low-contrast',
    claim: 'the named contrast exception covers only the canvas Needs you colours',
    tier: 'e2e',
    edits: [
      ['src/floor/App.tsx', "needs: { bg: '#ef5350', fg: '#f5f3ec' }", "needs: { bg: '#ef5350', fg: '#c9cdd4' }"],
    ],
  },
  {
    name: 'settings-button-missing',
    claim: 'the language switch is reachable from the HQ menu Settings button',
    tier: 'e2e',
    edits: [['src/floor/App.tsx', "onClick={() => setDrawer('settings')}", 'onClick={() => setDrawer(null)}']],
  },
  {
    name: 'locale-demo-mode-wording',
    claim: 'the Debug mode line says Demo data as on the canvas',
    edits: [['src/locales/en/floor.json', '"modeDemo": "Demo data"', '"modeDemo": "Demo replay"']],
  },
  {
    name: 'codeOf-no-upper',
    claim: 'the box code is upper case',
    edits: [[MODEL, "(id.split('/').pop() ?? id).toUpperCase()", "(id.split('/').pop() ?? id)"]],
  },
  {
    name: 'floor-drops-checks-failed',
    claim: 'the floor shows red CI as an Action item that names the checks',
    edits: [[MODEL, "return { kind: 'checks_failed', detail: action.checks?.join(', ') ?? null };", 'return null;']],
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
    edits: [['src/locales/en/floor.json', '"boxesTotal_other": "{{count}} boxes",\n', '']],
  },
  {
    name: 'locale-plural-other-missing-th',
    claim: 'a plural form missing from th.json is caught',
    edits: [['src/locales/th/floor.json', '"boxesTotal_other": "{{count}} กล่อง",\n', '']],
  },
  {
    name: 'locale-plural-lost-count',
    claim: 'a plural form without {{count}} is caught',
    edits: [['src/locales/en/floor.json', '"boxesTotal_one": "{{count}} box"', '"boxesTotal_one": "one box"']],
  },
  {
    name: 'locale-demo-chip-wording',
    claim: 'the demo chip says Demo data as on the canvas',
    tier: 'e2e',
    edits: [['src/locales/en/floor.json', '"demo": "Demo data"', '"demo": "Demo replay"']],
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
    name: 'cli-demo-handlers-after-banner',
    claim: '--demo installs its signal handlers before it prints the banner a fast SIGTERM reacts to',
    edits: [
      [
        CLI,
        '    const quit = () => void hq.close();\n    for (const signal of DEMO_SIGNALS) process.on(signal, quit);\n    io.out(`Demo data from ${source.label} at ${hq.url} (pid ${hq.pid}). Press Ctrl-C to stop.`);\n    if (!noOpen) openBrowser(hq.url);\n',
        '    io.out(`Demo data from ${source.label} at ${hq.url} (pid ${hq.pid}). Press Ctrl-C to stop.`);\n    if (!noOpen) openBrowser(hq.url);\n    const quit = () => void hq.close();\n    for (const signal of DEMO_SIGNALS) process.on(signal, quit);\n',
      ],
    ],
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
  {
    name: 'hq-csp-connect-any-ws',
    claim: 'connect-src lists exactly the two loopback socket origins',
    edits: [
      [
        HQ,
        "const SOCKETS = 'ws://127.0.0.1:* ws://localhost:*';",
        "const SOCKETS = 'ws://127.0.0.1:* ws://localhost:* ws:';",
      ],
    ],
  },
  {
    name: 'hq-csp-no-frame-ancestors',
    claim: 'the policy forbids framing',
    edits: [[HQ, "; frame-ancestors 'none'", '']],
  },
  {
    name: 'hq-csp-no-object-src',
    claim: 'the policy forbids plugins',
    edits: [[HQ, " object-src 'none';", '']],
  },
  {
    name: 'cli-demo-no-exit-hook',
    claim: '--demo removes its throw-away home when the process exits without a signal',
    edits: [[CLI, "process.once('exit', wipe);", '']],
  },
  {
    name: 'cli-demo-not-read-only-with-env',
    claim: '--demo is read-only when AGENT_WORKS_DEMO_EVENTS is set',
    edits: [
      [
        CLI,
        'readOnly: DEMO_READ_ONLY,',
        '...(env.AGENT_WORKS_DEMO_EVENTS === undefined ? { readOnly: DEMO_READ_ONLY } : {}),',
      ],
    ],
  },
  {
    name: 'demo-fixture-blank-strict',
    claim: 'a line of only spaces in the events file is skipped',
    edits: [['server/modes/demo.ts', "line.trim() === ''", "line === ''"]],
  },
  {
    name: 'fonts-sarabun-400-missing',
    claim: 'both Sarabun weights load from the build, with no network',
    tier: 'e2e',
    edits: [[MAIN, "import '@fontsource/sarabun/thai-400.css';\n", '']],
  },
  {
    name: 'toast-title-language-frozen',
    claim: 'the toast title follows the language, not only its detail',
    tier: 'e2e',
    edits: [['src/floor/App.tsx', "{t('floor.hud.delivered')}", "{t('floor.hud.delivered', { lng: 'en' })}"]],
  },
  {
    name: 'lane9-notbuilt-check-off',
    claim: 'lane 9 fails when a not-built text is on the built floor',
    tier: 'lane9',
    edits: [[CC, "if (d.status === 'not-built' && canvas !== '' && builtText.includes(canvas))", 'if (false)']],
  },
  {
    name: 'lane9-stale-table-check-off',
    claim: 'lane 9 fails when the table in the PR body or the ADR is stale',
    tier: 'lane9',
    edits: [[CC, 'if (BLOCK.exec(doc)?.[1] !== markdown(diffs))', 'if (false)']],
  },
  {
    name: 'lane9-min-count-1',
    claim: 'lane 9 fails when almost every difference is deleted',
    tier: 'lane9',
    edits: [[CC, 'if (diffs.length < minEntries)', 'if (diffs.length < 1)']],
  },
  {
    name: 'lane9-fixed-check-off',
    claim: 'lane 9 fails when a fixed entry still differs',
    tier: 'lane9',
    edits: [
      ['src/scripts/inventory.mjs', 'else if (kind !== undefined) problems.push(', 'else if (false) problems.push('],
    ],
  },
  {
    name: 'lane9-stale-key-check-off',
    claim: 'lane 9 fails when an entry covers a key that no longer differs',
    tier: 'lane9',
    edits: [['src/scripts/inventory.mjs', 'if (kind === undefined) problems.push(', 'if (false) problems.push(']],
  },
  {
    name: 'lane9-uncovered-check-off',
    claim: 'lane 9 fails when a difference is in no entry',
    tier: 'lane9',
    edits: [['src/scripts/inventory.mjs', 'if (!covered.has(key)) problems.push(', 'if (false) problems.push(']],
  },
  {
    name: 'lane9-duplicate-cover-check-off',
    claim: 'lane 9 fails when two entries cover one key',
    tier: 'lane9',
    edits: [['src/scripts/inventory.mjs', 'if (owners.has(key)) problems.push(', 'if (false) problems.push(']],
  },
  {
    name: 'lane9-notbuilt-builtonly-check-off',
    claim: 'lane 9 fails when a not-built entry covers a key only the built floor has',
    tier: 'lane9',
    edits: [['src/scripts/inventory.mjs', "entry.status === 'not-built' && kind === 'built-only'", 'false']],
  },
  {
    name: 'lane9-regions-check-off',
    claim: 'lane 9 fails when a pixel cell above the threshold is in no region',
    tier: 'lane9',
    edits: [
      [CC, 'for (const { row, col, value } of uncoveredCells(grid, diffs))', 'for (const { row, col, value } of [])'],
    ],
  },
  {
    name: 'lane9-layout-widths-off',
    claim: 'lane 9 reads the two pane widths from the comparison image',
    tier: 'lane9',
    edits: [[CC, 'if (cw !== bw || cw !== COMPARE.pane)', 'if (false)']],
  },
  {
    name: 'lane9-compare-ignores-built-image',
    claim: 'lane 9 fails when the comparison image does not change with the built floor image',
    tier: 'lane9',
    edits: [[CC, 'img(builtShot)}">', 'img(canvasShot)}">']],
  },
  {
    name: 'lane9-delete-entry',
    claim: 'deleting an entry makes lane 9 fail',
    tier: 'lane9',
    edits: [
      [
        DIFFS,
        'D04 | not-built | Order board | - | Order-board select (First active, Backlog). Needs boards.\n  covers: text:order board\n',
        '',
      ],
    ],
  },
  {
    name: 'lane9-delete-covers-key',
    claim: 'deleting a covers key makes lane 9 fail',
    tier: 'lane9',
    edits: [[DIFFS, '  covers: text:#x\n', '']],
  },
  {
    name: 'lane9-relabel-status',
    claim: 'relabelling an entry status makes lane 9 fail',
    tier: 'lane9',
    edits: [[DIFFS, 'D02 | fixed |', 'D02 | not-built |']],
  },
  {
    name: 'lane9-compare-image-replaced',
    claim: 'replacing the committed comparison image with another screenshot makes lane 9 fail',
    tier: 'lane9',
    edits: [],
    copies: [['docs/review/P1-3-review-canvas-compare.png', 'docs/review/P1-3-review-floor.png']],
  },
  {
    name: 'lane9-inventory-ignores-svg-text',
    claim: 'an inventory that ignores SVG text makes lane 9 fail',
    tier: 'lane9',
    edits: [[INVENTORY, "'polyline', 'text', 'use'", "'polyline', 'use'"]],
  },
  {
    name: 'lane9-inventory-ignores-buttons',
    claim: 'an inventory that ignores buttons makes lane 9 fail',
    tier: 'lane9',
    edits: [[INVENTORY, "'script',\n    'style',", "'button',\n    'script',\n    'style',"]],
  },
  {
    name: 'lane9-inventory-ignores-fonts',
    claim: 'an inventory that ignores fonts makes lane 9 fail',
    tier: 'lane9',
    edits: [[INVENTORY, 'out[`', "if (family !== 'font') out[`"]],
  },
  {
    name: 'lane9-inventory-ignores-animations',
    claim: 'an inventory that ignores animation names makes lane 9 fail',
    tier: 'lane9',
    edits: [[INVENTORY, "for (const name of anims) put('anim', name);", '']],
  },
  {
    name: 'gates-contrast-skipped',
    claim: 'the contrast gate fails text under 4.5 to 1',
    tier: 'gates',
    edits: [[GATES, 'if (ratio >= MIN_CONTRAST) continue;', 'if (ratio >= 0) continue;']],
  },
  {
    name: 'gates-contrast-bar-lowered',
    claim: 'the contrast bar is 4.5 to 1',
    tier: 'gates',
    edits: [[GATES, 'export const MIN_CONTRAST = 4.5;', 'export const MIN_CONTRAST = 2;']],
  },
  {
    name: 'gates-contrast-alpha-ignored',
    claim: 'the contrast gate blends translucent text and backgrounds',
    tier: 'gates',
    edits: [[GATES, 'const alpha = (over[3] ?? 255) / 255;', 'const alpha = 1;']],
  },
  {
    name: 'gates-motion-not-sampled',
    claim: 'the reduced-motion gate counts running animations',
    tier: 'gates',
    edits: [[GATES, "a.playState === 'running'", "a.playState === 'never'"]],
  },
  {
    name: 'gates-motion-ignores-smil',
    claim: 'the reduced-motion gate counts SVG animation elements',
    tier: 'gates',
    edits: [[GATES, '...(smil > 0 ?', '...(smil > 1e9 ?']],
  },
  {
    name: 'gates-axe-not-blocking',
    claim: 'the axe gate fails on serious and critical findings',
    tier: 'gates',
    edits: [[HARNESS, "rule.impact === 'serious' || rule.impact === 'critical'", "rule.impact === 'none'"]],
  },
  {
    name: 'gates-raw-key-blind',
    claim: 'the key gate fails on a raw locale key on screen',
    tier: 'gates',
    edits: [[GATES, "namespaces.includes(RAW_KEY.exec(text)?.[1] ?? '')", 'false']],
  },
  {
    name: 'css-reduced-motion-rule-dropped',
    claim: 'prefers-reduced-motion stops the belt animation',
    tier: 'gates',
    edits: [
      [
        'src/floor/floor.css',
        '  .belt {\n    animation: none;',
        '  .belt {\n    animation: belt 0.6s steps(6) infinite;',
      ],
    ],
  },
  {
    name: 'i18n-namespace-not-wrapped',
    claim: 'a locale file becomes the subtree named after the file',
    edits: [[I18N, '[namespace]: tree', '...tree']],
  },
  {
    name: 'screens-id-not-checked',
    claim: 'a screen exports the id of its directory',
    edits: [[SCREENS, 'if (screen.id !== dir)', 'if (false)']],
  },
  {
    name: 'screens-route-prefix',
    claim: 'a screen route matches the whole hash',
    edits: [[SCREENS, '(route) => hash ===', '(route) => hash.length > 0 ||']],
  },
  {
    name: 'screens-duplicate-allowed',
    claim: 'two screens cannot share an id',
    edits: [[SCREENS, 'if (routes.has(dir)) {', 'if (false) {']],
  },
  {
    name: 'screens-load-error-uncaught',
    claim: 'a screen module that throws becomes an error for that screen, not a crash',
    edits: [[SCREENS, 'return fail(dir, `failed to load:', 'throw new Error(`failed to load:']],
  },
  {
    name: 'screens-id-mismatch-unnamed',
    claim: 'a wrong id is reported as "screen <id>: exports id <id>, expected <dir>"',
    edits: [[SCREENS, 'exports id ${screen.id}, expected ${dir}', 'has the wrong id']],
  },
  {
    name: 'screens-ready-not-validated',
    claim: 'a ready field that is not a selector string is refused',
    edits: [[SCREENS, "if (screen.ready !== undefined && typeof screen.ready !== 'string')", 'if (false)']],
  },
  {
    name: 'screens-bad-screen-present',
    claim: 'the unit tests fail when any registered screen is invalid',
    copies: [['src/screens/zz-bad/screen.tsx', 'src/floor/Drawer.tsx']],
    edits: [],
  },
  {
    name: 'screens-wrapper-id-wrong',
    claim: 'the registry wraps every screen in [data-screen=<id>], the default ready root',
    tier: 'gates',
    edits: [[HOST, 'data-screen={route.id}', 'data-screen="x"']],
  },
  {
    name: 'screens-ready-attr-dropped',
    claim: 'a screen may declare its own ready selector',
    tier: 'gates',
    edits: [[HOST, 'data-ready={screen.ready}', 'data-ready={undefined}']],
  },
  {
    name: 'screens-allow-attr-dropped',
    claim: 'a screen may allowlist text the contrast gate cannot measure',
    tier: 'gates',
    edits: [
      [
        HOST,
        'data-contrast-allow={screen.contrastAllow === undefined',
        'data-contrast-allow={true || screen.contrastAllow === undefined',
      ],
    ],
  },
  {
    name: 'screens-host-console-error-dropped',
    claim: 'a screen that fails to load logs a console error',
    tier: 'gates',
    edits: [[HOST, 'if (!result.ok) console.error(result.error);', '']],
  },
  {
    name: 'screens-render-console-error-dropped',
    claim: 'a screen that throws while rendering logs a console error',
    tier: 'gates',
    edits: [
      [
        HOST,
        'console.error(`screen ${this.props.id}: failed to render',
        'void (`screen ${this.props.id}: failed to render',
      ],
    ],
  },
  {
    name: 'screens-boundary-dropped',
    claim: 'a screen that throws while rendering shows its error route instead of blanking the page',
    tier: 'gates',
    edits: [[HOST, 'return { error: error instanceof Error ? error.message : String(error) };', 'throw error;']],
  },
  {
    name: 'gates-ready-wait-skipped',
    claim: 'a screen whose declared ready selector never appears is reported as not ready',
    tier: 'gates',
    edits: [[GATES, 'if (declared) {', 'if (false) {']],
  },
  {
    name: 'gates-default-ready-floor-only',
    claim: 'the default ready selector of a screen is its registry wrapper, not a floor element',
    tier: 'gates',
    edits: [[GATES, 'const root = `[data-screen="${screen}"]`;', "const root = '[data-testid=rev]';"]],
  },
  {
    name: 'gates-error-cause-lost',
    claim: 'a screen that fails to load is named with its cause in the gates lane',
    tier: 'gates',
    edits: [
      [
        GATES,
        "if (failure !== null) return (await failure.textContent())?.trim() || 'not ready';",
        "if (failure !== null) return 'not ready';",
      ],
    ],
  },
  {
    name: 'gates-not-ready-line-unnamed',
    claim: 'the not ready line names the screen: FAIL lane 11 <id>: <cause>',
    edits: [[GATES, '`FAIL lane 11 ${one.screen}: ${one.notReady}`', '`FAIL lane 11: ${one.notReady}`']],
  },
  {
    name: 'gates-contrast-unmeasured-passes',
    claim: 'text over a gradient or image that cannot be measured fails',
    edits: [[GATES, 'if (row.unknown && unmeasured) {', 'if (false && unmeasured) {']],
  },
  {
    name: 'gates-contrast-allowlist-ignored',
    claim: 'an allowlist entry with a reason excuses unmeasurable text, and nothing else does',
    edits: [[GATES, 'if (row.unknown && unmeasured && row.allowed) {', 'if (false) {']],
  },
  {
    name: 'gates-contrast-allowlist-no-reason',
    claim: 'an allowlist entry without a reason excuses nothing',
    tier: 'gates',
    edits: [
      [GATES, "typeof entry.reason === 'string' && entry.reason.trim() !== ''", "typeof entry.reason === 'string'"],
    ],
  },
  {
    name: 'gates-contrast-best-pixel',
    claim: 'text over a gradient is judged by its worst pixel',
    edits: [[GATES, 'behindRatio = (row, pixels) =>\n  Math.min(', 'behindRatio = (row, pixels) =>\n  Math.max(']],
  },
  {
    name: 'gates-contrast-behind-not-measured',
    claim: 'text over a gradient is measured from the pixels behind it',
    tier: 'gates',
    edits: [[GATES, 'if (todo.length === 0) return;', 'return;']],
  },
  {
    name: 'gates-contrast-text-not-hidden',
    claim: 'the pixels behind text are sampled with the text itself hidden',
    tier: 'gates',
    edits: [[GATES, 'color:transparent!important;-webkit-text-fill-color:transparent!important;', '']],
  },
  {
    name: 'gates-contrast-clip-not-flagged',
    claim: 'text clipped to its own background is not measurable',
    tier: 'gates',
    edits: [[GATES, 'if (clipsToText) clipped = true;', '']],
  },
  {
    name: 'gates-contrast-opacity-ignored',
    claim: 'ancestor opacity counts in the contrast calculation',
    tier: 'gates',
    edits: [[GATES, 'opacity *= Number(cs.opacity);', 'opacity *= 1;']],
  },
  {
    name: 'gates-axe-serious-dropped',
    claim: 'the axe gate fails on serious findings, not only critical ones',
    tier: 'gates',
    edits: [[HARNESS, "rule.impact === 'serious' || ", '']],
  },
  {
    name: 'gates-raw-key-aria-label-blind',
    claim: 'a raw key in an aria-label is caught',
    tier: 'gates',
    edits: [[GATES, "el.getAttribute('aria-label') ?? ''", "''"]],
  },
  {
    name: 'gates-raw-key-title-blind',
    claim: 'a raw key in a title is caught',
    tier: 'gates',
    edits: [[GATES, "el.getAttribute('title') ?? ''", "''"]],
  },
  {
    name: 'gates-raw-key-placeholder-blind',
    claim: 'a raw key in a placeholder is caught',
    tier: 'gates',
    edits: [[GATES, "el.getAttribute('placeholder') ?? ''", "''"]],
  },
  {
    name: 'gates-motion-scripted-ignored',
    claim: 'the reduced-motion gate reports an element a script moves',
    edits: [[GATES, '...scripted.map(', '...scripted.slice(1e9).map(']],
  },
  {
    name: 'gates-motion-frames-not-compared',
    claim: 'the reduced-motion gate samples transforms across frames',
    tier: 'gates',
    edits: [[GATES, 'values.size > 1', 'values.size > 1e9']],
  },
  {
    name: 'gates-port-fixed',
    claim: 'the gates port is whatever the OS says is free',
    edits: [[HARNESS, "server.listen(0, '127.0.0.1', () => {", "server.listen(7500, '127.0.0.1', () => {"]],
  },
  {
    name: 'gates-port-no-retry',
    claim: 'a start that loses its port is retried on another',
    edits: [[HARNESS, 'attempt < tries;', 'attempt < 1;']],
  },
  {
    name: 'gates-hq-exit-unnoticed',
    claim: 'a start whose HQ process has exited fails at once',
    edits: [
      [
        HARNESS,
        'const gone = () => child.exitCode !== null || child.signalCode !== null;',
        'const gone = () => false;',
      ],
    ],
  },
  {
    name: 'gates-contrast-opacity-self-only',
    claim: 'opacity on an ancestor of the text counts, not only on the text element',
    tier: 'gates',
    edits: [[GATES, 'opacity *= Number(cs.opacity);', 'if (up === el) opacity *= Number(cs.opacity);']],
  },
  {
    name: 'gates-contrast-sample-one-pixel',
    claim: 'the pixel sampler reads the whole rectangle behind the text, not one pixel of it',
    tier: 'gates',
    edits: [
      [GATES, 'const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 3000)));', 'const step = Math.max(w, h);'],
    ],
  },
  {
    name: 'gates-motion-main-only',
    claim: 'the reduced-motion gate runs on every registered screen, not only the floor',
    tier: 'gates',
    edits: [
      [
        GATES,
        'problems.push(...(await checkMotion(page, `${screen}/reduced-motion`)).problems);',
        "if (screen === 'main') problems.push(...(await checkMotion(page, `${screen}/reduced-motion`)).problems);",
      ],
    ],
  },
  {
    name: 'gates-contrast-allowlist-excuses-measured',
    claim: 'an allowlist entry excuses only text the sampler could not measure',
    tier: 'gates',
    edits: [[GATES, 'if (row.unknown && unmeasured && row.allowed) {', 'if (row.unknown && row.allowed) {']],
  },
  {
    name: 'gates-contrast-broad-allow-honoured',
    claim: 'a broad allowlist selector excuses nothing',
    tier: 'gates',
    edits: [[GATES, "for (const row of rows) if (broad.refused.includes(row.allowedBy)) row.allowed = '';", '']],
  },
  {
    name: 'gates-contrast-broad-allow-not-named',
    claim: 'a broad allowlist selector is refused with a named failure',
    tier: 'gates',
    edits: [
      [GATES, "      : roots\n        ? 'matches the whole page'", "      : false\n        ? 'matches the whole page'"],
    ],
  },
  {
    name: 'gates-contrast-broad-row-limit',
    claim: 'a selector that covers more than 3 text rows is refused',
    edits: [[GATES, 'export const BROAD_ROW_LIMIT = 3;', 'export const BROAD_ROW_LIMIT = 1e9;']],
  },
  {
    name: 'gates-contrast-rounded',
    claim: 'the contrast bar is applied to the unrounded ratio',
    tier: 'gates',
    edits: [
      [
        GATES,
        ': exactRatio(row);\n    if (ratio >= MIN_CONTRAST) continue;',
        ': rowRatio(row);\n    if (ratio >= MIN_CONTRAST) continue;',
      ],
    ],
  },
  {
    name: 'gates-motion-margin-unwatched',
    claim: 'the reduced-motion gate watches margin-left',
    tier: 'gates',
    edits: [[GATES, "  'margin-left',\n", '']],
  },
  {
    name: 'gates-motion-svg-attr-unwatched',
    claim: 'the reduced-motion gate watches the transform attribute of SVG elements',
    tier: 'gates',
    edits: [
      [
        GATES,
        "const inSvg = el.closest('svg') !== null;",
        "if (el.closest('svg') !== null) continue;\n      const inSvg = false;",
      ],
    ],
  },
  {
    name: 'gates-fixtures-listed-as-screens',
    claim: 'the synthetic zz-gate-* screens are not registered screens unless lane 11b sets its flag',
    edits: [[GATES, '(synthetic || !id.startsWith(FIXTURE_PREFIX))', 'true']],
  },
  {
    name: 'gates-contrast-rows-not-counted',
    claim: 'an allowlist selector that covers more than 3 text rows is refused',
    tier: 'gates',
    edits: [[GATES, 'entry.rows += 1;', 'entry.rows += 0;']],
  },
  {
    name: 'gates-contrast-opaque-fill-clipped',
    claim: 'text with an opaque fill over a background clipped to its glyphs is measured, not unmeasurable',
    tier: 'gates',
    edits: [[GATES, 'if (clipsToText && opaqueFill) continue;', '']],
  },
  {
    name: 'gates-contrast-root-check-blind',
    claim: 'an allowlist selector that contains a page root is refused even on a page with few rows',
    tier: 'gates',
    edits: [
      [GATES, 'pageRoots.some((root) => el.contains(root))', 'pageRoots.some((root) => false && el.contains(root))'],
    ],
  },
  {
    name: 'gates-contrast-half-fill-unclipped',
    claim: 'text with a half-transparent fill over a clipped background is not treated as opaque',
    tier: 'gates',
    edits: [[GATES, '(fg[3] ?? 255) === 255;', '(fg[3] ?? 255) > 0;']],
  },
  {
    name: 'gates-contrast-offscreen-gives-up',
    claim: 'text rects are clipped to the viewport, text partly outside it is still measured',
    tier: 'gates',
    edits: [
      [
        GATES,
        'return visible.length === 0 ? null : visible;',
        'return visible.length === rects.length ? visible : null;',
      ],
    ],
  },
  {
    name: 'gates-contrast-stacked-layers-cut',
    claim: 'stacked translucent backgrounds are all composited',
    tier: 'gates',
    edits: [
      [
        GATES,
        'if (unknown || layers.some((layer) => layer[3] === 255)) continue;',
        'if (unknown || layers.some((layer) => layer[3] > 0)) continue;',
      ],
      [
        GATES,
        'if (!layers.some((layer) => layer[3] === 255)) layers.push([255, 255, 255, 255]);',
        'layers.push([255, 255, 255, 255]);',
      ],
    ],
  },
  {
    name: 'gates-motion-css-animations-only',
    claim: 'a running CSS transition fails the reduced-motion gate',
    tier: 'gates',
    edits: [[GATES, "a.playState === 'running'", "a.playState === 'running' && !(a instanceof CSSTransition)"]],
  },
  {
    name: 'gates-motion-no-script-animations',
    claim: 'an el.animate() loop fails the reduced-motion gate',
    tier: 'gates',
    edits: [
      [
        GATES,
        "a.playState === 'running'",
        "a.playState === 'running' && (a instanceof CSSAnimation || a instanceof CSSTransition)",
      ],
    ],
  },
  {
    name: 'gates-hq-joins-live-late',
    claim: 'an HQ is stopped on a signal even while it is still starting',
    edits: [
      [HARNESS, '  live.add(stop);\n  const url', '  const url'],
      [HARNESS, '  return {\n    url,', '  live.add(stop);\n  return {\n    url,'],
    ],
  },
  {
    name: 'gates-hq-start-not-refused',
    claim: 'no HQ starts once the run is stopping',
    edits: [[HARNESS, "if (halted) throw new Error('HQ start refused", "if (false) throw new Error('HQ start refused"]],
  },
  {
    name: 'gates-hq-exit-orphan',
    claim: 'HQ children are killed when the process exits without cleaning up',
    edits: [[HARNESS, "for (const child of children) child.kill('SIGKILL');", 'for (const child of children) child;']],
  },
  {
    name: 'gates-hq-exit-homes-left',
    claim: 'the temp homes are removed when the process exits without cleaning up',
    edits: [[HARNESS, 'for (const home of homes) {', 'for (const home of []) {']],
  },
  {
    name: 'gates-interrupt-second-ignored',
    claim: 'a second signal exits at once',
    edits: [[HARNESS, '        exit(code);\n        return;', '        return;']],
  },
  {
    name: 'gates-interrupt-cleanup-unbounded',
    claim: 'a cleanup that hangs is abandoned after its limit',
    edits: [[HARNESS, 'Promise.race([cleanup().catch(() => {}), limit])', 'cleanup().catch(() => {})']],
  },
  {
    name: 'gates-browser-close-unbounded',
    claim: 'browser.close has a timeout',
    edits: [
      [HARNESS, 'Promise.race([work, new Promise((resolve) => setTimeout(resolve, ms, undefined).unref())])', 'work'],
    ],
  },
  {
    name: 'gates-fixture-tracked-unseen',
    claim: 'a tracked file under the zz-gate- prefix fails the unit tests',
    edits: [[HARNESS, 'files.filter((file) => file.includes(FIXTURE_PREFIX))', 'files.filter(() => false)']],
  },
  {
    name: 'gates-interrupt-no-handler',
    claim: 'an interrupted gates run cleans up (SIGINT handler)',
    tier: 'interrupt',
    edits: [[GATES, "process.on('SIGINT', interrupt.on(130));", '']],
  },
  {
    name: 'gates-interrupt-hq-left',
    claim: 'the cleanup of an interrupted gates run stops the HQs, before the browser and the tree',
    edits: [[HARNESS, '      await stopHqs();\n', '']],
  },
  {
    name: 'gates-interrupt-no-restore',
    claim: 'an interrupted gates run removes the synthetic screens and rebuilds src/dist',
    tier: 'interrupt',
    edits: [[GATES, 'restore: restoreScreens }', 'restore: () => {} }']],
  },
  {
    name: 'gates-compare-skip-silent',
    claim: 'the compare verdict says when the entry negative tests were skipped',
    edits: [['src/e2e/canvas-compare.mjs', 'entryRuns === 0', 'entryRuns === -1']],
  },
  {
    name: 'i18n-dynamic-key-unlisted',
    claim: 'a t() call with a built key must list its keys',
    edits: [[APP, '{/* i18n-keys: floor.mood.working', '{/* keys: floor.mood.working']],
  },
  {
    name: 'i18n-dynamic-key-missing-th',
    claim: 'a listed dynamic key missing from a language is caught',
    edits: [[DRAWER, 'floor.settings.title', 'floor.settings.heading']],
  },
  {
    name: 'i18n-concatenated-key',
    claim: 'a key built by concatenation is a dynamic key that must be listed',
    edits: [[APP, "t('floor.hud.close')", "t('floor.hud.' + 'close')"]],
  },
  {
    name: 'i18n-scan-templates-static',
    claim: 'the key scan treats a template with ${} as a dynamic key',
    edits: [[PARITY, "!(quote === '`' && text.includes('${'))", 'true']],
  },
  {
    name: 'preflight-start-on-fail',
    claim: 'a FAIL disables START',
    edits: [[PF_MODEL, "run.phase === 'done' && run.report.canStart", "run.phase === 'done'"]],
  },
  {
    name: 'preflight-start-while-checking',
    claim: 'a report that is being replaced cannot start',
    edits: [[PF_MODEL, "run.phase === 'done' && run.report.canStart", 'reportOf(run)?.canStart === true']],
  },
  {
    name: 'preflight-warned-reads-ready',
    claim: 'a warned machine is named as warned',
    edits: [[PF_MODEL, "? 'warned' : 'ready'", "? 'ready' : 'ready'"]],
  },
  {
    name: 'preflight-no-fix-on-warn',
    claim: 'a WARN shows its fix',
    edits: [[PF_MODEL, "check.status === 'FAIL' || check.status === 'WARN'", "check.status === 'FAIL'"]],
  },
  {
    name: 'preflight-http-error-read',
    claim: 'an HTTP error is not a report',
    edits: [[PF_MODEL, 'if (!res.ok) throw new Error(`HTTP ${res.status}`);', '']],
  },
  {
    name: 'preflight-start-always-enabled',
    claim: 'the START button follows the rule',
    tier: 'preflight',
    edits: [[PF_SCREEN, 'disabled={!mayStart(run)}', 'disabled={false}']],
  },
  {
    name: 'preflight-start-without-recheck',
    claim: 'START checks again before it leaves',
    tier: 'preflight',
    edits: [
      [
        PF_SCREEN,
        "if (ended !== null && mayStart(ended)) location.hash = '';",
        "if (ended !== null) location.hash = '';",
      ],
    ],
  },
  {
    name: 'preflight-fix-hidden',
    claim: 'a FAIL row shows its fix',
    tier: 'preflight',
    edits: [[PF_SCREEN, 'needsFix(check) && check.fix !== null', 'needsFix(check) && check.fix === null']],
  },
  {
    name: 'preflight-check-again-dead',
    claim: 'Check again runs the checks',
    tier: 'preflight',
    edits: [[PF_SCREEN, 'disabled={busy} onClick={again}>', 'disabled={busy} onClick={() => {}}>']],
  },
  {
    name: 'preflight-serve-without-checks',
    claim: 'a served HQ answers the preflight screen',
    tier: 'preflight',
    edits: [[CLI, '      preflight: hqPreflight(env, home),\n      ...(mode', '      ...(mode']],
  },
  {
    name: 'preflight-chip-dropped',
    claim: 'the floor shows the run-mode chip',
    tier: 'e2e',
    edits: [[APP, '{hq.snapshot.host ? <ModeChip', '{false && hq.snapshot.host ? <ModeChip']],
  },
  {
    name: 'prs-merge-button',
    claim: 'the QC gate screen has no merge control',
    edits: [
      [
        'src/screens/prs/view.tsx',
        '      <p className="prs-never">',
        '      <button type="button" className="btn">\n        Merge\n      </button>\n      <p className="prs-never">',
      ],
    ],
  },
  {
    name: 'prs-merge-link',
    claim: 'no link of the screen merges',
    edits: [
      [
        'src/screens/prs/view.tsx',
        'href={fromHost.url} target="_blank"',
        'href={`${fromHost.url}/merge`} target="_blank"',
      ],
    ],
  },
  {
    name: 'prs-merge-wording-always',
    claim: 'only a READY PR invites a merge',
    edits: [
      [
        'src/screens/prs/view.tsx',
        "row.stamp === 'READY' ? t('prs.openToMerge', { host: name }) : t('prs.open', { host: name })",
        "t('prs.openToMerge', { host: name })",
      ],
    ],
  },
  {
    name: 'prs-brief-link-too-early',
    claim: 'no brief link before a brief can exist',
    edits: [['src/screens/prs/view.tsx', "  CHANGES: 'prs.brief.changes',", '  CHANGES: null,']],
  },
  {
    name: 'prs-brief-link-loses-task',
    claim: 'the brief link names the task',
    edits: [['src/screens/prs/model.ts', "  query.set('task', task);\n", '']],
  },
  {
    name: 'prs-no-factory-is-error',
    claim: 'an HQ with no factory says so',
    edits: [['src/screens/prs/model.ts', "    if (res.status === 404) return { phase: 'none' };\n", '']],
  },
  {
    name: 'prs-ready-before-detail',
    claim: 'the screen is done only once the picked PR is read',
    edits: [
      [
        'src/screens/prs/view.tsx',
        "(list.phase !== 'rows' || list.rows.length === 0 || detail.phase !== 'loading')",
        'true',
      ],
    ],
  },
  {
    name: 'prs-unread-hidden',
    claim: 'a host that does not answer is named',
    edits: [['src/screens/prs/view.tsx', '<code>{fromHost.reason}</code>', '']],
  },
  {
    name: 'prs-merge-button-outside-board',
    claim: 'the browser check sees a merge control wherever the screen draws it',
    tier: 'prs',
    edits: [
      [
        'src/screens/prs/screen.tsx',
        '  return <Board list={list} detail={detail} selected={selected} onSelect={setPicked} search={location.search} />;',
        '  return (\n    <>\n      <Board list={list} detail={detail} selected={selected} onSelect={setPicked} search={location.search} />\n      <button type="button">Merge</button>\n    </>\n  );',
      ],
    ],
  },
  {
    name: 'prs-screen-writes',
    claim: 'the screen only reads',
    tier: 'prs',
    edits: [
      [
        'src/screens/prs/model.ts',
        "const res = await ask(`/api/changes/${number}`, { cache: 'no-store' });",
        "await ask('/api/changes', { method: 'POST' });\n    const res = await ask(`/api/changes/${number}`, { cache: 'no-store' });",
      ],
    ],
  },
  {
    name: 'prs-no-live-update',
    claim: 'CHANGES turns READY without a reload',
    tier: 'prs',
    edits: [['src/screens/prs/screen.tsx', '  }, [id, push]);', '  }, [id]);']],
  },
  {
    name: 'prs-not-wired-in-lane-ready',
    claim: 'a PR row can be picked and the detail follows',
    tier: 'prs',
    edits: [
      [
        'src/screens/prs/screen.tsx',
        '  const selected = rows.some((row) => row.number === picked) ? picked : (rows[0]?.number ?? null);',
        '  const selected = null as number | null;',
      ],
    ],
  },
  {
    name: 'brief-merge-button',
    claim: 'the page has no merge control',
    edits: [
      [
        'src/screens/merge-brief/view.tsx',
        '      <p className="mb-never">',
        '      <button type="button" className="btn">\n        Merge\n      </button>\n      <p className="mb-never">',
      ],
    ],
  },
  {
    name: 'brief-merge-link',
    claim: 'no link of the page merges',
    edits: [
      [
        'src/screens/merge-brief/view.tsx',
        'href={brief.url} target="_blank"',
        'href={`${brief.url}/merge`} target="_blank"',
      ],
    ],
  },
  {
    name: 'brief-reason-dropped',
    claim: 'missing evidence gives its reason',
    edits: [['src/screens/merge-brief/view.tsx', '<span lang="en">{reason}</span>', '']],
  },
  {
    name: 'brief-tick-count',
    claim: 'the link counts what is ticked',
    edits: [
      [
        'src/screens/merge-brief/view.tsx',
        'const done = items.filter((item) => ticked.has(item.id)).length;',
        'const done = 0;',
      ],
    ],
  },
  {
    name: 'brief-merged-invites-merge',
    claim: 'a merged PR invites no merge',
    edits: [
      [
        'src/screens/merge-brief/view.tsx',
        "brief.phase === 'merged'\n      ? t(",
        "brief.phase === 'never'\n      ? t(",
      ],
    ],
  },
  {
    name: 'brief-named-steps-hidden',
    claim: 'a named step gets its own line',
    edits: [['src/screens/merge-brief/model.ts', "brief.beforeMerge.state === 'collected'\n    ?", 'false\n    ?']],
  },
  {
    name: 'brief-old-answer-wins',
    claim: 'an older answer never replaces a newer one',
    edits: [['src/screens/merge-brief/model.ts', '    if (mine < shown) return;\n', '']],
  },
  {
    name: 'brief-busy-page-empty',
    claim: 'an answer is shown while a newer read is out',
    edits: [['src/screens/merge-brief/model.ts', 'if (mine < shown) return;', 'if (mine < asked) return;']],
  },
  {
    name: 'brief-no-factory-is-error',
    claim: 'an HQ with no factory says so',
    edits: [['src/screens/merge-brief/model.ts', "    if (res.status === 404) return { phase: 'none' };\n", '']],
  },
  {
    name: 'brief-task-unencoded',
    claim: 'the task id is one path segment',
    edits: [['src/screens/merge-brief/model.ts', '${encodeURIComponent(task)}', '${task}']],
  },
  {
    name: 'brief-link-click-posts',
    claim: 'no click handler on a link writes',
    tier: 'brief',
    edits: [
      [
        'src/screens/merge-brief/view.tsx',
        'data-testid="mb-open">',
        "data-testid=\"mb-open\" onClick={() => void fetch('/api/tickets', { method: 'POST', body: '{}' })}>",
      ],
    ],
  },
  {
    name: 'brief-no-live-update',
    claim: 'an open page turns into the brief by itself',
    tier: 'brief',
    edits: [['src/screens/merge-brief/screen.tsx', '  }, [read, push]);', '  }, [read]);']],
  },
  {
    name: 'brief-no-action-link',
    claim: 'the ready action item opens the brief',
    tier: 'brief',
    edits: [
      [
        'src/floor/Drawer.tsx',
        "action.kind === 'ready_to_merge' && action.task !== null",
        'false && action.task !== null',
      ],
    ],
  },
  {
    name: 'brief-button-outside-board',
    claim: 'the browser check sees a merge control wherever the screen draws it',
    tier: 'brief',
    edits: [
      [
        'src/screens/merge-brief/screen.tsx',
        '  return <Board page={page} ticked={ticked} onTick={onTick} search={location.search} />;',
        '  return (\n    <>\n      <Board page={page} ticked={ticked} onTick={onTick} search={location.search} />\n      <button type="button">Merge</button>\n    </>\n  );',
      ],
    ],
  },
];

const only = process.argv.slice(2);
const windows = process.platform === 'win32';

/** @param {string} command @param {string[]} args @param {number} timeout @param {NodeJS.ProcessEnv} [env] */
const run = (command, args, timeout, env = process.env) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      detached: !windows,
      shell: windows,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => (stdout += chunk));
    const sweep = () => {
      try {
        process.kill(windows ? child.pid : -child.pid, 'SIGKILL');
      } catch {}
    };
    const timer = setTimeout(sweep, timeout);
    child.on('close', (status) => {
      clearTimeout(timer);
      sweep();
      resolve({ status, stdout });
    });
  });

const build = () => run('pnpm', ['--filter', '@agent-works/floor', 'build'], 120_000);
const lanes = async () => {
  const built = await build();
  if (built.status !== 0) return 'build failed';
  const out = join(process.env.TMPDIR ?? '/tmp', 'mutant-lanes');
  const result = await run('node', ['src/e2e/lanes.mjs'], 300_000, { ...process.env, OUT: out });
  return result.status === 0 ? null : (result.stdout.match(/FAIL lane [\d.]+/g) ?? ['lanes crashed']).join(', ');
};
const lane9 = async () => {
  const result = await run('node', ['src/e2e/lane9.mjs'], 200_000, {
    ...process.env,
    OUT: join(process.env.TMPDIR ?? '/tmp', 'mutant-lane9'),
  });
  return result.status === 0 ? null : (result.stdout.match(/FAIL lane 9[^\n]{0,160}/) ?? ['lane 9 crashed'])[0];
};
const preflight = async () => {
  const built = await build();
  if (built.status !== 0) return 'build failed';
  const result = await run('node', ['src/e2e/preflight.mjs'], 300_000, {
    ...process.env,
    OUT: join(process.env.TMPDIR ?? '/tmp', 'mutant-preflight'),
  });
  return result.status === 0
    ? null
    : (result.stdout.match(/FAIL preflight[^\n]{0,160}/) ?? ['preflight lane crashed'])[0];
};
const prs = async () => {
  const built = await build();
  if (built.status !== 0) return 'build failed';
  const result = await run('node', ['src/e2e/prs.mjs'], 300_000, {
    ...process.env,
    OUT: join(process.env.TMPDIR ?? '/tmp', 'mutant-prs'),
  });
  // The artboard compare has its own line, so only the lane's verdict counts.
  if (result.stdout.includes('PASS prs lane')) return null;
  return (result.stdout.match(/FAIL prs lane[^\n]{0,160}/) ?? ['prs lane crashed'])[0];
};
const brief = async () => {
  const built = await build();
  if (built.status !== 0) return 'build failed';
  const result = await run('node', ['src/e2e/merge-brief.mjs'], 300_000, {
    ...process.env,
    OUT: join(process.env.TMPDIR ?? '/tmp', 'mutant-brief'),
  });
  if (result.stdout.includes('PASS merge brief lane')) return null;
  return (result.stdout.match(/FAIL merge brief lane[^\n]{0,160}/) ?? ['merge brief lane crashed'])[0];
};
const gates = async () => {
  const result = await run('node', ['src/e2e/gates.mjs'], 300_000, {
    ...process.env,
    OUT: join(process.env.TMPDIR ?? '/tmp', 'mutant-gates'),
  });
  return result.status === 0 ? null : (result.stdout.match(/FAIL lane 11[^\n]{0,160}/) ?? ['gates crashed'])[0];
};
const interrupt = async () => {
  const result = await run('node', ['src/e2e/interrupt.mjs'], 900_000, process.env);
  return result.status === 0
    ? null
    : (result.stdout.match(/FAIL interrupt[^\n]{0,160}/) ?? ['interrupt check crashed'])[0];
};
const vitest = () => run('pnpm', ['vitest', 'run', ...SUITE], 300_000);

/** Everything this runner starts inherits this variable, so an orphan it left behind can be told from a process of someone else. */
const MARKER = 'AW_MUTANT_RUN';
const token = `${process.pid}-${Date.now()}`;
process.env[MARKER] = token;
/** HQ processes that carry this run's marker: only ones this runner started, never anyone else's. */
const ownHq = () => {
  const found = spawnSync('pgrep', ['-f', 'bin/agent-works.ts'], { encoding: 'utf8' });
  if (found.status !== 0) return [];
  return found.stdout
    .split('\n')
    .filter(Boolean)
    .filter((pid) => {
      const env = spawnSync('ps', ['eww', '-o', 'command=', '-p', pid], { encoding: 'utf8' });
      return env.status === 0 && env.stdout.includes(`${MARKER}=${token}`);
    });
};
/** @type {string[]} */
const orphans = [];
const sweepOrphans = () => {
  if (windows) return;
  for (const pid of ownHq()) {
    orphans.push(pid);
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {}
  }
};

/** @type {string[]} */
const lines = [];
/** @param {string} line */
const log = (line) => {
  console.log(line);
  lines.push(line);
};

const baseline = await vitest();
log(`baseline ${baseline.status === 0 ? 'PASS' : 'FAIL'}`);
if (baseline.status !== 0) {
  console.error(baseline.stdout.slice(-2000));
  process.exit(1);
}

let bad = 0;
let ran = 0;
for (const mutant of MUTANTS) {
  if (only.length > 0 && !only.includes(mutant.name)) continue;
  ran += 1;
  /** @type {Map<string, Buffer | null>} */
  const originals = new Map();
  try {
    for (const [file, find, replace] of mutant.edits) {
      const path = join(ROOT, file);
      const current = readFileSync(path);
      originals.set(path, originals.get(path) ?? current);
      const text = current.toString('utf8');
      if (!text.includes(find)) throw new Error(`${mutant.name}: pattern not found in ${file}`);
      writeFileSync(
        path,
        text.replace(find, () => replace),
      );
    }
    for (const [to, from] of mutant.copies ?? []) {
      const path = join(ROOT, to);
      originals.set(path, originals.get(path) ?? (existsSync(path) ? readFileSync(path) : null));
      mkdirSync(dirname(path), { recursive: true });
      copyFileSync(join(ROOT, from), path);
    }
    let how = null;
    if (mutant.tier === 'lane9') how = await lane9();
    else if (mutant.tier === 'interrupt') how = (await vitest()).status !== 0 ? 'unit tests' : await interrupt();
    else if (mutant.tier === 'gates') {
      if (mutant.edits.some(([file]) => file.endsWith('.css'))) await build();
      how = (await vitest()).status !== 0 ? 'unit tests' : await gates();
    } else {
      how = (await vitest()).status !== 0 ? 'unit tests' : null;
      if (how === null && mutant.tier === 'e2e') how = await lanes();
      if (how === null && mutant.tier === 'preflight') how = await preflight();
      if (how === null && mutant.tier === 'prs') how = await prs();
      if (how === null && mutant.tier === 'brief') how = await brief();
    }
    if (how === null) bad += 1;
    log(
      `${how === null ? 'BAD ' : 'OK  '} ${mutant.name}: ${how === null ? 'survived' : `caught by ${how}`}. Claim: ${mutant.claim}`,
    );
  } finally {
    sweepOrphans();
    for (const [path, bytes] of originals) {
      if (bytes === null) {
        rmSync(path, { force: true });
        try {
          rmdirSync(dirname(path));
        } catch {}
      } else writeFileSync(path, bytes);
    }
    if (
      ['e2e', 'preflight', 'prs', 'brief'].includes(mutant.tier ?? '') ||
      mutant.edits.some(([file]) => file.endsWith('.css'))
    )
      await build();
  }
}
/** Orphans are cleaned up and reported on their own line: a mutant that breaks the kill code leaves them, which is not a survivor. */
sweepOrphans();
log(`${ran} mutants, ${bad} survived`);
log(
  `${orphans.length} orphan HQ processes started by this run were killed${orphans.length > 0 ? ` (${orphans.join(' ')})` : ''}`,
);
const result = process.env.MUTANT_OUT ?? '/tmp/swarm-P1-3/owner/mutants-p1-3.txt';
mkdirSync(dirname(result), { recursive: true });
writeFileSync(result, `${lines.join('\n')}\n`);
process.exit(bad === 0 ? 0 : 1);
