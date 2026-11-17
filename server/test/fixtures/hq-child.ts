import { scripted } from '../../agents/scripted.ts';
import { github } from '../../githost/github.ts';
import type { HttpRequest } from '../../githost/host.ts';
import { startHq } from '../../hq.ts';
import { cagesMode } from '../../modes/cages.ts';

const [home = '', fakeUrl = ''] = process.argv.slice(2);
const transport = (account: string) => async (request: HttpRequest) => {
  const res = await fetch(fakeUrl, { method: 'POST', body: JSON.stringify({ account, request, pid: process.pid }) });
  return JSON.parse(await res.text());
};
const files = (round: number) => ['a.txt', 'b.txt', 'c.txt'].map((path) => ({ path, content: `${path[0]}${round}\n` }));
const agent = scripted({
  scripts: {
    'alpha/k1': {
      author: [{ files: files(1) }, { files: files(2) }],
      reviews: [
        { verdict: 'changes', body: 'Make every file say 2.', comments: [{ path: 'a.txt', line: 1, body: 'say 2' }] },
        { verdict: 'approve', body: 'ok', comments: [] },
      ],
    },
  },
  workMs: 20,
});
const hq = await startHq({
  home,
  port: 0,
  makeDriver: async () => null,
  mode: cagesMode({
    host: github({ send: transport('aw-nova'), log: () => {} }),
    reviewHost: github({ send: transport('vega'), log: () => {} }),
    repo: 'acme/app',
    base: 'main',
    tickets: {
      'alpha/k1': {
        id: 'alpha/k1',
        kind: 'feature',
        title: 'Three files',
        body: 'Write a, b and c.',
        url: null,
        risk: null,
      },
    },
    author: 'nova',
    reviewer: 'vega',
    workers: { nova: agent, vega: agent },
    pollMs: 100,
    settleMs: 20,
  }),
});
process.stdout.write(`${hq.url}\n`);
