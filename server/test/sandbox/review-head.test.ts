import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cageShells } from '../../agents/cage-shell.ts';
import { claudeCode } from '../../agents/claude-code.ts';
import { github } from '../../githost/github.ts';
import { type RunningHq, startHq } from '../../hq.ts';
import { cagesMode } from '../../modes/cages.ts';
import { homeName, SandboxDriver } from '../../sandbox/container.ts';
import { FakeGithub } from '../fakes/github-api.ts';
import { TICKETS } from '../fixtures/factory.ts';
import { folder, hasSqlite, tempDir } from '../helpers.ts';
import { CONTEXT, engines, IMAGE } from './engines.ts';

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync, spawnSync } = require('node:child_process');
const prompt = fs.readFileSync(0, 'utf8');
const done = (result) => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, usage: {} }) + '\\n');
const git = (...a) => execFileSync('git', ['-c', 'user.name=fake', '-c', 'user.email=fake@agent.invalid', ...a], { cwd: '/work', encoding: 'utf8' });
if (prompt.includes('Review change')) {
  const ran = spawnSync('node', ['--test', '--test-reporter=tap', 'greet.test.mjs'], { cwd: '/work', encoding: 'utf8' });
  const seen = {
    tests: ran.status === 0 && ran.stdout.includes('# pass 1') ? 'passed' : 'failed',
    remotes: git('remote').trim(),
    helpers: spawnSync('git', ['config', '--get-all', 'credential.helper'], { cwd: '/work', encoding: 'utf8' }).stdout.trim(),
    tokens: Object.keys(process.env).filter((k) => /TOKEN|PASSWORD|SECRET|SSH_|GH_|GITLAB/.test(k)),
  };
  done('\`\`\`json\\n' + JSON.stringify({ verdict: 'approve', body: 'SEEN ' + JSON.stringify(seen), comments: [] }) + '\\n\`\`\`');
} else {
  fs.writeFileSync('/work/greet.mjs', "export const greet = () => 'hello';\\n");
  fs.writeFileSync('/work/greet.test.mjs', "import assert from 'node:assert';\\nimport { test } from 'node:test';\\nimport { greet } from './greet.mjs';\\ntest('greets', () => assert.equal(greet(), 'hello'));\\n");
  git('add', '-A');
  git('commit', '-qm', 'greet');
  done('committed');
}
`;

const docker = engines.find((e) => e.name === 'docker');

describe.skipIf(docker === undefined || !hasSqlite)('the reviewer cage on a real docker cage', () => {
  const engine = docker as NonNullable<typeof docker>;
  const project = `agent-works-test-${randomBytes(3).toString('hex')}`;
  const home = tempDir('review-head');
  const fake = new FakeGithub();
  let driver: SandboxDriver;
  let hq: RunningHq | undefined;
  let source: string;

  beforeAll(async () => {
    const have = await engine.run(['image', 'inspect', IMAGE]);
    if (have.code !== 0)
      await engine.ok(['build', '-t', IMAGE, '-f', join(CONTEXT, 'Containerfile.test'), CONTEXT], {
        timeoutMs: 600_000,
      });
    driver = new SandboxDriver({ engine, home, hq: randomBytes(3).toString('hex'), image: IMAGE, project });
    source = folder(tempDir('review-head-src'), 'source');
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
        cwd: source,
      });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(source, 'README.md'), '# app\n');
    git('add', '-A');
    git('commit', '-qm', 'fixture');
    for (const worker of ['nova', 'vega']) {
      const bin = folder(join(home, 'homes', homeName(worker)), 'bin');
      writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
      chmodSync(join(bin, 'claude'), 0o755);
    }
  }, 700_000);

  afterAll(async () => {
    await hq?.close();
    await driver.removeAll();
  }, 120_000);

  it('runs the tests of the PR head with no git remote and no credential', async () => {
    const runtime = claudeCode({ shell: cageShells(async () => driver, source), bin: '/home/agent/bin/claude' });
    const options = { repo: 'acme/app', base: 'main', log: () => {} };
    hq = await startHq({
      home: tempDir('review-head-hq'),
      port: 0,
      makeDriver: async () => null,
      mode: cagesMode({
        host: github({ ...options, send: fake.transport('aw-nova') }),
        reviewHost: github({ ...options, send: fake.transport('vega') }),
        repo: 'acme/app',
        base: 'main',
        tickets: TICKETS,
        author: 'nova',
        reviewer: 'vega',
        workers: { nova: runtime, vega: runtime },
        pollMs: 200,
      }),
    });
    await fetch(`${hq.url}/api/tickets`, { method: 'POST', body: JSON.stringify({ id: 'alpha/t1' }) });
    const deadline = Date.now() + 120_000;
    while (fake.reviews.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const seen = /SEEN (\{.*\})/.exec(fake.reviews[0]?.body ?? '')?.[1];
    expect(JSON.parse(seen ?? 'null')).toEqual({ tests: 'passed', remotes: '', helpers: '', tokens: [] });
  }, 300_000);
});
