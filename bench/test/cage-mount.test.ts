import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cageShells } from '../../server/agents/cage-shell.ts';
import { homeName, SandboxDriver } from '../../server/sandbox/container.ts';
import { tempDir } from '../../server/test/helpers.ts';
import { CONTEXT, engines, IMAGE } from '../../server/test/sandbox/engines.ts';
import { baselineArm } from '../arms-live.ts';
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
  let driver: SandboxDriver;

  beforeAll(async () => {
    if ((await engine.run(['image', 'inspect', IMAGE])).code !== 0)
      await engine.ok(['build', '-t', IMAGE, '-f', join(CONTEXT, 'Containerfile.test'), CONTEXT], {
        timeoutMs: 600_000,
      });
    driver = new SandboxDriver({
      engine,
      home,
      hq: randomBytes(3).toString('hex'),
      image: IMAGE,
      project: `agent-works-bench-${randomBytes(3).toString('hex')}`,
    });
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
    const arm = baselineArm(() => shells('baseline', 'bench/slug-1'), { bin: '/home/agent/bin/claude' });
    const row = await runTask(fx.task, 1, prepared, { arm, runner: localRunner, scratch });
    expect(row).toMatchObject({ outcome: 'pass', tokens: { input: 7, output: 9 } });
    const shell = shells('baseline', 'bench/slug-1');
    const sh = async (script: string) => (await shell.exec(['sh', '-c', script])).out.trim();
    expect(await sh("find / -xdev -name 'slug-hidden*' -not -path '/proc/*' 2>/dev/null | wc -l")).toBe('0');
    expect(await sh('grep -rl "collapses runs of spaces" /work /home 2>/dev/null | wc -l')).toBe('0');
    expect(await sh(`git -C /work cat-file -e ${fx.fixSha} >/dev/null 2>&1; echo $?`)).not.toBe('0');
    expect(await sh('git -C /work rev-list --all --count')).toBe('2');
  }, 300_000);

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
