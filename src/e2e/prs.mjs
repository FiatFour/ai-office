import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { artboardSpec, canvasCompare } from './canvas-compare.mjs';
import { screenGates } from './gates.mjs';
import { launch, OUT, ROOT, within } from './harness.mjs';

/**
 * A scripted review round on the QC gate screen: CHANGES, then READY without a reload, then SHIPPED after a person
 * merges on the host. All of it on a real HQ (server/test/fixtures/prs-hq.ts), because the CLI has no scripted runtime.
 * The invariant is checked where it can break: the controls on the page, the requests of the page, and the calls to the host.
 */

const TASK = 'alpha/t2';

export const PRS_SPEC = artboardSpec({ name: 'PRs', dir: join(ROOT, 'docs', 'review', 'P3-16'), minEntries: 8 });

export const startFactory = async () => {
  const home = mkdtempSync(join(tmpdir(), 'aw-prs-'));
  const log = join(home, 'api-calls.jsonl');
  const child = spawn(
    process.execPath,
    [join(ROOT, 'server', 'test', 'fixtures', 'prs-hq.ts'), home, join(ROOT, 'src', 'dist'), log],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  const kill = () => child.kill('SIGKILL');
  process.on('exit', kill);
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    const got = await within(lines.next(), 20_000);
    if (got === undefined || got.done) throw new Error('the factory HQ did not answer');
    return got.value;
  };
  const url = await next();
  const tell = async (/** @type {string} */ command) => {
    child.stdin.write(`${command}\n`);
    return /** @type {string[]} */ (JSON.parse(await next()));
  };
  return {
    url,
    tell,
    order: async (/** @type {string} */ id) => {
      const res = await fetch(`${url}/api/tickets`, { method: 'POST', body: JSON.stringify({ id }) });
      if (!res.ok) throw new Error(`order ${id}: HTTP ${res.status}`);
    },
    apiLog: () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => /** @type {{ method: string, path: string }} */ (JSON.parse(line))),
    until: async (/** @type {string} */ stamp) => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const { rows } = await (await fetch(`${url}/api/changes`)).json();
        if (rows[0]?.stamp === stamp) return;
        if (Date.now() > deadline) throw new Error(`no ${stamp} row, got ${JSON.stringify(rows)}`);
        await sleep(50);
      }
    },
    stop: async () => {
      child.stdin.end();
      await within(new Promise((resolve) => child.once('exit', resolve)), 5000);
      kill();
      process.off('exit', kill);
      rmSync(home, { recursive: true, force: true });
    },
  };
};

