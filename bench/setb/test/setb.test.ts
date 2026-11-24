import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GitHost } from '../../../server/githost/host.ts';
import { tempDir } from '../../../server/test/helpers.ts';
import { TaskRefused } from '../../model.ts';
import { guardWorkflows, touchesWorkflows } from '../guard.ts';
import { CALIBRATION_SIZE, claudeArgs, judgeOne, runJudge } from '../judge.ts';
import { assignLabels, type Entry } from '../labels.ts';
import { ciFrom, type Grading, gradeSetB, inferWindows, readWindow } from '../outcome.ts';
import { ownerOf } from '../owned.ts';
import { armLeaks, buildPacket, type Packet, renderPrompt } from '../packet.ts';
import { JudgeUnparseable, parseVerdict } from '../rubric.ts';
import { loadFrozen, parseTaskList, SET_B_SIZE, SHA_FILE, shaOf, TASKS_FILE } from '../task.ts';

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

  it('refuses a push that touches .github before the host sees it, and passes any other', async () => {
    const pushed: string[][] = [];
    const host = {
      id: 'github',
      pushFiles: async (_r: string, spec: { files: readonly { path: string }[] }) => {
        pushed.push(spec.files.map((f) => f.path));
        return 'sha';
      },
    } as unknown as GitHost;
    const guarded = guardWorkflows(host);
    const spec = (...paths: string[]) => ({
      branch: 'b',
      base: 'main',
      message: 'm',
      files: paths.map((path) => ({ path, content: 'x' })),
    });
    await expect(guarded.pushFiles('r', spec('src/a.ts', '.github/workflows/x.yml'))).rejects.toThrow(
      /refused before push/,
    );
    expect(pushed).toEqual([]);
    await guarded.pushFiles('r', spec('src/a.ts'));
    expect(pushed).toEqual([['src/a.ts']]);
    expect(guarded.id).toBe('github');
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

  it('takes the strictest verdict when the reply disagrees with itself', () => {
    expect(parseVerdict('VERDICT: MERGE AS IS\nVERDICT: REJECT').verdict).toBe('REJECT');
    expect(parseVerdict('VERDICT: REJECT\nVERDICT: MERGE AS IS').verdict).toBe('REJECT');
    const edits = '```diff\n-a\n+b\n```';
    expect(parseVerdict(`${edits}\nVERDICT: MERGE AS IS\nVERDICT: MERGE AFTER EDITS`).verdict).toBe(
      'MERGE AFTER EDITS',
    );
  });

  it('does not read a quoted verdict inside prose', () => {
    expect(() => parseVerdict('I would say VERDICT: MERGE AS IS')).toThrow(JudgeUnparseable);
  });

  it('voids a reply with no verdict, or edits with no diff', () => {
    expect(() => parseVerdict('looks fine')).toThrow(JudgeUnparseable);
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

  it('refuses a packet whose diff names the branch, a label, a ticket id or an extra secret', () => {
    expect(armLeaks('see aw/bench/t-0123abcd-r1')).toContain('a branch name');
    expect(armLeaks('agent-works:fx')).toContain('an agent-works label');
    expect(armLeaks('bench/t-0123abcd')).toContain('a bench ticket id');
    expect(armLeaks('Co-Authored-By: x')).toContain('a co-author trailer');
    expect(armLeaks('plain diff +fix')).toEqual([]);
    expect(() => buildPacket(packet('pr-1', { diff: '+ // aw/f1/t1' }))).toThrow(/show the arm/);
    expect(() => buildPacket(packet('pr-1', { issue: { title: 't', body: 'see PR #4242' } }), ['#4242'])).toThrow(
      /show the arm/,
    );
    expect(buildPacket(packet('pr-1'))).toMatchObject({ label: 'pr-1' });
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
    expect(run.voided).toMatch(/passed 1 seeded-bad/);
    expect(run.judged).toEqual([]);
  });

  it('does not void on MERGE AFTER EDITS for a seeded PR, only on MERGE AS IS', async () => {
    const edit = (p: string) =>
      p.includes('seed-one') ? '```diff\n-a\n+b\n```\nVERDICT: MERGE AFTER EDITS' : 'VERDICT: REJECT';
    expect((await runJudge(async (p) => edit(p), real, seeded)).voided).toBeNull();
  });

  it('voids when a seeded reply cannot be read, and propagates an unreadable real one', async () => {
    const garbled = async (p: string) => (p.includes('seed-two') ? 'no verdict' : 'VERDICT: REJECT');
    expect((await runJudge(garbled, real, seeded)).voided).toMatch(/could not be read/);
    const real2 = async (p: string) => (p.includes('real-two') ? 'no verdict' : 'VERDICT: REJECT');
    await expect(runJudge(real2, real, seeded)).rejects.toThrow(JudgeUnparseable);
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

  it('ships two seeded-bad PRs whose diffs name no arm', () => {
    const seeds = JSON.parse(readFileSync(join(SETB, 'calibration', 'seeded.json'), 'utf8')) as { diff: string }[];
    expect(seeds).toHaveLength(CALIBRATION_SIZE);
    for (const s of seeds) expect(armLeaks(s.diff)).toEqual([]);
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
    const r = (status: string, conclusion: string | null) => ({ status, conclusion });
    expect(ciFrom(READY, []).state).toBe('none');
    expect(ciFrom(READY, [r('completed', 'success'), r('completed', 'skipped')]).state).toBe('green');
    expect(ciFrom(READY, [r('completed', 'skipped')]).state).toBe('none');
    expect(ciFrom(READY, [r('completed', 'success'), r('in_progress', null)]).state).toBe('pending');
    for (const c of ['failure', 'cancelled', 'timed_out', 'action_required'])
      expect(ciFrom(READY, [r('completed', 'success'), r('completed', c)]).state).toBe('red');
    expect(ciFrom(READY, [r('completed', null)]).state).toBe('red');
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
