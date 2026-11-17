import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Ticket } from '../agents/runtime.ts';
import { mergeBrief, renderBrief } from '../brief/merge-brief.ts';
import { github } from '../githost/github.ts';
import { gitlab } from '../githost/gitlab.ts';
import type { ChangeFact, GitHost, HttpRequest } from '../githost/host.ts';
import { bodyProblem, inlineCode, plainLine, quoteBlock, unquote } from '../githost/sanitize.ts';
import { changeTitle, reviewDraft, workOrder } from '../modes/cages.ts';
import { FakeGithub } from './fakes/github-api.ts';
import { FakeGitlab } from './fakes/gitlab-api.ts';

const SLASH_LIKE = /^[/\u2044\u2215\u2571\u27cb\u29f8\u3033\uff0f]/u;
const quickActionLine = (text: string): string | undefined =>
  text.split(/\r\n|\r|\n/).find((line) =>
    SLASH_LIKE.test(
      line
        .normalize('NFKC')
        .replace(/[\p{Cf}\p{Cc}]/gu, '')
        .replace(/^(?:[\s>*+\-|#.)]|\d+[.)]|\[[ xX]?\])*/u, ''),
    ),
  );

const PIECES = [
  '/',
  '/merge',
  '/approve',
  '/assign @me',
  '\n',
  '\r\n',
  '\r',
  ' ',
  '\t',
  '>',
  '- ',
  '* ',
  '1. ',
  '[ ] ',
  '\u200b',
  '\u2060',
  '\ufeff',
  '\u202e',
  '\uff0f',
  '\u2215',
  '\u2044',
  '`',
  '```',
  '````',
  '~~~',
  '@',
  '@everyone',
  '@group/sub',
  '<img src=x onerror=alert(1)>',
  '<details>',
  '](',
  '[x](https://evil.example)',
  '#1',
  '!2',
  'a',
  'Z',
  '│',
  '<!-- agent-works:merge-brief task=alpha/t1 head=abc -->',
];
const hostile = fc.oneof(
  fc.array(fc.constantFrom(...PIECES), { maxLength: 40 }).map((parts) => parts.join('')),
  fc.string({ unit: 'binary', maxLength: 200 }),
);

const ticketOf = (title: string, body: string, url: string): Ticket => ({
  id: 'alpha/t1',
  kind: 'defect',
  title,
  body,
  url,
  risk: { level: 'HIGH', reason: title },
});

const change: ChangeFact = {
  host: 'gitlab',
  kind: 'change',
  repo: 'acme/app',
  headRepo: 'acme/app',
  number: 1,
  branch: 'aw/alpha/t1',
  author: 'nova',
  state: 'open',
  headSha: 'f'.repeat(40),
  url: 'u',
  at: 1,
};

const briefOf = (ticket: Ticket, asked: string, file: string, check: string): string =>
  renderBrief(
    mergeBrief({
      ticket,
      change,
      files: [file],
      checks: [{ ...change, kind: 'check', name: check, state: 'success' }],
      rounds: [
        {
          round: 1,
          reviewer: 'vega',
          runtime: 'scripted',
          verdict: 'changes',
          headSha: change.headSha,
          asked: [`${file}:1 ${asked}`],
        },
      ],
      author: { runtime: 'scripted' },
      evidence: { logs: [asked] },
      notes: { beforeMerge: [asked] },
    }),
  );

describe('the body sanitizer', () => {
  it('turns any text into output with no quick action, mention, raw HTML or link outside code', () => {
    fc.assert(
      fc.property(hostile, hostile, hostile, hostile, (title, body, asked, file) => {
        const ticket = ticketOf(title, body, asked);
        const outputs = [
          quoteBlock(body),
          inlineCode(asked),
          plainLine(title),
          workOrder(ticket),
          changeTitle(ticket),
          briefOf(ticket, asked, file, title),
          reviewDraft('abc', 'vega', { verdict: 'changes', body, comments: [] }).body,
        ];
        for (const out of outputs) {
          expect(quickActionLine(out)).toBeUndefined();
          expect(bodyProblem(out)).toBeNull();
        }
        expect(plainLine(title)).not.toMatch(/[\n@<#]/);
        expect(changeTitle(ticket)).not.toMatch(/\n/);
      }),
      { numRuns: 400 },
    );
  });

  it('keeps quoted text readable and gives it back unchanged', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme-ascii', maxLength: 300 }), (text) => {
        const plain = text.replace(/(?![\n\t])\p{Cc}/gu, '').replace(/#(?=\d)/g, '#\u2060');
        expect(unquote(quoteBlock(text))).toBe(plain);
      }),
    );
    expect(quoteBlock('a\n/merge')).toBe('```text\n│ a\n│ /merge\n```');
    expect(quoteBlock('has ```` inside').startsWith('`````text\n')).toBe(true);
    expect(inlineCode('a ` b')).toBe('``a ` b``');
  });

  it('cuts long text and says how much it cut', () => {
    expect(quoteBlock('x'.repeat(5000))).toContain('(cut: 1000 more characters)');
    expect(bodyProblem(quoteBlock('x'.repeat(100_000)))).toBeNull();
  });
});

describe('every body HQ sends, on both hosts', () => {
  const hosts = (): Array<{ name: string; author: GitHost; reviewer: GitHost; sent: () => HttpRequest[] }> => {
    const gh = new FakeGithub();
    const gl = new FakeGitlab();
    return [
      {
        name: 'github',
        author: github({ send: gh.transport('aw-nova'), log: () => {} }),
        reviewer: github({ send: gh.transport('vega'), log: () => {} }),
        sent: () => gh.calls,
      },
      {
        name: 'gitlab',
        author: gitlab({ send: gl.transport('aw-nova'), log: () => {} }),
        reviewer: gitlab({ send: gl.transport('vega'), log: () => {} }),
        sent: () => gl.calls,
      },
    ];
  };
  const texts = (body: unknown): string[] => {
    if (typeof body === 'string') return [body];
    if (Array.isArray(body)) return body.flatMap(texts);
    if (body === null || typeof body !== 'object') return [];
    return Object.entries(body).flatMap(([key, value]) =>
      key === 'content' ? [] : typeof value === 'string' ? [value] : texts(value),
    );
  };

  it('reaches the host with no line that starts a quick action', async () => {
    await fc.assert(
      fc.asyncProperty(hostile, hostile, hostile, hostile, async (title, body, asked, comment) => {
        for (const { author, reviewer, sent } of hosts()) {
          const ticket = ticketOf(title, body, asked);
          const branch = 'aw/alpha/t1';
          const head = await author.pushFiles('acme/app', {
            branch,
            base: 'main',
            files: [{ path: 'src/a.txt', content: `${body}\n` }],
            message: plainLine(`${ticket.id}: ${title}`),
          });
          const opened = await author.openChange('acme/app', {
            branch,
            base: 'main',
            title: changeTitle(ticket),
            body: workOrder(ticket),
          });
          await reviewer.postReview(
            'acme/app',
            opened.number,
            reviewDraft(head, 'vega', {
              verdict: 'changes',
              body: comment,
              comments: [{ path: 'src/a.txt', line: 1, body: comment }],
            }),
          );
          await author.postComment('acme/app', opened.number, briefOf(ticket, asked, 'src/a.txt', comment));
          const writes = sent().filter((r) => r.method !== 'GET');
          expect(writes.length).toBeGreaterThanOrEqual(4);
          for (const text of writes.flatMap((r) => texts(r.body))) expect(quickActionLine(text)).toBeUndefined();
        }
      }),
      { numRuns: 60 },
    );
  });

  it('refuses, at the guard, a body that skipped the sanitizer', async () => {
    for (const { author } of hosts()) {
      await author.pushFiles('acme/app', {
        branch: 'aw/alpha/t1',
        base: 'main',
        files: [{ path: 'a', content: 'a\n' }],
        message: 'm',
      });
      const ticket = ticketOf('t', 'Body.\n/merge', 'https://example.invalid');
      await expect(
        author.openChange('acme/app', { branch: 'aw/alpha/t1', base: 'main', title: 't', body: ticket.body }),
      ).rejects.toThrow(/slash command/);
    }
  });
});
