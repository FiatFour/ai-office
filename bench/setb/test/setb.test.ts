import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GITHUB_WRITES } from '../../../server/githost/github.ts';
import { writeProblem } from '../../../server/githost/host.ts';
import { canSpawnTs, tempDir } from '../../../server/test/helpers.ts';
import { TaskRefused } from '../../model.ts';
import { realPackets, refuseSeededGrade, type Seed, seededPackets } from '../cli.ts';
import { fetchPacket, type Hub, secretsOf } from '../fetch.ts';
import { touchesWorkflows } from '../guard.ts';
import {
  CALIBRATION_SIZE,
  claudeArgs,
  countVoids,
  type Judged,
  judgeOne,
  MAX_ATTEMPTS,
  MAX_VOIDS,
  recordVoid,
  refuseAfterVoids,
  runJudge,
  voidsLogPath,
} from '../judge.ts';
import { assignLabels, type Entry } from '../labels.ts';
import { ciFrom, ciOfBody, type Grading, gradeSetB, inferWindows, PAGE, readPaths, readWindow } from '../outcome.ts';
import { ownerOf } from '../owned.ts';
import {
  armLeaks,
  buildPacket,
  fenceFor,
  isUnreadable,
  type Packet,
  packetOrUnreadable,
  renderPrompt,
} from '../packet.ts';
import { JudgeUnparseable, parseVerdict, RUBRIC, startsWithVerdict } from '../rubric.ts';
import {
  frozenBaseRepo,
  type Git,
  type GitRun,
  loadFrozen,
  parseTaskList,
  SET_B_SIZE,
  SHA_FILE,
  shaOf,
  TASKS_FILE,
} from '../task.ts';

const realGit: Git = (cwd, args) => {
  const ran = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
};

const SETB = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(SETB, '..', '..');
const raw = () => JSON.parse(readFileSync(join(SETB, TASKS_FILE), 'utf8')) as { tasks: Record<string, unknown>[] };

describe('the frozen task list', () => {
  it('loads, holds ten tasks, and every named file and test exists on main', () => {
    const list = loadFrozen(SETB);
    expect(list.tasks).toHaveLength(SET_B_SIZE);
    for (const t of list.tasks) {
      for (const f of t.files) expect(existsSync(join(ROOT, f)), `${t.id}: ${f}`).toBe(true);
      expect(existsSync(join(ROOT, t.testCommand.at(-1) ?? '')), t.id).toBe(true);
    }
  });

  it('refuses a list whose bytes changed after the freeze', () => {
    const dir = tempDir('setb-frozen');
    writeFileSync(join(dir, TASKS_FILE), readFileSync(join(SETB, TASKS_FILE)));
    writeFileSync(join(dir, SHA_FILE), `${'0'.repeat(64)}\n`);
    expect(() => loadFrozen(dir)).toThrow(/changed after it was frozen/);
    writeFileSync(join(dir, SHA_FILE), `${shaOf(readFileSync(join(dir, TASKS_FILE)))}\n`);
    expect(loadFrozen(dir).tasks).toHaveLength(SET_B_SIZE);
  });

  const mutate = (edit: (o: { tasks: Record<string, unknown>[] }) => void) => {
    const o = raw();
    edit(o);
    return () => parseTaskList({ repo: 'FiatFour/ai-office', frozenAtSha: 'a'.repeat(40), ...o });
  };

  it('refuses the wrong size, a repeated item, an out-of-range issue and a bad repo', () => {
    expect(mutate((o) => o.tasks.pop())).toThrow(/exactly 10/);
    expect(mutate((o) => (o.tasks[1] = { ...o.tasks[0] }))).toThrow(/repeats/);
    expect(mutate((o) => (o.tasks[0] = { ...o.tasks[0], issue: 25 }))).toThrow(/#7 to #24/);
    expect(() =>
      parseTaskList({ ...raw(), repo: 'FiatFour/agent-works-scratch', frozenAtSha: 'a'.repeat(40) }),
    ).toThrow(/targets FiatFour\/ai-office/);
  });

  it('refuses a task on a file a wave 2 ticket owns, or one that needs a container engine', () => {
    expect(mutate((o) => (o.tasks[0] = { ...o.tasks[0], files: ['server/modes/cages.ts'] }))).toThrow(/P3-11/);
    expect(mutate((o) => (o.tasks[0] = { ...o.tasks[0], files: ['.github/workflows/ci.yml'] }))).toThrow(/owned by/);
    expect(mutate((o) => (o.tasks[0] = { ...o.tasks[0], testCommand: ['docker', 'run', 'x'] }))).toThrow(
      /container engine/,
    );
  });

  it('refuses a task whose test file a wave 2 ticket owns, even when its source files are free', () => {
    const own = (testCommand: string[]) => mutate((o) => (o.tasks[0] = { ...o.tasks[0], testCommand }));
    expect(own(['pnpm', 'vitest', 'run', 'server/test/githost.contract.test.ts'])).toThrow(/owned by P3-5/);
    expect(own(['pnpm', 'vitest', 'run', 'scripts/check-sources.test.ts'])).not.toThrow();
  });

  it('holds no task whose source or test file belongs to another ticket', () => {
    for (const t of loadFrozen(SETB).tasks)
      for (const f of [...t.files, ...t.testCommand]) expect(ownerOf(f), `${t.id}: ${f}`).toBeNull();
  });

  it.skipIf(!canSpawnTs)('runs the CLI check, label and judge through the frozen-list check', () => {
    const dir = tempDir('setb-cli');
    writeFileSync(join(dir, TASKS_FILE), readFileSync(join(SETB, TASKS_FILE)));
    writeFileSync(join(dir, SHA_FILE), `${'0'.repeat(64)}\n`);
    writeFileSync(join(dir, 'entries.json'), '[]');
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [join(SETB, 'cli.ts'), ...args, '--dir', dir], {
        encoding: 'utf8',
        env: { ...process.env, AW_BENCH_LOGIN_CONFIRMED: '1' },
      });
    for (const args of [
      ['check'],
      ['label', '--entries', join(dir, 'entries.json'), '--key', join(dir, 'k.json')],
      ['judge', '--key', join(dir, 'k.json'), '--out', join(dir, 'o.json')],
    ]) {
      const ran = run(...args);
      expect(ran.stderr, args[0]).toMatch(/changed after it was frozen/);
      expect(ran.status, args[0]).toBe(3);
    }
  });

  describe.skipIf(process.platform === 'win32' || !canSpawnTs)('the judge command and its voids log', () => {
    const setup = () => {
      const dir = tempDir('setb-judge');
      const bytes = readFileSync(join(SETB, TASKS_FILE));
      writeFileSync(join(dir, TASKS_FILE), bytes);
      writeFileSync(join(dir, SHA_FILE), `${shaOf(bytes)}\n`);
      writeFileSync(join(dir, 'entries.json'), '[]');
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'claude'), "#!/bin/sh\ncat >/dev/null\necho 'VERDICT: MERGE AS IS'\n", { mode: 0o755 });
      const env = { ...process.env, AW_BENCH_LOGIN_CONFIRMED: '1', PATH: `${bin}:${process.env.PATH ?? ''}` };
      const run = (...args: string[]) =>
        spawnSync(process.execPath, [join(SETB, 'cli.ts'), ...args, '--dir', dir], { encoding: 'utf8', env });
      const labelled = run('label', '--entries', join(dir, 'entries.json'), '--key', join(dir, 'k.json'));
      expect(labelled.status, labelled.stderr).toBe(0);
      const judge = (out: string) => run('judge', '--key', join(dir, 'k.json'), '--out', join(dir, out));
      return { dir, judge, log: voidsLogPath(dir, shaOf(bytes)) };
    };

    it('logs each void at one path that no --out can move, and ends Set B at the third', () => {
      const { dir, judge, log } = setup();
      expect(log).toMatch(/\.jsonl$/);
      expect(
        realGit(ROOT, ['check-ignore', '-q', voidsLogPath(SETB, 'a'.repeat(64))]).status,
        'the voids log must not be gitignored',
      ).toBe(1);
      for (const [i, out] of ['a.json', 'b.json', 'c.json'].entries()) {
        const ran = judge(out);
        expect(ran.status, ran.stderr).toBe(4);
        expect(ran.stdout).toMatch(/^VOID: /);
        expect(readFileSync(log, 'utf8').split('\n').filter(Boolean), out).toHaveLength(i + 1);
        expect(existsSync(join(dir, `${out}.voids.log`))).toBe(false);
      }
      const fourth = judge('d.json');
      expect(fourth.status).toBe(3);
      expect(fourth.stderr).toMatch(/3 judge runs were void/);
      expect(existsSync(join(dir, 'd.json'))).toBe(false);
    });

    it('keeps the count when the voids log is deleted, because the voided --out files remain', () => {
      const { dir, judge } = setup();
      for (const out of ['a.json', 'b.json']) expect(judge(out).status).toBe(4);
      rmSync(join(dir, 'voids'), { recursive: true });
      expect(judge('c.json').status).toBe(4);
      const fourth = judge('d.json');
      expect(fourth.status).toBe(3);
      expect(fourth.stderr).toMatch(/3 judge runs were void/);
    });

    it('counts the voided --out files of another directory named by --out', () => {
      const { dir, judge } = setup();
      const elsewhere = tempDir('setb-elsewhere');
      for (const out of ['x.json', 'y.json', 'z.json'])
        writeFileSync(join(elsewhere, out), '{"voided":"a seeded PR passed","judged":[],"unreadable":[]}\n');
      const ran = judge(join(relative(dir, elsewhere), 'new.json'));
      expect(ran.status).toBe(3);
      expect(existsSync(join(dir, 'voids'))).toBe(false);
    });

    it('refuses a run that finds the void limit already reached, whatever --out is named', () => {
      const { judge, log } = setup();
      mkdirSync(dirname(log), { recursive: true });
      writeFileSync(log, '{"reason":"x"}\n{"reason":"y"}\n{"reason":"z"}\n');
      const ran = judge('fresh.json');
      expect(ran.status).toBe(3);
      expect(ran.stderr).toMatch(/3 judge runs were void/);
    });

    it('does not overwrite an --out that already exists', () => {
      const { dir, judge, log } = setup();
      writeFileSync(join(dir, 'taken.json'), 'keep');
      const ran = judge('taken.json');
      expect(ran.status).toBe(3);
      expect(ran.stderr).toMatch(/already exists/);
      expect(readFileSync(join(dir, 'taken.json'), 'utf8')).toBe('keep');
      expect(existsSync(log)).toBe(false);
    });
  });

  it('keeps ownership patterns exact', () => {
    expect(ownerOf('bench/setb/cli.ts')).toBe('P3-1');
    expect(ownerOf('./server/githost/host.ts')).toBe('P3-5');
    expect(ownerOf('server/githost/watch-poll.ts')).toBe('P3-9');
    expect(ownerOf('server/registry.ts')).toBeNull();
    expect(ownerOf('server/githost/hostile.ts')).toBeNull();
  });
});