/** What the page shows for the picked PR, and every control on it. */
const shown = (/** @type {import('playwright').Page} */ page) =>
  page.evaluate(() => {
    const all = (/** @type {string} */ selector) => [...document.querySelectorAll(selector)];
    const text = (/** @type {Element} */ node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const open = document.querySelector('[data-testid="prs-open"]');
    return {
      stamp: text(document.querySelector('.prs-big') ?? document.body),
      approvals: all('[data-approval]').map((n) => `${n.getAttribute('data-by')}:${n.getAttribute('data-approval')}`),
      rounds: all('[data-round]').length,
      comments: all('.prs-comment').map(text),
      checks: all('[data-check]').map((n) => `${n.getAttribute('data-check')}:${n.getAttribute('data-state')}`),
      open: open === null ? null : { text: text(open), href: open.getAttribute('href') },
      brief: document.querySelector('[data-testid="prs-brief-link"]')?.getAttribute('href') ?? null,
      links: all('a[href]').map((n) => n.getAttribute('href') ?? ''),
      buttons: all('button, [role="button"], [onclick]').map((n) => n.getAttribute('data-pr') ?? text(n)),
      inputs: all('form, input, select, textarea').length,
    };
  });

/**
 * Every control that can act is a PR picker or a link to a page that a person reads. Returns what breaks that.
 * @param {Awaited<ReturnType<typeof shown>>} view
 */
export const mergeControlProblems = (view) => [
  ...view.buttons.filter((button) => !/^\d+$/.test(button)).map((button) => `a button other than a PR row: ${button}`),
  ...(view.inputs > 0 ? [`${view.inputs} form controls`] : []),
  ...view.links
    .filter(
      (href) =>
        href !== '#/' &&
        !/^https:\/\/github\.com\/acme\/app\/pull\/\d+(#issuecomment-\d+)?$/.test(href) &&
        !/^\?[^#]*task=[^#]*#\/merge-brief$/.test(href),
    )
    .map((href) => `a link to an unexpected place: ${href}`),
];

/** @param {import('playwright').Browser} browser */
export const runPrsLane = async (browser) => {
  /** @type {string[]} */
  const problems = [];
  const expect = (/** @type {boolean} */ holds, /** @type {string} */ what) => {
    if (!holds) problems.push(what);
  };
  mkdirSync(OUT, { recursive: true });
  const factory = await startFactory();
  /** @type {{ ok: boolean, note: string }} */
  let compare = { ok: false, note: 'not run' };
  try {
    await factory.order(TASK);
    await factory.until('CHANGES');
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    /** @type {string[]} */
    const requests = [];
    page.on('request', (request) => requests.push(`${request.method()} ${new URL(request.url()).pathname}`));
    const shot = (/** @type {string} */ name) =>
      page.screenshot({ path: join(OUT, `prs-${name}.png`), fullPage: true });
    const gates = async (/** @type {string} */ state) => {
      const verdict = await screenGates({ browser, url: factory.url, screen: 'prs' });
      expect(verdict.ok, `screen gates in the ${state} state: ${verdict.problems.join('; ')}`);
    };

    await page.goto(`${factory.url}/?lang=en#/prs`);
    await page.waitForSelector('.prs-big[data-stamp="CHANGES"]', { timeout: 20_000 });
    await page.waitForSelector('[data-round="1"]');
    const changes = await shown(page);
    expect(changes.stamp === 'CHANGES', `the stamp reads ${changes.stamp}`);
    expect(changes.approvals.join() === 'peer:changes,you:wait', `CHANGES approvals: ${changes.approvals}`);
    expect(changes.rounds === 1, `CHANGES shows ${changes.rounds} rounds`);
    expect(
      changes.comments.join() === 'docs/note.md:3Say "second draft".',
      `CHANGES comments: ${JSON.stringify(changes.comments)}`,
    );
    expect(changes.checks.join() === 'ci:success', `checks: ${changes.checks}`);
    expect(changes.open?.text === 'Open on GitHub', `before approval the link reads ${changes.open?.text}`);
    expect(changes.brief === null, 'a PR with changes requested links to a merge brief');
    problems.push(...mergeControlProblems(changes));
    await shot('changes');
    await gates('CHANGES');

    await factory.tell('release');
    await page.waitForSelector('.prs-big[data-stamp="READY"]', { timeout: 20_000 });
    await page.waitForSelector('[data-round="2"]');
    await page.waitForSelector('.prs-brief a[target="_blank"]');
    const ready = await shown(page);
    expect(ready.approvals.join() === 'peer:approve,you:wait', `READY approvals: ${ready.approvals}`);
    expect(ready.rounds === 2, `READY shows ${ready.rounds} rounds`);
    expect(
      ready.open?.text === 'Open on GitHub to merge' && ready.open.href === 'https://github.com/acme/app/pull/1',
      `the READY link is ${JSON.stringify(ready.open)}`,
    );
    expect(
      ready.brief === `?lang=en&task=${encodeURIComponent(TASK)}#/merge-brief`,
      `the brief link is ${ready.brief}`,
    );
    problems.push(...mergeControlProblems(ready));
    await shot('ready');
    await gates('READY');

    const writes = async () => (await factory.tell('calls')).filter((call) => !call.startsWith('GET '));
    const before = await writes();
    for (const button of await page.$$('.prs button')) await button.click();
    await page.keyboard.press('Enter');
    await sleep(500);
    expect((await writes()).join() === before.join(), 'pressing the controls of the screen made HQ write to the host');

    await page.goto(`${factory.url}/?lang=th#/prs`);
    await page.waitForSelector('.prs-big[data-stamp="READY"]');
    await shot('ready-th');

    await page.goto(`${factory.url}/?lang=en#/prs`);
    await page.waitForSelector('[data-round="2"]');
    await page.waitForSelector('.prs-brief a[target="_blank"]');
    await page.$$eval('.prs-round h4 code', (nodes) => {
      for (const node of nodes) node.textContent = 'commit';
    });
    compare = await canvasCompare(browser, page, { inventory: {}, text: '' }, PRS_SPEC);

    await factory.tell('merge 1');
    await page.waitForSelector('.prs-big[data-stamp="SHIPPED"]', { timeout: 20_000 });
    const shipped = await shown(page);
    expect(shipped.approvals.join() === 'peer:approve,you:approve', `SHIPPED approvals: ${shipped.approvals}`);
    problems.push(...mergeControlProblems(shipped));
    await shot('shipped');

    expect(
      requests.every((request) => request.startsWith('GET ')),
      `the screen sent ${requests.filter((request) => !request.startsWith('GET '))}`,
    );
    const calls = await factory.tell('calls');
    const logged = factory.apiLog().map(({ method, path }) => `${method} ${path}`);
    expect(
      logged.some((call) => call.startsWith('POST /repos/acme/app/pulls/1/reviews')),
      'the API call log holds no review, so it cannot show what HQ did',
    );
    const merges = [...calls, ...logged].filter((call) => /\/merges?(\?|\/|$)/.test(call));
    expect(merges.length === 0, `HQ called a merge endpoint: ${merges}`);
    await ctx.close();
  } finally {
    await factory.stop();
  }
  return {
    ok: problems.length === 0,
    compare,
    note:
      problems.length === 0
        ? `CHANGES with 1 round and its comment, then READY with 2 rounds without a reload, then SHIPPED after a person merged on the host. Controls are PR rows and links only, the page sent GET only, no merge call in the host log. Screenshots in ${OUT}`
        : problems.join('; '),
  };
};

if (import.meta.main) {
  const browser = await launch();
  try {
    const verdict = await runPrsLane(browser).catch((error) => ({
      ok: false,
      note: String(error.message ?? error).split('\n')[0],
      compare: { ok: false, note: 'not run' },
    }));
    console.log(`${verdict.ok ? 'PASS' : 'FAIL'} prs lane: ${verdict.note}`);
    console.log(`${verdict.compare.ok ? 'PASS' : 'FAIL'} prs artboard compare: ${verdict.compare.note}`);
    process.exitCode = verdict.ok && verdict.compare.ok ? 0 : 1;
  } finally {
    await browser.close();
  }
}
