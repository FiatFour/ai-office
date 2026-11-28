import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { briefControlProblems } from '../e2e/merge-brief.mjs';
import { i18n, initI18n } from '../floor/i18n.ts';
import {
  type Brief,
  checklistOf,
  checksUrl,
  fetchBrief,
  newestOnly,
  type Page,
  taskOf,
} from '../screens/merge-brief/model.ts';
import { Board } from '../screens/merge-brief/view.tsx';

const URL_ON_HOST = 'https://github.com/acme/app/pull/1';
const missing = (reason: string) => ({ state: 'not_collected', reason }) as const;

const BRIEF: Brief = {
  phase: 'ready',
  task: 'alpha/t2',
  number: 1,
  repo: 'acme/app',
  host: 'github',
  branch: 'aw/alpha/t2',
  base: 'main',
  head: 'a1b2c3d4e5',
  title: 'A note',
  url: URL_ON_HOST,
  readAt: 0,
  risk: null,
  summary: '<button>merge</button>',
  workOrderUrl: null,
  files: missing('the host did not list the files'),
  checks: [{ name: 'ci' }, { name: 'ci' }],
  approvals: { required: 1, by: ['vega'] },
  rounds: 1,
  changesAsked: 0,
  headComments: 0,
  timeline: [{ at: 0, round: 1, head: 'a1b2c3d4e5', reviewer: 'vega', verdict: 'approve', notes: ['fine'] }],
  reviewGap: null,
  beforeMerge: missing('nobody named a step before merge'),
  howToCheck: missing('the work order names no manual check'),
  rootCause: null,
  evidence: {
    screenshots: missing('no screenshots were attached'),
    ci_runs: { state: 'collected', lines: ['`ci`: success'] },
    test_output: missing('no test output was attached'),
    logs: missing('no log source is set'),
  },
};

const read = (brief: Partial<Brief> = {}): Page => ({
  phase: 'read',
  answer: { state: 'brief', brief: { ...BRIEF, ...brief } },
});

const render = (page: Page, ticked: readonly string[] = []) =>
  renderToStaticMarkup(
    createElement(Board, { page, ticked: new Set(ticked), onTick: () => {}, search: '?lang=en&task=alpha%2Ft2' }),
  );

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => (m[1] ?? '').replaceAll('&amp;', '&'));

beforeAll(async () => {
  await initI18n('en');
  await i18n.changeLanguage('en');
});

describe('the merge brief page', () => {
  it('names each kind of missing evidence "not collected" with its reason', () => {
    const html = render(read());
    for (const reason of [
      'no screenshots were attached',
      'no test output was attached',
      'no log source is set',
      'the host did not list the files',
      'the work order names no manual check',
      'The work order sets no risk level.',
    ])
      expect(html).toContain(reason);
    expect(html).toMatch(/data-evidence="screenshots" data-state="not_collected"/);
    expect(html).toContain('RISK: not collected');
  });

  it('has checkboxes and links only, and escapes what came from outside', () => {
    const html = render(read({ workOrderUrl: 'https://example.invalid/work-orders/alpha-t2' }));
    expect(html).not.toContain('<button');
    expect(html).toContain('&lt;button&gt;');
    expect(html.match(/<input/g)).toHaveLength(3);
    expect(html.match(/<input type="checkbox"/g)).toHaveLength(3);
    expect(briefControlProblems({ buttons: [], forms: 0, links: hrefs(html) })).toEqual([]);
    expect(briefControlProblems({ buttons: ['Merge'], forms: 1, links: ['/api/merge'] })).toHaveLength(3);
  });

  it('counts the ticks on the link that leads to the host, and drops the count once merged', () => {
    expect(render(read())).toContain('Open on GitHub to merge (0/3 checked)');
    expect(render(read(), ['read', 'diff'])).toContain('Open on GitHub to merge (2/3 checked)');
    expect(render(read(), ['read', 'setup', 'diff'])).toContain('Open on GitHub to merge ✓');
    const merged = render(read({ phase: 'merged' }));
    expect(merged).toContain('>MERGED<');
    expect(merged).toContain('>Open on GitHub<');
    expect(merged).not.toContain('Open on GitHub to merge');
  });

  it('lists each step the work order named in place of the general one', () => {
    const named = { beforeMerge: { state: 'collected', lines: ['Add the key', 'Run the migration'] } } as const;
    expect(checklistOf({ ...BRIEF, ...named }).map((item) => item.id)).toEqual(['read', 'step-0', 'step-1', 'diff']);
    expect(render(read(named))).toContain('Run the migration');
  });

  it('shows no ready banner and no way to merge without a brief', () => {
    const pages: Page[] = [
      { phase: 'loading' },
      { phase: 'no-task' },
      { phase: 'none' },
      { phase: 'error', message: 'HTTP 500' },
      { phase: 'read', answer: { state: 'none', task: 'alpha/t2', why: 'checks', names: ['late'] } },
    ];
    for (const page of pages) {
      const html = render(page);
      expect(html).not.toContain('READY TO MERGE');
      expect(html).not.toContain('mb-open');
      expect(html).toContain(page.phase === 'loading' ? 'data-phase="loading"' : 'data-phase="done"');
    }
    expect(render(pages[4] as Page)).toContain('late');
  });

  it('reads the task from the query and asks HQ for it', async () => {
    expect(taskOf('?lang=en&task=alpha%2Ft2')).toBe('alpha/t2');
    expect(taskOf('?lang=en')).toBeNull();
    expect(taskOf('?task=')).toBeNull();
    const asked: string[] = [];
    const answering = (status: number, body: unknown) =>
      (async (url: string) => {
        asked.push(url);
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch;
    expect(await fetchBrief('alpha/t2', answering(200, { state: 'none' }))).toEqual({
      phase: 'read',
      answer: { state: 'none' },
    });
    expect(asked).toEqual(['/api/briefs/alpha%2Ft2']);
    expect(await fetchBrief('a/b', answering(404, {}))).toEqual({ phase: 'none' });
    expect(await fetchBrief('a/b', answering(500, {}))).toEqual({ phase: 'error', message: 'HTTP 500' });
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await fetchBrief('a/b', down)).toEqual({ phase: 'error', message: 'offline' });
  });

  it('never lets an older answer replace a newer one', async () => {
    const waiting: ((value: string) => void)[] = [];
    const shown: string[] = [];
    const reread = newestOnly(
      () => new Promise<string>((resolve) => waiting.push(resolve)),
      (value) => shown.push(value),
    );
    const first = reread();
    const second = reread();
    waiting[1]?.('no brief');
    await second;
    waiting[0]?.('ready');
    await first;
    expect(shown).toEqual(['no brief']);
    // An answer that arrives while a newer read is still out is shown, so a busy HQ cannot keep the page empty.
    const third = reread();
    void reread();
    waiting[2]?.('third');
    await third;
    expect(shown).toEqual(['no brief', 'third']);
  });

  it('links to the checks of a GitHub PR only', () => {
    expect(checksUrl(BRIEF)).toBe(`${URL_ON_HOST}/checks`);
    expect(checksUrl({ ...BRIEF, host: 'gitlab' })).toBe(URL_ON_HOST);
    expect(checksUrl({ ...BRIEF, url: null })).toBeNull();
  });
});