describe('the .github guard', () => {
  it.each([
    '.github/workflows/ci.yml',
    './.github/x',
    '.GitHub/x',
    'a/../.github/x',
    '\\.github\\x',
    '/.github/x',
    '.github',
  ])('refuses %s', (p) => expect(touchesWorkflows(p)).toBe(true));
  it.each(['src/.github/x', '.githubx/a', 'github/x', 'docs/.githubish'])('allows %s', (p) =>
    expect(touchesWorkflows(p)).toBe(false),
  );

  it.each([
    'x/../../.github/y',
    '../.github/x',
    'a/../../../.github/workflows/ci.yml',
    'CODEOWNERS',
    'docs/CODEOWNERS',
    './docs/codeowners',
  ])('refuses %s', (p) => expect(touchesWorkflows(p)).toBe(true));
  it.each(['src/CODEOWNERS', 'docs/CODEOWNERS.md', 'a/../src/x.ts'])('allows %s', (p) =>
    expect(touchesWorkflows(p)).toBe(false),
  );

  it('is backed by the host choke point: a tree write into .github, in any case, is refused before it is sent', () => {
    const scope = { home: '/repos/a/b', base: 'main' };
    const tree = (path: string) => ({
      method: 'POST' as const,
      path: '/repos/a/b/git/trees',
      body: { base_tree: 't', tree: [{ path, mode: '100644', type: 'blob', content: 'x' }] },
    });
    for (const path of ['.github/workflows/x.yml', '.GitHub/workflows/x.yml', 'a/.github/x'])
      expect(writeProblem(GITHUB_WRITES, tree(path), scope), path).toMatch(/hidden/);
    expect(writeProblem(GITHUB_WRITES, tree('src/a.ts'), scope)).toBeNull();
  });
});

