import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cageShells } from '../../server/agents/cage-shell.ts';
import { homeName } from '../../server/sandbox/container.ts';
import { tempDir } from '../../server/test/helpers.ts';
import { CONTEXT, engines, IMAGE } from '../../server/test/sandbox/engines.ts';
import { baselineArm, ticketOf } from '../arms-live.ts';
import { BENCH_ALLOWLIST, BenchCage } from '../cage.ts';
import { runTask, verifyTask } from '../run.ts';
import { dockerRunner, localRunner } from '../runner.ts';
import { prepareTask } from '../workspace.ts';
import { FIXED, makeFixture } from './fixture.ts';

const docker = engines.find((e) => e.name === 'docker');

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
fs.readFileSync(0, 'utf8');
fs.writeFileSync('/work/src/slug.js', ${JSON.stringify(FIXED)});
const git = (...a) => execFileSync('git', ['-c', 'user.name=fake', '-c', 'user.email=fake@agent.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: '/work' });
git('add', 'src/slug.js');
git('commit', '-qm', 'fix');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', usage: { input_tokens: 7, output_tokens: 9 } }) + '\\n');
`;

describe.skipIf(docker === undefined)('the cage mount of a prepared task, on a real docker cage', () => {
  const engine = docker as NonNullable<typeof docker>;
  const home = tempDir('bench-cage');
  const denied: string[] = [];
  const cage = () =>
    new BenchCage({
      engine,
      home,
      hq: randomBytes(3).toString('hex'),
      image: IMAGE,
      project: `agent-works-bench-${randomBytes(3).toString('hex')}`,
      installed,
      onDenial: (d) => denied.push(d.host),
    });
  let driver: BenchCage;
  let installed: string;

  beforeAll(async () => {
    if ((await engine.run(['image', 'inspect', IMAGE])).code !== 0)
      await engine.ok(['build', '-t', IMAGE, '-f', join(CONTEXT, 'Containerfile.test'), CONTEXT], {
        timeoutMs: 600_000,
      });
    installed = tempDir('bench-installed');
    mkdirSync(join(installed, 'node_modules/.bin'), { recursive: true });
    writeFileSync(join(installed, 'node_modules/.bin/runner'), '#!/bin/sh\necho runner\n');
    chmodSync(join(installed, 'node_modules/.bin/runner'), 0o755);
    driver = cage();
    mkdirSync(join(home, 'cages'), { recursive: true });
    const bin = join(home, 'homes', homeName('baseline'), 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
    chmodSync(join(bin, 'claude'), 0o755);
  }, 700_000);

  afterAll(async () => {
    await driver.removeAll();
  }, 120_000);

  it('holds no hidden test, by name or content, and no fix commit while a baseline run is in the cage', async () => {
    const fx = makeFixture();
    const cache = tempDir('bench-cache');
    const scratch = join(cache, 'grading');
    const prepared = await prepareTask(fx.task, {
      cache,
      repoUrl: (r) => join(fx.reposRoot, `${r}.git`),
      runner: localRunner,
    });
    await verifyTask(fx.task, prepared, localRunner, scratch);
    const shells = cageShells(async () => driver, prepared.source);
    const arm = baselineArm(() => shells('baseline', ticketOf(fx.task).id), { bin: '/home/agent/bin/claude' });
    const row = await runTask(fx.task, 1, prepared, { arm, runner: localRunner, scratch });
    expect(row).toMatchObject({ outcome: 'pass', tokens: { input: 7, output: 9 } });
    const shell = shells('baseline', ticketOf(fx.task).id);
    const sh = async (script: string) => (await shell.exec(['sh', '-c', script])).out.trim();
    expect(await sh("find / -xdev -name 'slug-hidden*' -not -path '/proc/*' 2>/dev/null | wc -l")).toBe('0');
    expect(await sh('grep -rl "collapses runs of spaces" /work /home 2>/dev/null | wc -l')).toBe('0');
    expect(await sh(`git -C /work cat-file -e ${fx.fixSha} >/dev/null 2>&1; echo $?`)).not.toBe('0');
    expect(await sh('git -C /work rev-list --all --count')).toBe('2');
  }, 300_000);

  it('runs tests from pre-installed dependencies and cannot reach the upstream repo or the registry', async () => {
    const fx = makeFixture();
    const cache = tempDir('bench-cache');
    const prepared = await prepareTask(fx.task, {
      cache,
      repoUrl: (r) => join(fx.reposRoot, `${r}.git`),
      runner: localRunner,
    });
    const shell = cageShells(async () => driver, prepared.source)('baseline', 'bench/net');
    const sh = async (script: string) => shell.exec(['sh', '-c', script], { timeoutMs: 90_000 });
    expect((await sh('node_modules/.bin/runner')).out.trim()).toBe('runner');
    expect((await sh('git status --porcelain')).out.trim()).toBe('');
    const remote = await sh('git ls-remote https://github.com/unjs/ufo.git');
    const fetched = await sh(`git fetch https://github.com/unjs/ufo.git ${fx.fixSha}`);
    const registry = await sh('git ls-remote https://registry.npmjs.org/ufo.git');
    expect([remote.code, fetched.code, registry.code].every((code) => code !== 0)).toBe(true);
    await vi.waitFor(() => expect(denied).toEqual(expect.arrayContaining(['github.com', 'registry.npmjs.org'])), {
      timeout: 15_000,
    });
  }, 300_000);

  it('mounts the home of the mapped login worker for the author and the reviewer of a factory run', async () => {
    const fx = makeFixture();
    const cache = tempDir('bench-cache');
    const prepared = await prepareTask(fx.task, {
      cache,
      repoUrl: (r) => join(fx.reposRoot, `${r}.git`),
      runner: localRunner,
    });
    const other = homeName('someone-else');
    mkdirSync(join(home, 'homes', other), { recursive: true });
    writeFileSync(join(home, 'homes', homeName('baseline'), 'marker'), 'login home\n');
    writeFileSync(join(home, 'homes', other, 'marker'), 'other home\n');
    const mapped = new BenchCage({
      engine,
      home,
      hq: randomBytes(3).toString('hex'),
      image: IMAGE,
      project: `agent-works-bench-${randomBytes(3).toString('hex')}`,
      installed,
      homeWorker: (worker) => (worker === 'vega' ? 'someone-else' : 'baseline'),
    });
    try {
      const shells = cageShells(async () => mapped, prepared.source);
      const seen = async (worker: string) =>
        (await shells(worker, 'bench/home').exec(['cat', '/home/agent/marker'])).out.trim();
      expect([await seen('nova'), await seen('vega')]).toEqual(['login home', 'other home']);
    } finally {
      await mapped.removeAll();
    }
  }, 300_000);

  it('allows the model API and nothing else', () => {
    expect(BENCH_ALLOWLIST).toEqual(['api.anthropic.com']);
  });

  it('removes the container of a grading run that times out', async () => {
    const ran = await dockerRunner().run({
      argv: ['sleep', '60'],
      cwd: tempDir('bench-sleep'),
      image: IMAGE,
      network: false,
      timeoutMs: 1500,
    });
    expect(ran.timedOut).toBe(true);
    expect((await engine.run(['ps', '-aq', '--filter', 'name=aw-bench-'])).out.trim()).toBe('');
  }, 60_000);
});
