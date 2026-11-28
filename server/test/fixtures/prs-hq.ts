// A real HQ for the QC gate screen lane: the cages mode and the real GitHub driver with its write guard, over an
// in-memory GitHub, with the scripted runtime. The lane drives it with one command a line on stdin.
//   argv: <home> <assets folder> <api call log>
import { createInterface } from 'node:readline';
import { scripted } from '../../agents/scripted.ts';
import { withBriefs } from '../../brief/store.ts';
import { github } from '../../githost/github.ts';
import { fileLog } from '../../githost/host.ts';
import { startHq } from '../../hq.ts';
import { cagesMode } from '../../modes/cages.ts';
import { withChanges } from '../../snapshot/changes.ts';
import { FakeGithub } from '../fakes/github-api.ts';
import { SCRIPTS, TICKETS } from './factory.ts';

const [home = '', assets = '', log = ''] = process.argv.slice(2);
const fake = new FakeGithub();
const account = (login: string) =>
  github({ repo: 'acme/app', base: 'main', send: fake.transport(login), log: fileLog(log) });
const host = account('aw-nova');
const reviewHost = account('vega');

// The author's fix round waits for `release`, so the lane can look at the CHANGES state for as long as it likes.
let release = () => {};
const released = new Promise<void>((resolve) => {
  release = resolve;
});
const agent = scripted({ scripts: SCRIPTS });
const held: typeof agent = {
  id: agent.id,
  run: async (job) => {
    if (job.role === 'author' && job.round > 0) await released;
    return agent.run(job);
  },
};

const shared = { repo: 'acme/app', base: 'main', tickets: TICKETS };
const hq = await startHq({
  home,
  port: 0,
  assets,
  makeDriver: async () => null,
  mode: withBriefs(
    withChanges(
      cagesMode({
        ...shared,
        host,
        reviewHost,
        author: 'nova',
        reviewer: 'vega',
        workers: { nova: held, vega: held },
        pollMs: 100,
        settleMs: 20,
      }),
      { ...shared, host, reviewHost },
    ),
    { ...shared, host, reviewHost, author: agent.id, maxAgeMs: 200 },
  ),
});

createInterface({ input: process.stdin }).on('line', (line) => {
  const [command, argument] = line.split(' ');
  if (command === 'release') release();
  if (command === 'merge') fake.mergeByHuman(Number(argument));
  // A check that turns red on the head of a branch, as a late CI job would.
  if (command === 'red') fake.setStatus(fake.refs.get(argument ?? '') ?? '', 'late', 'failure');
  const reply = command === 'calls' ? fake.calls.map(({ method, path }) => `${method} ${path}`) : [];
  process.stdout.write(`${JSON.stringify(reply)}\n`);
});
process.stdin.on('end', () => void hq.close().then(() => process.exit(0)));
process.stdout.write(`${hq.url}\n`);