describe('blind labels', () => {
  const entries: Entry[] = Array.from({ length: 8 }, (_, i) => ({
    task: `t${i}`,
    arm: i % 2 === 0 ? 'factory' : 'baseline',
    pr: i + 100,
    readyHeadSha: 'a'.repeat(40),
  }));

  it('gives every PR a unique random label and orders the list by label, not by arm', () => {
    const key = assignLabels(entries);
    expect(new Set(key.map((s) => s.label)).size).toBe(entries.length);
    expect(key.map((s) => s.label)).toEqual([...key.map((s) => s.label)].sort());
    for (const s of key) expect(s.label).toMatch(/^pr-[0-9a-f]{8}$/);
  });

  it('does not order by arm: the labels come from the injected draw, not from the entries', () => {
    const draws = entries.map((_, i) => Buffer.from([0xff - i, 0, 0, 0]));
    const key = assignLabels(entries, () => draws.shift() ?? Buffer.alloc(4));
    expect(key.map((s) => s.entry.task)).toEqual(entries.map((e) => e.task).reverse());
    expect(key.map((s) => s.entry.arm).join()).not.toBe(entries.map((e) => e.arm).join());
  });

  it('draws again on a collision', () => {
    const draws = [Buffer.from('aaaaaaaa', 'hex'), Buffer.from('aaaaaaaa', 'hex'), Buffer.from('bbbbbbbb', 'hex')];
    const key = assignLabels(entries.slice(0, 2), () => draws.shift() ?? Buffer.from('cccccccc', 'hex'));
    expect(key.map((s) => s.label)).toEqual(['pr-aaaaaaaa', 'pr-bbbbbbbb']);
  });
});

describe('the rubric', () => {
  it('reads each verdict', () => {
    expect(parseVerdict('fine\nVERDICT: MERGE AS IS')).toEqual({ verdict: 'MERGE AS IS', editLines: 0 });
    expect(parseVerdict('no\nVERDICT: REJECT')).toEqual({ verdict: 'REJECT', editLines: 0 });
  });

  it('counts the lines of the edit diff for MERGE AFTER EDITS, ignoring file headers', () => {
    const reply = 'edit:\n```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n+more\n```\nVERDICT: MERGE AFTER EDITS';
    expect(parseVerdict(reply)).toEqual({ verdict: 'MERGE AFTER EDITS', editLines: 3 });
  });

  it('reads the final line with emphasis, backticks, a period, any case and CRLF, and nothing looser', () => {
    for (const last of [
      'VERDICT: REJECT.',
      'Verdict: reject',
      '`VERDICT: REJECT`',
      '**VERDICT: REJECT**',
      '**VERDICT:** REJECT',
      '_VERDICT: REJECT._',
    ])
      expect(parseVerdict(`reasons\n\n${last}\n`).verdict, last).toBe('REJECT');
    expect(parseVerdict('ok\r\nVERDICT: REJECT\r\n').verdict).toBe('REJECT');
    const crlf = 'e:\r\n```diff\r\n--- a/x\r\n+++ b/x\r\n-old\r\n+new\r\n```\r\nVERDICT: MERGE AFTER EDITS\r\n';
    expect(parseVerdict(crlf)).toEqual({ verdict: 'MERGE AFTER EDITS', editLines: 2 });
    for (const last of [
      '## VERDICT: REJECT',
      '> VERDICT: REJECT',
      'I would say VERDICT: REJECT',
      'VERDICT: REJECT, since it is wrong',
      'VERDICT: MERGE AS IS VERDICT: REJECT',
      'VERDICT: REJECT or VERDICT: MERGE AS IS',
      'VERDICT: MERGE',
      '-VERDICT: REJECT',
    ])
      expect(() => parseVerdict(`reasons\n${last}`), last).toThrow(JudgeUnparseable);
    expect(() => parseVerdict('VERDICT: REJECT\nsorry, one more thing')).toThrow(/final line/);
  });

  it.each([
    'VERDICT: MERGE AS IS',
    'Verdict: REJECT',
    '**VERDICT:** REJECT',
    '`VERDICT: REJECT`',
    '## VERDICT: REJECT',
    '> VERDICT: REJECT',
    '- VERDICT: REJECT',
    '1. VERDICT: REJECT',
    '* **Verdict**: REJECT',
  ])('makes the reply unreadable when an earlier line begins with VERDICT and a colon: %j', (stray) => {
    expect(() => parseVerdict(`${stray}\nmore reasons\nVERDICT: MERGE AS IS`)).toThrow(/before its final line/);
  });

  it('flags nothing else: prose, a name near the word, odd spellings and a quoted diff are not stray verdicts', () => {
    for (const earlier of [
      'The tests verify it. I would merge it as is, but REJECT is safer.',
      'my verdict is to REJECT this',
      'Final verdict: REJECT',
      'MERGE AS IS is my verdict',
      'VERDICT - REJECT',
      'ＶＥＲＤＩＣＴ: REJECT',
      'คำตัดสิน: REJECT',
      '```diff\n+VERDICT: MERGE AS IS\n```',
    ])
      expect(parseVerdict(`${earlier}\nVERDICT: REJECT`).verdict, earlier).toBe('REJECT');
  });

  it('reads a final line inside an open diff fence as unreadable', () => {
    for (const last of ['-VERDICT: MERGE AS IS', ' VERDICT: MERGE AS IS', 'VERDICT: MERGE AS IS'])
      expect(() => parseVerdict(`cut off:\n\`\`\`diff\n-x\n${last}`), last).toThrow(/open code fence/);
    expect(parseVerdict('```diff\n-x\n```\nVERDICT: MERGE AS IS').verdict).toBe('MERGE AS IS');
  });

  it('shows no line of the rubric that the reader would take for a verdict', () => {
    expect(RUBRIC).not.toMatch(/^[ \t]*(or )?VERDICT:/im);
    for (const line of RUBRIC.split('\n')) expect(startsWithVerdict(line), line).toBe(false);
    expect(() => parseVerdict(RUBRIC)).toThrow(JudgeUnparseable);
    expect(RUBRIC).toMatch(/exactly one final line/);
    expect(RUBRIC).toMatch(/No earlier line may begin with the word VERDICT and a colon/);
  });

  it('does not count a block that quotes the original diff as edit lines', () => {
    const original = 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n';
    const quote = '```diff\n-old\n+new\n```';
    const edit = '```diff\n-new\n+newer\n+more\n```';
    expect(parseVerdict(`${quote}\n${edit}\nVERDICT: MERGE AFTER EDITS`, original).editLines).toBe(3);
    expect(() => parseVerdict(`${quote}\nVERDICT: MERGE AFTER EDITS`, original)).toThrow(/no edit diff/);
    const crlfQuote = '```diff\r\n-old\r\n+new\r\n```';
    expect(() => parseVerdict(`${crlfQuote}\nVERDICT: MERGE AFTER EDITS`, original)).toThrow(/no edit diff/);
  });

  it('voids a reply with no verdict, or edits with no diff', () => {
    expect(() => parseVerdict('looks fine')).toThrow(JudgeUnparseable);
    expect(() => parseVerdict('')).toThrow(JudgeUnparseable);
    expect(() => parseVerdict('VERDICT: MERGE AFTER EDITS')).toThrow(/no edit diff/);
  });
});

