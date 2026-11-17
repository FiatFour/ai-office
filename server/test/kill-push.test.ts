import { type ChildProcess, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpRequest } from '../githost/host.ts';
import type { Snapshot } from '../snapshot.ts';
import { FakeGithub } from './fakes/github-api.ts';
import { canSpawnTs, exited, tempDir } from './helpers.ts';

const CHILD = fileURLToPath(new URL('./fixtures/hq-child.ts', import.meta.url));

interface Host {
  readonly fake: FakeGithub;
  readonly url: string;
  readonly server: Server;
  killed: boolean;
}

type Rule = (call: string, fake: FakeGithub) => boolean;
const matches =
  (pattern: RegExp): Rule =>
  (call) =>
    pattern.test(call);

const fakeHost = async (rule: Rule, nth: number): Promise<Host> => {
  const fake = new FakeGithub();
  let seen = 0;
  const host: Host = { fake, url: '', server: createServer(), killed: false };
  host.server.on('request', async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const { account, request, pid } = JSON.parse(Buffer.concat(chunks).toString()) as {
      account: string;
      request: HttpRequest;
      pid: number;
    };
    const out = await fake.transport(account)(request);
    if (!host.killed && out.status < 400 && rule(`${request.method} ${request.path}`, fake) && ++seen === nth) {
      host.killed = true;
      process.kill(pid, 'SIGKILL');
    }
    res.end(JSON.stringify(out));
  });
  await new Promise<void>((resolve) => host.server.listen(0, '127.0.0.1', resolve));
  return { ...host, url: `http://127.0.0.1:${(host.server.address() as { port: number }).port}` } as Host;
};

const children: ChildProcess[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const server of servers.splice(0)) server.close();
});

const startChild = async (home: string, fakeUrl: string): Promise<{ child: ChildProcess; url: string }> => {
  const child = spawn(process.execPath, [...process.execArgv, CHILD, home, fakeUrl], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let err = '';
  child.stderr?.on('data', (c: Buffer) => {
    err += c.toString();
  });
  const url = await new Promise<string>((resolve, reject) => {
    child.stdout?.once('data', (c: Buffer) => resolve(c.toString().trim()));
    child.once('exit', () => reject(new Error(`HQ child exited: ${err}`)));
  });
  return { child, url };
};

const snapshot = async (url: string): Promise<Snapshot> =>
  (await fetch(`${url}/api/snapshot`)).json() as Promise<Snapshot>;

describe.skipIf(!canSpawnTs)('a real kill -9 during a push', () => {
  it.each([
    ['mid-first-push, after the tree', matches(/^POST .*\/git\/trees$/), 1],
    ['mid-fix-push, after the tree', matches(/^POST .*\/git\/trees$/), 2],
    ['mid-fix-push, after the commit', matches(/^POST .*\/git\/commits$/), 2],
    [
      'after the first branch move of the fix round',
      (call: string, fake: FakeGithub) => /^PATCH /.test(call) && fake.reviews.length > 0,
      1,
    ],
  ] as const)(
    '%s leaves no partial round on the branch, and the approval covers the whole fix',
    async (_name, rule, nth) => {
      const host = await fakeHost(rule, nth);
      servers.push(host.server);
      const home = tempDir('kill-push');
      const first = await startChild(home, host.url);
      await fetch(`${first.url}/api/tickets`, { method: 'POST', body: JSON.stringify({ id: 'alpha/k1' }) });
      await exited(first.child);
      expect(first.child.signalCode).toBe('SIGKILL');
      const second = await startChild(home, host.url);
      let snap = await snapshot(second.url);
      for (let i = 0; i < 200 && !snap.actions.some((a) => a.kind === 'ready_to_merge'); i += 1) {
        await sleep(50);
        snap = await snapshot(second.url);
      }
      expect(snap.actions.map((a) => a.kind)).toContain('ready_to_merge');
      const { fake } = host;
      const round = (commit: string) => {
        const files = fake.trees.get(commit) ?? new Map();
        return new Set(['a.txt', 'b.txt', 'c.txt'].map((path) => files.get(path)?.slice(1)));
      };
      for (const review of fake.reviews) expect(round(review.commit).size, `review on ${review.commit}`).toBe(1);
      const approved = fake.reviews.filter((r) => r.state === 'APPROVED');
      expect(approved).toHaveLength(1);
      expect(Object.fromEntries(fake.trees.get(approved[0]?.commit ?? '') ?? [])).toMatchObject({
        'a.txt': 'a2\n',
        'b.txt': 'b2\n',
        'c.txt': 'c2\n',
      });
      expect(fake.prs).toHaveLength(1);
      expect(fake.calls.filter((c) => /merge/.test(c.path))).toEqual([]);
    },
    30_000,
  );
});
