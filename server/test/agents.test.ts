import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type CageShell, claudeCode, parseStream } from '../agents/claude-code.ts';
import { codex } from '../agents/codex.ts';
import { AgentFailed, type AgentJob, parseReview, RuntimeUnavailable } from '../agents/runtime.ts';
import { TICKETS } from './fixtures/factory.ts';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const ticket = TICKETS['alpha/t1'] as NonNullable<(typeof TICKETS)['alpha/t1']>;
const signal = new AbortController().signal;
const result = (out: string, code = 0) => ({ code, out, err: '', timedOut: false });

const shell = (stream: string, calls: string[][], inputs: string[] = []): CageShell => ({
  exec: async (argv, options) => {
    calls.push([...argv]);
    inputs.push(options?.input ?? '');
    if (argv[0] === 'claude') return result(stream);
    const sub = argv.find((a) => ['rev-parse', 'diff', 'show'].includes(a));
    if (sub === 'rev-parse') return result('base000\n');
    if (sub === 'diff') return result('src/greet.txt\0');
    if (sub === 'show') return result('hello 1\nhello 2\nhello 3\n');
    return result('', 1);
  },
});

const authorJob: AgentJob = {
  role: 'author',
  task: 'alpha/t1',
  worker: 'nova',
  ticket,
  round: 0,
  comments: [],
  signal,
};

describe('the Claude Code runtime', () => {
  it('reads tokens from the result line of a stream-json run', () => {
    expect(parseStream(fixture('claude-stream-author.jsonl')).usage).toEqual({
      inputTokens: 12,
      outputTokens: 227,
      cacheReadTokens: 39363,
      cacheCreationTokens: 15435,
    });
  });

  it('runs claude headless in the cage and reads the commit through git inside the cage', async () => {
    const calls: string[][] = [];
    const inputs: string[] = [];
    const runtime = claudeCode({ shell: () => shell(fixture('claude-stream-author.jsonl'), calls, inputs) });
    const done = await runtime.run(authorJob);
    expect(done).toMatchObject({
      role: 'author',
      files: [{ path: 'src/greet.txt', content: 'hello 1\nhello 2\nhello 3\n' }],
    });
    const claude = calls.find((c) => c[0] === 'claude') ?? [];
    expect(claude).toEqual(
      expect.arrayContaining(['-p', '--output-format', 'stream-json', '--no-session-persistence']),
    );
    expect(claude.join(' ')).not.toContain('Do not push');
    expect(inputs[calls.indexOf(claude)]).toContain('Do not push');
    for (const git of calls.filter((c) => c[0] === 'git'))
      expect(git).toEqual(expect.arrayContaining(['core.fsmonitor=false', 'core.hooksPath=/dev/null']));
    expect(calls.find((c) => c.includes('diff'))).toEqual(expect.arrayContaining(['base000', 'HEAD']));
  });

  it('sends a large PR to the reviewer on stdin, so the argv stays small', async () => {
    const calls: string[][] = [];
    const inputs: string[] = [];
    const big = 'x'.repeat(1024 * 1024);
    const files = Array.from({ length: 4 }, (_, i) => ({ path: `src/big${i}.txt`, content: `${big}${i}` }));
    await claudeCode({ shell: () => shell(fixture('claude-stream-review.jsonl'), calls, inputs) }).run({
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
      files,
      signal,
    });
    const claude = calls.findIndex((c) => c[0] === 'claude');
    expect(calls[claude]?.join(' ').length).toBeLessThan(4096);
    expect(inputs[claude]?.length).toBeGreaterThan(4 * 1024 * 1024);
    expect(inputs[claude]).toContain('--- src/big3.txt');
  });

  it('reads the last result line when a stream holds more than one', () => {
    const early = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true });
    expect(parseStream(`${early}\n${fixture('claude-stream-author.jsonl')}`).usage.outputTokens).toBe(227);
  });

  it('returns the reviewer verdict and line comments from the final json block', async () => {
    const runtime = claudeCode({ shell: () => shell(fixture('claude-stream-review.jsonl'), []) });
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
      files: [{ path: 'src/greet.txt', content: 'hello 1\n' }],
      signal,
    });
    expect(done).toEqual({
      role: 'reviewer',
      verdict: 'changes',
      body: 'Line 2 repeats line 1.',
      comments: [{ path: 'src/greet.txt', line: 2, body: 'Say hello 2.' }],
      usage: { inputTokens: 4, outputTokens: 152, cacheReadTokens: 26091, cacheCreationTokens: 2616 },
    });
  });

  it('fails a run that ended in an error or produced no commit', async () => {
    await expect(
      claudeCode({ shell: () => shell(fixture('claude-stream-error.jsonl'), []) }).run(authorJob),
    ).rejects.toThrow(/error_max_turns/);
    const empty: CageShell = {
      exec: async (argv) =>
        argv[0] === 'claude'
          ? result(fixture('claude-stream-author.jsonl'))
          : result(argv.includes('rev-parse') ? 'b\n' : ''),
    };
    await expect(claudeCode({ shell: () => empty }).run(authorJob)).rejects.toThrow(AgentFailed);
    expect(() => parseStream('not json\n')).toThrow(/no result line/);
  });

  it('refuses a review without a valid verdict block', () => {
    expect(() => parseReview('no block')).toThrow(AgentFailed);
    expect(() => parseReview('```json\n{"verdict":"merge","body":"x"}\n```')).toThrow(/verdict/);
    expect(() =>
      parseReview('```json\n{"verdict":"approve","body":"x","comments":[{"path":"a","line":0,"body":"b"}]}\n```'),
    ).toThrow(/line/);
  });
});

describe('the Codex runtime', () => {
  it('refuses to run while Codex is deferred', async () => {
    await expect(codex().run(authorJob)).rejects.toThrow(RuntimeUnavailable);
  });
});