const packet = (label: string, over: Partial<Packet> = {}): Packet => ({
  label,
  headSha: 'a'.repeat(40),
  issue: { title: 'issue title', body: 'issue body' },
  diff: 'diff --git a/x b/x\n+fix',
  ci: { sha: 'a'.repeat(40), state: 'green', note: 'all passed' },
  ...over,
});

describe('the judge packet', () => {
  it('shows the issue, the CI result and the diff, and nothing that names the arm or the PR', () => {
    const text = renderPrompt(packet('pr-12345678'));
    expect(text).toContain('issue body');
    expect(text).toContain('CI result: green');
    expect(text).toContain('+fix');
    expect(text).toContain('MERGE AFTER EDITS');
    expect(text).not.toContain('pr-12345678');
    expect(text).not.toContain('a'.repeat(40));
    expect(text).not.toMatch(/factory|baseline/i);
  });

  it('refuses a diff that holds a trailer or a session line, and an extra secret', () => {
    expect(armLeaks('Co-Authored-By: x')).toContain('a co-author trailer');
    expect(armLeaks('Claude-Session: https://x')).toContain('a session trailer');
    expect(armLeaks('a <noreply@anthropic.com>')).toContain('the agent mail address');
    expect(armLeaks('Generated with [Claude Code](x)')).toContain('a generated-by line');
    expect(armLeaks('plain diff +fix')).toEqual([]);
    expect(() => buildPacket(packet('pr-1', { diff: '+ // aw/f1/t1' }), ['aw/f1/t1'])).toThrow(/show the arm/);
    expect(() => buildPacket(packet('pr-1', { issue: { title: 't', body: 'see PR #4242' } }), ['#4242'])).toThrow(
      /show the arm/,
    );
    expect(buildPacket(packet('pr-1'))).toMatchObject({ label: 'pr-1' });
  });

  it('judges an honest diff whose tests only look like branch names, and refuses the PR own branch', () => {
    const honest =
      "+    expect(namesOf('bench/t-0a1b2c3d-r1000').work).toBe('aw/bench/t-0a1b2c3d-r1000');\n+ 'aw/alpha/t1'";
    expect(buildPacket(packet('pr-1', { diff: honest }), ['aw/f9/t-99999999-r1', 't-99999999'])).toMatchObject({
      label: 'pr-1',
    });
    expect(() => buildPacket(packet('pr-1', { diff: honest }), ['aw/alpha/t1'])).toThrow(/aw\/alpha\/t1/);
  });

  it('turns a leak into an unreadable record for that packet alone', () => {
    const made = packetOrUnreadable(packet('pr-9', { diff: '+ aw/f1/t1' }), ['aw/f1/t1']);
    expect(isUnreadable(made)).toBe(true);
    expect(made).toMatchObject({ label: 'pr-9', reason: expect.stringMatching(/^unreadable by leak/) });
    expect(isUnreadable(packetOrUnreadable(packet('pr-8'), ['aw/f1/t1']))).toBe(false);
  });
});

const model =
  (verdicts: Record<string, string>) =>
  async (prompt: string): Promise<string> => {
    const hit = Object.keys(verdicts).find((k) => prompt.includes(k));
    return `reasons\nVERDICT: ${hit === undefined ? 'REJECT' : verdicts[hit]}`;
  };

