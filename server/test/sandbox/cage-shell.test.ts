import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cageShells } from '../../agents/cage-shell.ts';
import { claudeCode } from '../../agents/claude-code.ts';
import type { AgentJob } from '../../agents/runtime.ts';
import { homeName, SandboxDriver } from '../../sandbox/container.ts';
import type { Denial } from '../../sandbox/firewall.ts';
import { siteOf } from '../../sandbox/site.ts';
import { TICKETS } from '../fixtures/factory.ts';
import { folder, tempDir } from '../helpers.ts';
import { CONTEXT, engines, IMAGE } from './engines.ts';

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const prompt = fs.readFileSync(0, 'utf8');
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const usage = { input_tokens: 1, output_tokens: 2 };
if (prompt.includes('Review change')) {
  const verdict = { verdict: 'changes', body: 'read ' + prompt.length + ' bytes', comments: [{ path: 'notes/agent.txt', line: 1, body: 'ok' }] };
  line({ type: 'result', subtype: 'success', is_error: false, result: '\`\`\`json\\n' + JSON.stringify(verdict) + '\\n\`\`\`', usage });
} else {
  fs.mkdirSync('/work/notes', { recursive: true });
  fs.writeFileSync('/work/notes/agent.txt', prompt.split('\\n')[0] + '\\n');
  const git = (...a) => execFileSync('git', ['-c', 'user.name=fake', '-c', 'user.email=fake@agent.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: '/work' });
  git('add', 'notes/agent.txt');
  git('commit', '-qm', 'fake agent');
  line({ type: 'result', subtype: 'success', is_error: false, result: 'committed', usage });
}
`;

const signal = new AbortController().signal;
const ticket = TICKETS['alpha/t1'] as NonNullable<(typeof TICKETS)['alpha/t1']>;
const docker = engines.find((e) => e.name === 'docker');

describe.skipIf(docker === undefined)('the cage shell and Allow on a real docker cage', () => {
  const engine = docker as NonNullable<typeof docker>;
  const project = `agent-works-test-${randomBytes(3).toString('hex')}`;
  const home = tempDir('cage-shell');
  const denials: Denial[] = [];
  let driver: SandboxDriver;
  let source: string;

  beforeAll(async () => {
    const have = await engine.run(['image', 'inspect', IMAGE]);
    if (have.code !== 0)
      await engine.ok(['build', '-t', IMAGE, '-f', join(CONTEXT, 'Containerfile.test'), CONTEXT], {
        timeoutMs: 600_000,
      });
    driver = new SandboxDriver({
      engine,
      home,
      hq: randomBytes(3).toString('hex'),
      image: IMAGE,
      project,
      onDenial: (d) => denials.push(d),
    });
    source = folder(tempDir('cage-shell-src'), 'source');
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
        cwd: source,
      });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(source, 'README.md'), '# fixture\n');
    git('add', '-A');
    git('commit', '-qm', 'fixture');
    for (const worker of ['nova', 'vega']) {
      const bin = folder(join(home, 'homes', homeName(worker)), 'bin');
      writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
      chmodSync(join(bin, 'claude'), 0o755);
    }
    mkdirSync(join(home, 'cages'), { recursive: true });
  }, 700_000);

  afterAll(async () => {
    await driver.removeAll();
  }, 120_000);

  it('runs the agent binary in the cage with the prompt on stdin and reads its commit back', async () => {
    const runtime = claudeCode({ shell: cageShells(async () => driver, source), bin: '/home/agent/bin/claude' });
    const job: AgentJob = { role: 'author', task: 'alpha/t1', worker: 'nova', ticket, round: 0, comments: [], signal };
    const done = await runtime.run(job);
    expect(done).toMatchObject({
      role: 'author',
      files: [{ path: 'notes/agent.txt', content: 'Work order alpha/t1: Add a greeting file\n' }],
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    expect(driver.list().map((c) => c.worker)).toEqual(['nova']);
    const again = await runtime.run(job).catch((error: Error) => error);
    expect(again).toBeInstanceOf(Error);
    expect(driver.list()).toHaveLength(1);
  }, 300_000);

  it('hands a reviewer a 3 MB PR on stdin without hitting the argv limit', async () => {
    const runtime = claudeCode({ shell: cageShells(async () => driver, source), bin: '/home/agent/bin/claude' });
    const big = 'y'.repeat(1024 * 1024);
    const done = await runtime.run({
      role: 'reviewer',
      task: 'alpha/t1',
      worker: 'vega',
      ticket,
      round: 1,
      change: {
        host: 'github',
        kind: 'change',
        repo: 'acme/app',
        headRepo: 'acme/app',
        number: 1,
        branch: 'aw/alpha/t1',
        author: 'aw-nova',
        state: 'open',
        headSha: 'abc',
        url: 'u',
        at: 1,
      },
      files: [0, 1, 2].map((i) => ({ path: `big${i}.txt`, content: big })),
      signal,
    });
    expect(done.role === 'reviewer' && Number(/read (\d+) bytes/.exec(done.body)?.[1])).toBeGreaterThan(
      3 * 1024 * 1024,
    );
  }, 300_000);

  it('turns a denied host into an allowed one on the running proxy', async () => {
    const [cage] = driver.list();
    const connect = async (target: string) =>
      (
        await engine.run([
          'exec',
          cage?.container ?? '',
          'node',
          '-e',
          `const u=new URL(process.env.HTTPS_PROXY);const r=require('http').request({host:u.hostname,port:u.port,method:'CONNECT',path:'${target}',headers:{'Proxy-Authorization':'Basic '+Buffer.from(u.username+':x').toString('base64')},timeout:8000});r.on('connect',res=>{console.log('STATUS '+res.statusCode);process.exit(0)});r.on('error',e=>{console.log('ERROR '+e.code);process.exit(0)});r.on('timeout',()=>{console.log('ERROR TIMEOUT');process.exit(0)});r.end()`,
        ])
      ).out.trim();
    expect(await connect('blocked.invalid:443')).toBe('STATUS 403');
    const deadline = Date.now() + 10_000;
    while (!denials.some((d) => d.host === 'blocked.invalid') && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    const denied = denials.find((d) => d.host === 'blocked.invalid');
    expect(denied).toMatchObject({ port: 443, agent: 'nova' });
    const site = siteOf('Blocked.Invalid.', denied?.port);
    expect(site?.site).toBe('blocked.invalid:443');
    await driver.allow(site?.site ?? '');
    expect(await connect('blocked.invalid:443')).toBe('STATUS 502');
    expect(await connect('blocked.invalid:8443')).toBe('STATUS 403');
    await expect(driver.allow('1.2.3.4:443')).rejects.toThrow(/not a host rule/);
  }, 120_000);
});
