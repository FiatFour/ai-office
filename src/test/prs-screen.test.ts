import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { mergeControlProblems } from '../e2e/prs.mjs';
import { i18n, initI18n } from '../floor/i18n.ts';
import {
  briefHref,
  type ChangeDetail,
  type ChangeStamp,
  type Detail,
  fetchDetail,
  fetchList,
  type List,
} from '../screens/prs/model.ts';
import { Board } from '../screens/prs/view.tsx';

const URL_ON_HOST = 'https://github.com/acme/app/pull/1';
const STAMPS: ChangeStamp[] = ['READY', 'CHANGES', 'AT QC', 'DRAFT', 'SHIPPED', 'SCRAPPED'];

const detailOf = (stamp: ChangeStamp): ChangeDetail => ({
  row: {
    number: 1,
    repo: 'acme/app',
    host: 'github',
    branch: 'aw/alpha/t2',
    base: 'main',
    task: 'alpha/t2',
    title: 'A note',
    worker: 'nova',
    head: 'a1b2c3d4',
    stamp,
  },
  approvals: [
    { by: 'peer', who: 'vega', state: 'approve' },
    { by: 'you', state: 'wait' },
  ],
  briefUrl: stamp === 'READY' ? `${URL_ON_HOST}#issuecomment-7` : null,
  fromHost: {
    state: 'read',
    url: URL_ON_HOST,
    checks: [{ name: 'ci', state: 'success' }],
    rounds: [
      {
        round: 1,
        head: 'a1b2c3d4',
        reviews: [
          {
            reviewer: 'vega',
            verdict: 'changes',
            body: '<button>merge</button>',
            comments: [{ path: 'a.ts', line: 2, body: 'why' }],
          },
        ],
      },
    ],
  },
});

const render = (detail: Detail, list: List = { phase: 'rows', rows: [detailOf('READY').row] }) =>
  renderToStaticMarkup(createElement(Board, { list, detail, selected: 1, onSelect: () => {}, search: '?lang=en' }));

/** The controls of a rendered page, in the shape the lane reads them from a browser. */
const controls = (html: string) => {
  const all = (pattern: RegExp) => [...html.matchAll(pattern)].map((m) => m[1] ?? '');
  return {
    buttons: all(/<button\b([^>]*)>/g).map((attrs) => /data-pr="(\d+)"/.exec(attrs)?.[1] ?? `button ${attrs}`),
    links: all(/<a\b[^>]*\bhref="([^"]*)"/g).map((href) => href.replaceAll('&amp;', '&')),
    inputs: all(/<(form|input|select|textarea)\b/g).length + all(/\b(role="button"|onclick=)/g).length,
  };
};

const open = (html: string) => /<a [^>]*data-testid="prs-open"[^>]*>([^<]*)<\/a>/.exec(html)?.[1];

beforeAll(async () => {
  await initI18n('en');
});

describe('the QC gate screen', () => {
  it.each(STAMPS)('has no merge control on a %s PR, only PR rows and links', (stamp) => {
    const html = render({ phase: 'read', detail: detailOf(stamp) });
    const found = controls(html);
    expect(found.buttons).toEqual(['1']);
    expect(mergeControlProblems(found as never)).toEqual([]);
    expect(found.links).toContain(URL_ON_HOST);
    expect(html).toContain('Agent Works never merges for you.');
    expect(html).toContain('&lt;button&gt;merge&lt;/button&gt;');
  });

  it('would catch a merge button, a form or a link to a merge endpoint', () => {
    const bad = controls(
      '<button class="btn">Merge</button><form></form><a href="https://github.com/acme/app/pull/1/merge">m</a>',
    );
    expect(mergeControlProblems(bad as never)).toHaveLength(3);
  });

  it('offers the host link to merge only on a READY PR', () => {
    for (const stamp of STAMPS)
      expect(open(render({ phase: 'read', detail: detailOf(stamp) }))).toBe(
        stamp === 'READY' ? 'Open on GitHub to merge' : 'Open on GitHub',
      );
  });

  it('links to the merge brief page only once a brief can exist', () => {
    for (const stamp of STAMPS) {
      const links = controls(render({ phase: 'read', detail: detailOf(stamp) })).links;
      expect(links.includes('?lang=en&task=alpha%2Ft2#/merge-brief')).toBe(stamp === 'READY' || stamp === 'SHIPPED');
    }
    expect(briefHref('', 'a/b')).toBe('?task=a%2Fb#/merge-brief');
    expect(briefHref('?lang=th&task=old', 'a/b')).toBe('?lang=th&task=a%2Fb#/merge-brief');
  });

  it('says why when the host did not answer, and shows no link it does not have', () => {
    const detail: ChangeDetail = { ...detailOf('AT QC'), fromHost: { state: 'unread', reason: 'HTTP 502' } };
    const html = render({ phase: 'read', detail });
    expect(html).toContain('GitHub did not answer');
    expect(html).toContain('HTTP 502');
    expect(open(html)).toBeUndefined();
    expect(html).toContain('vega (peer)');
  });

  it('is done loading only when the picked PR has been read', () => {
    expect(render({ phase: 'loading' })).toContain('data-phase="loading"');
    expect(render({ phase: 'loading' }, { phase: 'loading' })).toContain('data-phase="loading"');
    expect(render({ phase: 'error', message: 'HTTP 500' })).toContain('data-phase="done"');
    expect(render({ phase: 'loading' }, { phase: 'rows', rows: [] })).toContain('No pull requests yet.');
    expect(render({ phase: 'loading' }, { phase: 'none' })).toContain('This HQ runs no factory');
  });

  it('follows the language and keeps the stamp in English', async () => {
    await i18n.changeLanguage('th');
    const html = render({ phase: 'read', detail: detailOf('READY') });
    await i18n.changeLanguage('en');
    expect(html).toContain('เปิดใน GitHub เพื่อ merge');
    expect(html).toMatch(/data-stamp="READY">READY</);
  });

  it('tells an HQ with no factory from an HQ that fails', async () => {
    const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
    await expect(fetchList(answer(404, {}))).resolves.toEqual({ phase: 'none' });
    await expect(fetchList(answer(500, {}))).resolves.toEqual({ phase: 'error', message: 'HTTP 500' });
    await expect(fetchList(answer(200, { rows: [] }))).resolves.toEqual({ phase: 'rows', rows: [] });
    await expect(fetchDetail(1, answer(400, {}))).resolves.toEqual({ phase: 'error', message: 'HTTP 400' });
    await expect(
      fetchDetail(1, async () => {
        throw new Error('offline');
      }),
    ).resolves.toEqual({ phase: 'error', message: 'offline' });
  });
});