describe('judge calibration', () => {
  const real = [packet('pr-aaaa0001', { diff: '+real-one' }), packet('pr-aaaa0002', { diff: '+real-two' })];
  const seeded = [packet('pr-bbbb0001', { diff: '+seed-one' }), packet('pr-bbbb0002', { diff: '+seed-two' })];

  it('returns the real judgements and drops the seeded ones when both are rejected', async () => {
    const run = await runJudge(model({ 'real-one': 'MERGE AS IS' }), real, seeded);
    expect(run.voided).toBeNull();
    expect(run.judged.map((j) => [j.label, j.verdict])).toEqual([
      ['pr-aaaa0001', 'MERGE AS IS'],
      ['pr-aaaa0002', 'REJECT'],
    ]);
  });

  it.each(['seed-one', 'seed-two'])('voids the whole run when the judge passes the seeded PR %s', async (hit) => {
    const run = await runJudge(model({ [hit]: 'MERGE AS IS', 'real-one': 'MERGE AS IS' }), real, seeded);
    expect(run.voided).toMatch(/did not reject 1 seeded-bad/);
    expect(run.judged).toEqual([]);
  });

  it('voids on MERGE AFTER EDITS for a seeded PR too, since no machine decides whether the edit repairs it', async () => {
    const edit = (p: string) =>
      p.includes('seed-one') ? '```diff\n-a\n+b\n```\nVERDICT: MERGE AFTER EDITS' : 'VERDICT: REJECT';
    const run = await runJudge(async (p) => edit(p), real, seeded);
    expect(run.voided).toMatch(/pr-bbbb0001 \(MERGE AFTER EDITS\)/);
  });

  it('carries the unreadable real packets through the run and surfaces them', async () => {
    const lost = [{ label: 'pr-aaaa0003', reason: 'unreadable by leak: x' }];
    const run = await runJudge(model({}), real, seeded, Date, lost);
    expect(run.unreadable).toEqual(lost);
    expect(run.judged).toHaveLength(2);
    const dup = [{ label: 'pr-aaaa0001', reason: 'x' }];
    await expect(runJudge(model({}), real, seeded, Date, dup)).rejects.toThrow(/share a label/);
  });

  it('passes the packet diff to the verdict reader so a quoted diff is not an edit', async () => {
    const reply = '```diff\n+real-one\n```\nVERDICT: MERGE AFTER EDITS';
    await expect(judgeOne(async () => reply, packet('pr-q', { diff: '+real-one' }))).rejects.toThrow(/no edit diff/);
  });

  it('voids when a seeded reply cannot be read even after the reruns', async () => {
    let calls = 0;
    const garbled = async (p: string) => {
      if (p.includes('seed-two')) calls += 1;
      return p.includes('seed-two') ? 'no verdict' : 'VERDICT: REJECT';
    };
    expect((await runJudge(garbled, real, seeded)).voided).toMatch(/could not be read.*3 attempts/);
    expect(calls).toBe(MAX_ATTEMPTS);
  });

  it('records an unreadable real reply per packet, keeps the other verdicts, and caps the reruns', async () => {
    const counts: Record<string, number> = {};
    const real2 = async (p: string) => {
      const key = p.includes('real-two') ? 'two' : 'other';
      counts[key] = (counts[key] ?? 0) + 1;
      return p.includes('real-two') ? 'no verdict' : 'VERDICT: REJECT';
    };
    const run = await runJudge(real2, real, seeded);
    expect(run.voided).toBeNull();
    expect(run.judged.map((j) => j.label)).toEqual(['pr-aaaa0001']);
    expect(run.unreadable).toEqual([
      {
        label: 'pr-aaaa0002',
        reason: expect.stringMatching(/^unreadable by judge: 3 attempts failed.*no VERDICT|final line/),
        attempts: 3,
      },
    ]);
    expect(counts.two).toBe(MAX_ATTEMPTS);
  });

  it('records a failed judge call per packet instead of dropping the batch, and reruns once it recovers', async () => {
    let seen = 0;
    const flaky = async (p: string) => {
      if (p.includes('real-one')) throw new TaskRefused('the judge call failed: boom');
      if (p.includes('real-two')) {
        seen += 1;
        if (seen < 3) throw new TaskRefused('timeout');
      }
      return 'VERDICT: REJECT';
    };
    const run = await runJudge(flaky, real, seeded);
    expect(run.unreadable).toMatchObject([{ label: 'pr-aaaa0001', reason: expect.stringContaining('boom') }]);
    expect(run.judged).toMatchObject([{ label: 'pr-aaaa0002', attempts: 3 }]);
  });

  it('ends the run after MAX_VOIDS voided judge runs', () => {
    const file = join(tempDir('setb-voids'), 'voids', 'x.jsonl');
    expect(() => refuseAfterVoids(file)).not.toThrow();
    for (let i = 1; i < MAX_VOIDS; i += 1) {
      expect(recordVoid(file, 'x')).toBe(i);
      expect(() => refuseAfterVoids(file)).not.toThrow();
    }
    recordVoid(file, 'last');
    expect(() => refuseAfterVoids(file)).toThrow(/not run again/);
  });

  it('counts the larger of the log and the voided out files, and ignores other json', () => {
    const dir = tempDir('setb-voids2');
    const file = join(dir, 'voids', 'x.jsonl');
    const voided = '{"voided":"v","judged":[],"unreadable":[]}';
    for (const n of ['a', 'b']) writeFileSync(join(dir, `${n}.json`), voided);
    writeFileSync(join(dir, 'ok.json'), '{"voided":null,"judged":[],"unreadable":[]}');
    writeFileSync(join(dir, 'key.json'), '[]');
    writeFileSync(join(dir, 'junk.json'), 'not json');
    expect(countVoids(file)).toBe(2);
    expect(() => refuseAfterVoids(file)).not.toThrow();
    recordVoid(file, 'one');
    expect(countVoids(file)).toBe(2);
    writeFileSync(join(dir, 'c.json'), voided);
    expect(() => refuseAfterVoids(file)).toThrow(/not run again/);
    expect(() => refuseAfterVoids(join(tempDir('setb-v3'), 'v', 'y.jsonl'), [dir])).toThrow(/3 judge runs/);
  });

  it('treats an empty reply with exit 0 as a failed call, which is not an unreadable reply', async () => {
    let n = 0;
    const blank = async (p: string) => {
      if (!p.includes('real-one')) return 'VERDICT: REJECT';
      n += 1;
      return n === 1 ? '  \n' : 'VERDICT: MERGE AS IS';
    };
    const run = await runJudge(blank, real, seeded);
    expect(run.judged[0]).toMatchObject({ label: 'pr-aaaa0001', verdict: 'MERGE AS IS', attempts: 2 });
    await expect(judgeOne(async () => '', packet('pr-e'))).rejects.toBeInstanceOf(TaskRefused);
  });

  it('grades a packet that reached MERGE AS IS only after an unreadable reply as a fail, with its attempts', async () => {
    let n = 0;
    const retry = async (p: string) => {
      if (!p.includes('real-one')) return 'VERDICT: REJECT';
      n += 1;
      return n === 1 ? 'MERGE AFTER EDITS, no diff\nVERDICT: MERGE AFTER EDITS' : 'VERDICT: MERGE AS IS';
    };
    const run = await runJudge(retry, real, seeded);
    expect(run.voided).toBeNull();
    expect(run.judged.map((j) => j.label)).toEqual(['pr-aaaa0002']);
    expect(run.unreadable).toEqual([
      {
        label: 'pr-aaaa0001',
        reason: expect.stringMatching(/only after an unreadable reply.*2 attempts/),
        attempts: 2,
      },
    ]);
  });

  it('keeps a MERGE AS IS after a failed call, which had no reply to be biased by', async () => {
    let n = 0;
    const flaky = async (p: string) => {
      if (!p.includes('real-one')) return 'VERDICT: REJECT';
      n += 1;
      if (n === 1) throw new TaskRefused('timeout');
      return 'VERDICT: MERGE AS IS';
    };
    const run = await runJudge(flaky, real, seeded);
    expect(run.judged[0]).toMatchObject({ label: 'pr-aaaa0001', verdict: 'MERGE AS IS', attempts: 2 });
  });

  it('records a non-Error throw by its text', async () => {
    const odd = async (p: string): Promise<string> => {
      if (p.includes('real-one')) throw 'plain string failure';
      return 'VERDICT: REJECT';
    };
    const run = await runJudge(odd, real, seeded);
    expect(run.unreadable[0]?.reason).toContain('plain string failure');
  });

  it('needs exactly the seeded count and distinct labels', async () => {
    expect(CALIBRATION_SIZE).toBe(2);
    await expect(runJudge(model({}), real, seeded.slice(0, 1))).rejects.toThrow(TaskRefused);
    await expect(runJudge(model({}), real, [seeded[0] as Packet, { ...(seeded[0] as Packet) }])).rejects.toThrow(
      /share a label/,
    );
  });

  it('judges each packet in its own call and times it in minutes', async () => {
    let t = 0;
    const clock = { now: () => (t += 90_000) };
    const calls: string[] = [];
    const j = await judgeOne(
      async (p) => {
        calls.push(p);
        return 'VERDICT: MERGE AS IS';
      },
      real[0] as Packet,
      clock,
    );
    expect(calls).toHaveLength(1);
    expect(j.judgeMinutes).toBe(1.5);
    expect(j.headSha).toBe('a'.repeat(40));
  });

  it('runs the judge with no tools, on opus xhigh, and keeps no session', () => {
    const args = claudeArgs({});
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'opus']);
    expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', 'xhigh']);
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', '']);
    expect(args).toContain('--no-session-persistence');
  });

  it('ships two seeded-bad PRs that read like real ones: the task issue text, a ciFrom note, a diff git applies', () => {
    const seeds = JSON.parse(readFileSync(join(SETB, 'calibration', 'seeded.json'), 'utf8')) as Seed[];
    expect(seeds).toHaveLength(CALIBRATION_SIZE);
    const list = loadFrozen(SETB);
    const key = assignLabels(
      seeds.map((s, i) => ({ task: s.task, arm: 'seeded' as const, pr: -(i + 1), readyHeadSha: 'c'.repeat(40) })),
    );
    const made = seededPackets(seeds, key, list);
    for (const [i, p] of made.entries()) {
      const seed = seeds.find((s) => key.find((k) => k.label === p.label)?.entry.task === s.task) as Seed;
      const task = list.tasks.find((t) => t.id === seed.task);
      expect(p.issue).toEqual({ title: task?.title, body: task?.body });
      expect(p.ci).toEqual(
        ciFrom(
          'c'.repeat(40),
          Array.from({ length: seed.checks }, () => ({
            head_sha: 'c'.repeat(40),
            status: 'completed',
            conclusion: 'success',
          })),
        ),
      );
      expect(seed.checks, 'the check count of a green head of main').toBe(18);
      expect(p.ci.note).toBe('18 checks passed or were skipped');
      expect(p.issue.title, String(i)).not.toMatch(/^#\d/);
      expect(armLeaks(p.diff)).toEqual([]);
    }
  });

  it('ships seeded diffs that git apply --check accepts on a checkout of the frozen base', () => {
    const seeds = JSON.parse(readFileSync(join(SETB, 'calibration', 'seeded.json'), 'utf8')) as Seed[];
    const frozen = loadFrozen(SETB).frozenAtSha;
    const base = frozenBaseRepo(ROOT, frozen, realGit, () => tempDir('setb-base'));
    for (const seed of seeds) {
      const dir = tempDir('setb-seed');
      const files = [...seed.diff.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1] as string);
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        mkdirSync(dirname(join(dir, f)), { recursive: true });
        writeFileSync(join(dir, f), execFileSync('git', ['show', `${frozen}:${f}`], { cwd: base }));
      }
      writeFileSync(join(dir, 'seed.patch'), seed.diff);
      const ran = spawnSync('git', ['apply', '--check', 'seed.patch'], { cwd: dir, encoding: 'utf8' });
      expect(ran.stderr, seed.task).toBe('');
      expect(ran.status, seed.task).toBe(0);
    }
  });
});

