import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cageShells } from '../agents/cage-shell.ts';
import { type CageShell, claudeCode, parseStream } from '../agents/claude-code.ts';
import { codex } from '../agents/codex.ts';
import { AgentFailed, type AgentJob, parseReview, RuntimeUnavailable } from '../agents/runtime.ts';
import type { SandboxDriver } from '../sandbox/container.ts';
import { TICKETS } from './fixtures/factory.ts';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const ticket = TICKETS['alpha/t1'] as NonNullable<(typeof TICKETS)['alpha/t1']>;
const signal = new AbortController().signal;
const result = (out: string, code = 0) => ({ code, out, err: '', timedOut: false });

const shell = (
  stream: string,
  calls: string[][],
  inputs: string[] = [],
  diff = '3\t0\tsrc/greet.txt\0',
): CageShell => ({
  exec: async (argv, options) => {
    calls.push([...argv]);
    inputs.push(options?.input ?? '');
    if (argv[0] === 'claude') return result(stream);
    const sub = argv.find((a) => ['rev-parse', 'diff', 'show'].includes(a));
    if (sub === 'rev-parse') return result('base000\n');
    if (sub === 'diff') return result(diff);
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
      webRequests: 0,
    });
  });

  it('counts the server-side web searches and fetches of a run, from the usage and from the stream blocks', () => {
    const result = (usage: object) => JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', usage });
    const served = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'server_tool_use', name: 'web_search' }] },
    });
    expect(
      parseStream(result({ server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 } })).usage.webRequests,
    ).toBe(3);
    expect(parseStream(`${served}\n${served}\n${result({})}`).usage.webRequests).toBe(2);
    expect(parseStream(result({ input_tokens: 1 })).usage.webRequests).toBe(0);
  });

  it('keeps the provider message when claude reports an error result', () => {
    const raw = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'usage limit reached' });
    expect(() => parseStream(raw)).toThrow('claude ended with success: usage limit reached');
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
    expect(claude.slice(claude.indexOf('--disallowedTools'))[1]).toBe('WebSearch,WebFetch');
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

  it('never reads a binary file back as text, on either side of a review', async () => {
    const binary = shell(fixture('claude-stream-author.jsonl'), [], [], '3\t0\tsrc/greet.txt\0-\t-\tlogo.png\0');
    await expect(claudeCode({ shell: () => binary }).run(authorJob)).rejects.toThrow(/binary file logo.png/);
    const inputs: string[] = [];
    await claudeCode({ shell: () => shell(fixture('claude-stream-review.jsonl'), [], inputs) }).run({
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
      files: [
        { path: 'logo.png', content: null },
        { path: 'a.txt', content: 'text' },
      ],
      signal,
    });
    const prompt = inputs.find((i) => i.includes('logo.png')) ?? '';
    expect(prompt).toContain('--- logo.png (binary file, content not shown)');
    expect(prompt).toContain('--- a.txt\ntext');
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
      usage: { inputTokens: 4, outputTokens: 152, cacheReadTokens: 26091, cacheCreationTokens: 2616, webRequests: 0 },
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
  });

  it('keeps every comment the reviewer wrote, whatever its shape, and loses none to a throw', () => {
    const comments = [
      { path: 'a.ts', line: 3, body: 'inline' },
      { path: 'a.ts', body: 'whole file' },
      { path: 'a.ts', line: 0, body: 'zero line' },
      { path: 'a.ts', line: 1.5, body: 'fraction' },
      { path: 'a.ts', line: '4', body: 'string line' },
      { line: 7, body: 'no path' },
      { body: 'general' },
      { path: 'a.ts', line: 2 },
      { path: 'a.ts', line: 2, body: '  ' },
      null,
      '',
      {},
      'fix the regex',
      { comment: 'by comment', path: 'b.ts', line: 2 },
      { message: 'by message' },
      { text: 'by text' },
      [1, 2],
    ];
    const text = `\`\`\`json\n${JSON.stringify({ verdict: 'changes', comments })}\n\`\`\``;
    expect(parseReview(text)).toEqual({
      verdict: 'changes',
      body: '',
      comments: [
        { path: 'a.ts', line: 3, body: 'inline' },
        { path: 'a.ts', line: null, body: 'whole file' },
        { path: 'a.ts', line: null, body: 'zero line' },
        { path: 'a.ts', line: null, body: 'fraction' },
        { path: 'a.ts', line: 4, body: 'string line' },
        { path: null, line: 7, body: 'no path' },
        { path: null, line: null, body: 'general' },
        { path: null, line: null, body: '{"path":"a.ts","line":2}' },
        { path: null, line: null, body: '{"path":"a.ts","line":2,"body":"  "}' },
        { path: null, line: null, body: 'fix the regex' },
        { path: 'b.ts', line: 2, body: 'by comment' },
        { path: null, line: null, body: 'by message' },
        { path: null, line: null, body: 'by text' },
        { path: null, line: null, body: '[1,2]' },
      ],
    });
  });

  it('carries comments given as a string, an object or a lone comment instead of a list', () => {
    const verdict = (comments: unknown) =>
      parseReview(`\`\`\`json\n${JSON.stringify({ verdict: 'changes', comments })}\n\`\`\``);
    expect(verdict('fix it').comments).toEqual([{ path: null, line: null, body: 'fix it' }]);
    expect(verdict({ path: 'a.ts', line: 2, body: 'lone' }).comments).toEqual([
      { path: 'a.ts', line: 2, body: 'lone' },
    ]);
    expect(verdict({ 'a.ts': 'keyed' }).comments).toEqual([{ path: null, line: null, body: '{"a.ts":"keyed"}' }]);
    expect(verdict(undefined).comments).toEqual([]);
    expect(verdict([]).comments).toEqual([]);
  });

  it('keeps a changes verdict whose comments all lack a line', () => {
    const text = `\`\`\`json\n${JSON.stringify({ verdict: 'changes', body: 'b', comments: [{ path: 'a.ts', body: 'x' }, { body: 'y' }] })}\n\`\`\``;
    const review = parseReview(text);
    expect(review.verdict).toBe('changes');
    expect(review.comments.map((c) => c.line)).toEqual([null, null]);
  });

  it('finds the verdict block among other blocks, in any fence tag, with backticks inside a comment', () => {
    const verdict = {
      verdict: 'changes',
      body: 'b',
      comments: [{ path: 'a.ts', line: 1, body: 'use ```ts x``` here' }],
    };
    const quoted = '```json\n{"name":"pkg","version":"1.0.0"}\n```';
    for (const tag of ['json', 'JSON', '']) {
      const text = `Look at ${quoted}\nthen\n\`\`\`${tag}\n${JSON.stringify(verdict)}\n\`\`\`\nbye`;
      expect(parseReview(text), tag).toEqual({
        verdict: 'changes',
        body: 'b',
        comments: [{ path: 'a.ts', line: 1, body: 'use ```ts x``` here' }],
      });
    }
    expect(parseReview(`${JSON.stringify(verdict)} trailing`).verdict).toBe('changes');
    const two = (v: string) => `\`\`\`json\n{"verdict":"${v}"}\n\`\`\``;
    expect(parseReview(`${two('approve')}\n${two('changes')}`).verdict).toBe('changes');
    expect(parseReview(`${two('changes')}\n${quoted}`).verdict).toBe('changes');
  });

  it('lets changes win when verdict blocks disagree, in either order and with three blocks', () => {
    const block = (v: string, body = v) => `\`\`\`json\n${JSON.stringify({ verdict: v, body })}\n\`\`\``;
    expect(parseReview(`${block('changes')}\nExample:\n${block('approve')}`)).toMatchObject({
      verdict: 'changes',
      body: 'changes',
    });
    expect(parseReview(`${block('approve')}\n${block('changes')}`).verdict).toBe('changes');
    expect(parseReview(`${block('changes')}\n${block('comment')}\n${block('approve')}`).verdict).toBe('changes');
    expect(parseReview(`${block('approve')}\n${block('comment')}`).verdict).toBe('comment');
    expect(parseReview(`${block('changes', 'one')}\n${block('changes', 'two')}`).body).toBe('two');
  });

  it('carries a summary, a file name, a numeric string line and a body that is not a string', () => {
    const review = (o: object) => parseReview(`\`\`\`json\n${JSON.stringify({ verdict: 'changes', ...o })}\n\`\`\``);
    expect(review({ summary: 'the gist' }).body).toBe('the gist');
    expect(review({ body: 'main', summary: 'gist' }).body).toBe('main');
    expect(review({ body: '', summary: 'gist' }).body).toBe('gist');
    expect(review({ body: ['a', 'b'] }).body).toBe('["a","b"]');
    expect(review({ body: { x: 1 } }).body).toBe('{"x":1}');
    expect(review({ body: 7 }).body).toBe('7');
    expect(review({ comments: [{ file: 'a.ts', line: '2', body: 'x' }] }).comments).toEqual([
      { path: 'a.ts', line: 2, body: 'x' },
    ]);
    expect(review({ comments: [{ path: 'p.ts', file: 'f.ts', line: ' 5 ', body: 'x' }] }).comments).toEqual([
      { path: 'p.ts', line: 5, body: 'x' },
    ]);
    expect(review({ comments: [{ path: 'a.ts', line: '2x', body: 'x' }] }).comments[0]?.line).toBeNull();
    expect(review({ comments: [{ path: 'a.ts', line: '0', body: 'x' }] }).comments[0]?.line).toBeNull();
  });

  it('scans many broken fenced blocks in linear time and still finds the verdict after them', () => {
    const broken = '```json\n{"a": [1, 2,\n```\n'.repeat(20_000);
    const unclosed = '```json\n{"a": "x\n'.repeat(20_000);
    const real = '```json\n{"verdict":"changes","body":"ok"}\n```';
    const started = performance.now();
    expect(parseReview(`${broken}${unclosed}${real}`).verdict).toBe('changes');
    expect(parseReview(`${'```json\n{"a":{'.repeat(20_000)}\n${real}`).verdict).toBe('changes');
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('shows the start of the reviewer text when no verdict block exists', () => {
    const long = `${'x'.repeat(600)}`;
    const failure = (() => {
      try {
        parseReview(`I think it is fine ${long}`);
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    })();
    expect(failure).toContain('I think it is fine');
    expect(failure).not.toContain('x'.repeat(500));
    expect(() => parseReview('```json\n{"name":"pkg"}\n```')).toThrow(/"name":"pkg"/);
  });
});

describe('the Codex runtime', () => {
  it('refuses to run while Codex is deferred', async () => {
    await expect(codex().run(authorJob)).rejects.toThrow(RuntimeUnavailable);
  });
});

describe('the cage shell', () => {
  it('gives the author and the reviewer of one task separate cages, and reuses each', async () => {
    const started: Array<{ task: string; worker: string }> = [];
    const ran: string[] = [];
    const driver = {
      startCage: async (spec: { task: string; worker: string }) => {
        started.push(spec);
        return { id: `cage-${started.length}` };
      },
      exec: async (id: string) => {
        ran.push(id);
        return result('');
      },
    } as unknown as SandboxDriver;
    const shells = cageShells(async () => driver, '/src');
    await shells('nova', 'alpha/t1').exec(['true']);
    await shells('vega', 'alpha/t1').exec(['true']);
    await shells('nova', 'alpha/t1').exec(['true']);
    expect(started.map((s) => s.worker)).toEqual(['nova', 'vega']);
    expect(ran).toEqual(['cage-1', 'cage-2', 'cage-1']);
  });
});