describe('the frozen base check', () => {
  const ok = (stdout = ''): GitRun => ({ status: 0, stdout, stderr: '' });
  const no: GitRun = { status: 128, stdout: '', stderr: 'boom' };
  const script =
    (fails: string): Git =>
    (_cwd, args) =>
      args[0] === fails ? no : ok('file:///origin\n');

  it('uses the clone itself when it has the frozen commit, and fetches nothing', () => {
    const seen: string[] = [];
    const git: Git = (_cwd, args) => {
      seen.push(args[0] ?? '');
      return ok();
    };
    expect(frozenBaseRepo('/r', 'abc', git, () => '/tmp/x')).toBe('/r');
    expect(seen).toEqual(['cat-file']);
  });

  const fetched = (env: Record<string, string>, origin: string, up: (cwd: string) => GitRun = () => no) => {
    const calls: string[] = [];
    const git: Git = (cwd, args) => {
      calls.push(`${args.join(' ')}`);
      if (args[0] === 'cat-file') return no;
      if (args[0] === 'remote') return cwd === '/r' ? ok(`${origin}\n`) : up(cwd);
      return args[0] === 'fetch' && /\bbad\b/.test(args.join(' ')) ? no : ok();
    };
    return { git, calls, run: () => frozenBaseRepo('/r', 'abc', git, () => '/tmp/x', env) };
  };

  it('fetches the frozen commit at depth 1 from a remote origin into a scratch repo', () => {
    const t = fetched({}, 'https://github.com/o/r.git');
    expect(t.run()).toBe('/tmp/x');
    expect(t.calls).toContain('fetch -q --depth=1 https://github.com/o/r.git abc');
    expect(t.calls.filter((c) => c.startsWith('fetch'))).toHaveLength(1);
  });

  it('fetches from the public repository when origin is a local clone of a shallow checkout', () => {
    const env = { GITHUB_SERVER_URL: 'https://github.com/', GITHUB_REPOSITORY: 'FiatFour/ai-office' };
    const t = fetched(env, '/work/shallow');
    expect(t.run()).toBe('/tmp/x');
    expect(t.calls.filter((c) => c.startsWith('fetch'))).toEqual([
      'fetch -q --depth=1 https://github.com/FiatFour/ai-office.git abc',
    ]);
  });

  it('falls back to the origin of a local origin, then to the origin itself, and tries AW_FROZEN_REMOTE alone', () => {
    const chain = fetched({}, '/work/shallow', (cwd) => (cwd === '/work/shallow' ? ok('file:///wt\n') : no));
    expect(chain.run()).toBe('/tmp/x');
    expect(chain.calls.filter((c) => c.startsWith('fetch'))[0]).toBe('fetch -q --depth=1 file:///wt abc');
    const forced = fetched({ AW_FROZEN_REMOTE: 'https://example.test/x.git' }, '/work/shallow');
    expect(forced.run()).toBe('/tmp/x');
    expect(forced.calls.filter((c) => c.startsWith('fetch'))).toEqual([
      'fetch -q --depth=1 https://example.test/x.git abc',
    ]);
    const refused = fetched({ AW_FROZEN_REMOTE: 'bad' }, '/work/shallow');
    expect(() => refused.run()).toThrow(/git fetch failed: bad:/);
  });

  it('fails loudly, naming every remote it tried, when none serves the commit', () => {
    const env = { GITHUB_SERVER_URL: 'https://bad', GITHUB_REPOSITORY: 'o/bad' };
    const t = fetched(env, '/bad/local');
    expect(() => t.run()).toThrow(/git fetch failed: https:\/\/bad\/o\/bad\.git: boom; \/bad\/local: boom/);
  });

  it('fails loudly when the fetch fails, and never falls back to the working tree', () => {
    const git: Git = (_cwd, args) => (args[0] === 'cat-file' || args[0] === 'fetch' ? no : ok('u'));
    expect(() => frozenBaseRepo('/r', 'abc', git, () => '/tmp/x', {})).toThrow(/git fetch failed: u: boom/);
    expect(() =>
      frozenBaseRepo(
        '/r',
        'abc',
        (_c, a) => (a[0] === 'init' ? no : script('cat-file')(_c, a)),
        () => '/t',
        {},
      ),
    ).toThrow(/git init failed/);
    const noOrigin: Git = (_cwd, args) => (args[0] === 'cat-file' || args[0] === 'remote' ? no : ok());
    expect(() => frozenBaseRepo('/r', 'abc', noOrigin, () => '/tmp/x', {})).toThrow(/no origin/);
  });

  it('works in a clone of a shallow clone, as the CI perf job makes it', () => {
    const upstream = tempDir('setb-up');
    const g = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
    g(upstream, 'init', '-q');
    writeFileSync(join(upstream, 'a'), '1');
    g(upstream, 'add', '.');
    g(upstream, 'commit', '-qm', 'one');
    const frozen = g(upstream, 'rev-parse', 'HEAD');
    writeFileSync(join(upstream, 'a'), '2');
    g(upstream, 'commit', '-qam', 'two');
    const shallow = join(tempDir('setb-sh'), 'shallow');
    const second = join(tempDir('setb-sh2'), 'second');
    g(upstream, 'clone', '-q', '--depth=1', pathToFileURL(upstream).href, shallow);
    g(upstream, 'clone', '-q', '--no-hardlinks', shallow, second);
    expect(realGit(second, ['cat-file', '-e', `${frozen}^{commit}`]).status).not.toBe(0);
    expect(() => frozenBaseRepo(second, frozen, realGit, () => tempDir('setb-f1'), {})).not.toThrow();
    const got = frozenBaseRepo(second, frozen, realGit, () => tempDir('setb-f2'), {});
    expect(g(got, 'cat-file', '-t', frozen)).toBe('commit');
    rmSync(upstream, { recursive: true, force: true });
    expect(() => frozenBaseRepo(second, frozen, realGit, () => tempDir('setb-f3'), {})).toThrow(/git fetch failed/);
  });

  it('seeds a PR that removes the case it breaks, so it stays CI green on the base', () => {
    const seeds = JSON.parse(readFileSync(join(SETB, 'calibration', 'seeded.json'), 'utf8')) as Seed[];
    expect(seeds[0]?.diff).toMatch(/^-\s+\['C:\/x\.js'\],$/m);
  });
});

describe('Set B outcome', () => {
  const READY = 'a'.repeat(40);
  const grading = (over: Partial<Grading> = {}): Grading => ({
    entry: { task: 't1', arm: 'factory', pr: 7, readyHeadSha: READY },
    judged: { label: 'pr-1', verdict: 'MERGE AS IS', editLines: 0, headSha: READY, judgeMinutes: 2 },
    pull: { head: { sha: READY } },
    ci: { sha: READY, state: 'green', note: '' },
    paths: ['src/a.ts'],
    wallMs: 1000,
    tokens: { input: 100, output: 100, cacheRead: 0, cacheCreation: 0 },
    operatorMinutes: 0,
    rootMinutes: 3,
    calibration: { tokensPerWindow: 1000, source: 'test' },
    ...over,
  });

  it('records the judge calls in the graded row note and in judgeAttempts', () => {
    const row = gradeSetB(grading({ judged: { ...(grading().judged as Judged), attempts: 3 } }));
    expect(row.note).toMatch(/\(judge calls: 3\)$/);
    expect(row.judgeAttempts).toBe(3);
    expect(gradeSetB(grading()).note).not.toMatch(/judge calls/);
  });

  it('passes on green CI and MERGE AS IS at the ready head, and records minutes and edit lines', () => {
    expect(gradeSetB(grading())).toMatchObject({
      set: 'B',
      arm: 'factory',
      outcome: 'pass',
      editLines: 0,
      judgeMinutes: 2,
      rootMinutes: 3,
      humanMinutes: 0,
      inferredWindows: 0.2,
      quotaWindows: null,
    });
  });

  it('records the arm of a baseline PR', () => {
    expect(gradeSetB(grading({ entry: { task: 't1', arm: 'baseline', pr: 8, readyHeadSha: READY } })).arm).toBe(
      'baseline',
    );
  });

  const MOVED = 'b'.repeat(40);
  it.each<[string, Partial<Grading>, RegExp]>([
    ['a head that moved', { pull: { head: { sha: MOVED } } }, /head moved/],
    ['a judgement of another head', { judged: { ...grading().judged, headSha: MOVED } }, /judged bbbbbbb/],
    ['CI read at another head', { ci: { sha: MOVED, state: 'green', note: '' } }, /CI read at bbbbbbb/],
    ['red CI', { ci: { sha: READY, state: 'red', note: '1 of 3' } }, /CI red/],
    ['pending CI', { ci: { sha: READY, state: 'pending', note: '' } }, /CI pending/],
    ['no CI', { ci: { sha: READY, state: 'none', note: '' } }, /CI none/],
    ['a reject', { judged: { ...grading().judged, verdict: 'REJECT' } }, /judge rejects/],
    ['a workflow edit', { paths: ['src/a.ts', '.github/workflows/ci.yml'] }, /touches \.github/],
  ])('fails on %s', (_name, over, why) => {
    const row = gradeSetB(grading(over));
    expect(row.outcome).toBe('fail');
    expect(row.note).toMatch(why);
  });

  it('fails MERGE AFTER EDITS and records its edit lines', () => {
    const row = gradeSetB(grading({ judged: { ...grading().judged, verdict: 'MERGE AFTER EDITS', editLines: 5 } }));
    expect(row).toMatchObject({ outcome: 'fail', editLines: 5 });
    expect(row.note).toMatch(/edits \(5 lines\)/);
  });

  it('reads check runs: skipped alone is not green, pending is not green, any bad conclusion is red', () => {
    const r = (status: string, conclusion: string | null, head_sha = READY) => ({ head_sha, status, conclusion });
    expect(ciFrom(READY, []).state).toBe('none');
    expect(ciFrom(READY, [r('completed', 'success'), r('completed', 'skipped')]).state).toBe('green');
    expect(ciFrom(READY, [r('completed', 'skipped')]).state).toBe('none');
    expect(ciFrom(READY, [r('completed', 'success'), r('in_progress', null)]).state).toBe('pending');
    for (const c of ['failure', 'cancelled', 'timed_out', 'action_required'])
      expect(ciFrom(READY, [r('completed', 'success'), r('completed', c)]).state).toBe('red');
    expect(ciFrom(READY, [r('completed', null)]).state).toBe('red');
  });

  it('takes the CI sha from the runs, not from the sha it asked about', () => {
    const r = (head_sha: string) => ({ head_sha, status: 'completed', conclusion: 'success' });
    expect(ciFrom(READY, [r('b'.repeat(40))]).sha).toBe('b'.repeat(40));
    expect(ciFrom(READY, [r(READY), r('b'.repeat(40))]).sha).toBe('mixed');
    const stale = ciFrom(READY, [r('b'.repeat(40))]);
    const row = gradeSetB(grading({ ci: stale }));
    expect(row.outcome).toBe('fail');
    expect(row.note).toMatch(/CI read at bbbbbbb/);
  });

  it('grades a PR the judge could not read as a fail and says why', () => {
    const row = gradeSetB(grading({ judged: { label: 'pr-1', reason: 'unreadable by leak: x' } }));
    expect(row).toMatchObject({ outcome: 'fail', editLines: 0, judgeMinutes: null });
    expect(row.note).toMatch(/could not read it \(unreadable by leak/);
  });

  it('reads every page of the PR file list and both names of a rename', async () => {
    const page = (n: number) =>
      Array.from({ length: n === 1 ? PAGE : 1 }, (_, i) => ({
        filename: n === 1 ? `src/f${i}.ts` : '.github/workflows/late.yml',
      }));
    const paths = await readPaths(async (n) => page(n));
    expect(paths).toHaveLength(PAGE + 1);
    expect(gradeSetB(grading({ paths })).note).toMatch(/touches \.github/);
    expect(
      await readPaths(async () => [{ filename: 'src/new.ts', previous_filename: '.github/workflows/old.yml' }]),
    ).toEqual(['src/new.ts', '.github/workflows/old.yml']);
  });

  it('infers windows only from a measured calibration window', () => {
    const tokens = { input: 500, output: 0, cacheRead: 0, cacheCreation: 0 };
    expect(inferWindows(tokens, { tokensPerWindow: 2000, source: '' })).toBe(0.25);
    expect(inferWindows(tokens, { tokensPerWindow: null, source: '' })).toBeNull();
    expect(inferWindows(null, { tokensPerWindow: 2000, source: '' })).toBeNull();
    expect(readWindow(join(SETB, 'window.json')).tokensPerWindow).toBeNull();
    const dir = tempDir('setb-window');
    writeFileSync(join(dir, 'w.json'), '{"tokensPerWindow": 0}');
    expect(() => readWindow(join(dir, 'w.json'))).toThrow(/positive/);
  });
});

describe('the packet is built from the PR at the ready head and the frozen task', () => {
  const READY = 'a'.repeat(40);
  const calls: string[] = [];
  const hub = (over: Partial<Hub> = {}): Hub => ({
    pull: async () => ({
      head: { sha: 'f'.repeat(40), ref: 'aw/f1/t-0123abcd-r1' },
      base: { sha: 'e'.repeat(40) },
      labels: [{ name: 'agent-works:f1' }],
    }),
    diff: async (_r, base, head) => {
      calls.push(`${base}...${head}`);
      return 'diff --git a/x b/x\n+fix';
    },
    ci: async (_r, sha) => ({ sha, state: 'green', note: '3 checks passed or were skipped' }),
    ...over,
  });
  const task = loadFrozen(SETB).tasks[0] as ReturnType<typeof loadFrozen>['tasks'][number];
  const entry = { task: task.id, arm: 'factory' as const, pr: 5, readyHeadSha: READY };

  it('asks for the diff at the ready head even when the PR head has moved, and uses the task text', async () => {
    const made = await fetchPacket(hub(), 'FiatFour/ai-office', entry, 'pr-1', task);
    expect(calls).toEqual([`${'e'.repeat(40)}...${READY}`]);
    expect(made).toMatchObject({ headSha: READY, issue: { title: task.title, body: task.body }, ci: { sha: READY } });
  });

  it('takes the secrets from the PR itself: its branch, its ticket id and its labels', async () => {
    const pull = await hub().pull('r', 5);
    expect(secretsOf(pull)).toEqual(['aw/f1/t-0123abcd-r1', 't-0123abcd', 'agent-works:f1']);
    const leaky = hub({ diff: async () => 'diff --git a/x b/x\n+ // aw/f1/t-0123abcd-r1' });
    expect(isUnreadable(await fetchPacket(leaky, 'r', entry, 'pr-1', task))).toBe(true);
  });

  it('keeps a CI result of another head, so grading can see it', async () => {
    const stale = hub({ ci: async () => ({ sha: 'b'.repeat(40), state: 'green' as const, note: 'n' }) });
    expect(await fetchPacket(stale, 'r', entry, 'pr-1', task)).toMatchObject({ ci: { sha: 'b'.repeat(40) } });
  });
});

describe('one bad packet does not kill the batch', () => {
  const frozen = loadFrozen(SETB);
  const [t0, t1] = frozen.tasks as [(typeof frozen.tasks)[number], (typeof frozen.tasks)[number]];
  const entryFor = (task: string, pr: number) => ({ task, arm: 'factory' as const, pr, readyHeadSha: 'a'.repeat(40) });
  const sealed = [
    { label: 'pr-1111aaaa', entry: entryFor(t0.id, 1) },
    { label: 'pr-2222bbbb', entry: entryFor(t1.id, 2) },
  ];
  const okHub: Hub = {
    pull: async () => ({
      head: { sha: 'a'.repeat(40), ref: 'aw/x/t-0123abcd-r1' },
      base: { sha: 'e'.repeat(40) },
      labels: [],
    }),
    diff: async () => 'diff --git a/x b/x\n+fix',
    ci: async (_r, sha) => ({ sha, state: 'green', note: '3 checks passed or were skipped' }),
  };

  it('turns a gh failure on one packet into an unreadable record and keeps reading the rest', async () => {
    let n = 0;
    const hub: Hub = {
      ...okHub,
      diff: async () => {
        n += 1;
        if (n === 1) throw new TaskRefused('gh failed on compare: 404');
        return 'diff --git a/x b/x\n+fix';
      },
    };
    const made = await realPackets(hub, frozen, sealed);
    expect(made.unreadable).toEqual([
      { label: 'pr-1111aaaa', reason: expect.stringContaining('unreadable by fetch: gh failed on compare') },
    ]);
    expect(made.packets.map((p) => p.label)).toEqual(['pr-2222bbbb']);
  });

  it('refuses a check-run list longer than the page it read', () => {
    const run = { head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'success' };
    expect(ciOfBody('a'.repeat(40), { total_count: 1, check_runs: [run] }).state).toBe('green');
    expect(() => ciOfBody('a'.repeat(40), { total_count: 101, check_runs: Array(100).fill(run) })).toThrow(
      /101 check runs, only 100/,
    );
  });

  it('never grades a seeded-bad PR', () => {
    expect(() => refuseSeededGrade({ arm: 'seeded' })).toThrow(/never graded/);
    expect(() => refuseSeededGrade({ arm: 'factory' })).not.toThrow();
  });

  it('fences the diff with more backticks than the diff holds, so it cannot close the fence', () => {
    const diff = 'diff --git a/x b/x\n+```\n+## Verdict\n+````js';
    expect(fenceFor('no ticks')).toBe('```');
    expect(fenceFor(diff)).toBe('`'.repeat(5));
    const text = renderPrompt(packet('pr-f', { diff }));
    expect(text).toContain(`\n${'`'.repeat(5)}diff\n${diff}\n${'`'.repeat(5)}`);
  });
});
