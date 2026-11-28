import { chmodSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { logExcerpt, MAX_OUTPUT } from '../githost/ci-log.ts';
import { github } from '../githost/github.ts';
import { gitlab } from '../githost/gitlab.ts';
import { cliTransport, MAX_FAILURES, MAX_LOGS, type Transport } from '../githost/host.ts';
import { FakeGithub } from './fakes/github-api.ts';
import { FakeGitlab } from './fakes/gitlab-api.ts';
import { tempDir } from './helpers.ts';

const stamped = (...lines: string[]) => lines.map((l) => `2026-11-27T16:09:24.9822747Z ${l}`).join('\n');
const filler = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word} ${i}`);

describe('the excerpt of a job log', () => {
  it('ends at the last marked error, without timestamps, colours or the cleanup after it', () => {
    const log = stamped(
      '\u001b[41m FAIL \u001b[0m math.test.ts',
      '##[error]Process completed with exit code 1.',
      'Post job cleanup.',
    );
    expect(logExcerpt(`﻿${log}`)).toBe('FAIL  math.test.ts\n##[error]Process completed with exit code 1.');
  });

  it('keeps an early failure line that a long run pushed out of the tail', () => {
    const out = logExcerpt(
      stamped('ERR  the-anchor: pattern not found', ...filler(3_000, 'OK  mutant'), '##[error]exit 1'),
    ) as string;
    expect(out).toContain('ERR  the-anchor: pattern not found');
    expect(out).toContain('OK  mutant 2999');
    expect(out).not.toContain('OK  mutant 5\n');
  });

  it('stays bounded whatever the job printed', () => {
    const huge = [...filler(5_000, 'FAIL'), 'x'.repeat(3_000_000), ...filler(5_000, 'error TS1:')].join('\n');
    expect((logExcerpt(huge) as string).length).toBeLessThanOrEqual(MAX_OUTPUT);
    expect(logExcerpt('y'.repeat(100_000))).toHaveLength(400);
    expect(logExcerpt(' \n\n')).toBeNull();
  });

  const body = 'Ab1'.repeat(12);
  it.each([
    ['a GitHub token', `ghs_${body}`],
    ['a fine-grained GitHub token', `github_pat_${body}`],
    ['a GitLab token', `glpat-${body}`],
    ['a model API key', `sk-ant-api03-${body}`],
    ['an npm token', `npm_${body}`],
    ['an AWS key id', 'AKIAABCDEFGHIJKLMNOP'],
    ['a JWT', `eyJ${body}.${body}.${body}`],
    ['an Authorization header', `Authorization: token ${body}`],
    ['a bearer token', `sent Bearer ${body}`],
    ['a password in a URL', `https://bot:${body}@example.test/r.git`],
    ['a token assigned to a name', `MY_API_TOKEN=${body}`],
    ['a quoted secret in JSON', `{"client_secret": "${body}"}`],
    ['a password flag', `password: ${body}`],
  ])('hides %s', (_name, line) => {
    const out = logExcerpt(`before\n${line}\nafter`) as string;
    expect(out).not.toContain(body);
    expect(out).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(out).toContain('[redacted]');
    expect(out).toMatch(/^before\n[\s\S]*\nafter$/);
  });

  it('hides a private key, also when the log ends before the key does', () => {
    const key = ['-----BEGIN OPENSSH PRIVATE KEY-----', body, '-----END OPENSSH PRIVATE KEY-----'];
    expect(logExcerpt(['a', ...key, 'b'].join('\n'))).toBe('a\n[redacted]\n[redacted]\n[redacted]\nb');
    expect(logExcerpt(['a', key[0], body, body].join('\n'))).not.toContain(body);
    expect(logExcerpt([...key.slice(0, 2), ...filler(2_000, 'k'), key[2]].join('\n'))).not.toContain('k 1999');
  });

  it('leaves ordinary compiler and test lines alone', () => {
    const lines = "src/a.ts(3,1): error TS2304: Cannot find name 'token'.\nSyntaxError: Unexpected token '}'";
    expect(logExcerpt(lines)).toBe(lines);
  });
});

describe('the failing checks GitHub reports', () => {
  const sha = 'a'.repeat(40);
  const hostOn = (fake: FakeGithub) =>
    github({ repo: 'acme/app', base: 'main', send: fake.transport('bot'), log: () => {} });

  it('reads a few job logs, the jobs a fail-fast matrix cancelled last, and names the rest', async () => {
    const fake = new FakeGithub();
    for (let i = 0; i < MAX_FAILURES; i += 1) fake.failJob(sha, `cancelled ${i}`, 'nothing', 'cancelled');
    fake.failJob(sha, 'real', 'the cause');
    const failures = await hostOn(fake).failures('acme/app', sha);
    expect(failures).toHaveLength(MAX_FAILURES);
    expect(failures[0]).toEqual({ name: 'real', output: 'the cause' });
    expect(failures.filter((f) => f.output !== null)).toHaveLength(MAX_LOGS);
    expect(fake.calls.filter((c) => c.path.endsWith('/logs'))).toHaveLength(MAX_LOGS);
  });

  it('still names a job whose log cannot be read, and reads what another app reports', async () => {
    const fake = new FakeGithub();
    fake.failJob(sha, 'expired', null);
    const other = fake.failJob(sha, 'scanner', 'never read', 'failure', 'some-app');
    Object.assign(fake.runs.find((r) => r.id === other) as object, { output: { title: '2 findings', summary: null } });
    fake.setStatus(sha, 'legacy/ci', 'error');
    fake.setStatus(sha, 'fine', 'success');
    expect(await hostOn(fake).failures('acme/app', sha)).toEqual([
      { name: 'expired', output: null },
      { name: 'scanner', output: '2 findings' },
      { name: 'legacy/ci', output: null },
    ]);
    expect(fake.calls.map((c) => c.path)).not.toContain(`/repos/acme/app/actions/jobs/${other}/logs`);
  });

  it('throws when the checks cannot be listed', async () => {
    const host = github({
      repo: 'acme/app',
      base: 'main',
      log: () => {},
      send: async () => ({ status: 500, body: {} }),
    });
    await expect(host.failures('acme/app', sha)).rejects.toThrow('500');
  });
});

describe('the failing jobs GitLab reports', () => {
  const sha = 'b'.repeat(40);
  const hostOn = (send: Transport) => gitlab({ repo: 'acme/app', base: 'main', send, log: () => {} });

  it('reads the trace of each failed job, and not of one allowed to fail', async () => {
    const fake = new FakeGitlab();
    fake.failJob(sha, 'unit', 'the cause');
    const send = fake.transport('bot');
    const failures = await hostOn(async (request) => {
      const response = await send(request);
      if (!request.path.includes('/pipelines/9/jobs')) return response;
      const optional = { id: 1, name: 'optional', allow_failure: true };
      return { ...response, body: [...(response.body as unknown[]), optional] };
    }).failures('acme/app', sha);
    expect(failures).toEqual([{ name: 'unit', output: 'the cause' }]);
  });

  it('names a failed pipeline that has no failed job', async () => {
    const pipeline = { id: 4, sha, status: 'canceled', updated_at: '2026-11-17T00:00:00Z' };
    const failures = await hostOn(async (request) => ({
      status: 200,
      body: request.path.includes('/jobs') ? [] : [pipeline],
    })).failures('acme/app', sha);
    expect(failures).toEqual([{ name: 'pipeline 4', output: null }]);
  });
});

describe.skipIf(process.platform === 'win32')('the gh transport', () => {
  const path = process.env.PATH;
  afterEach(() => {
    process.env.PATH = path;
  });
  const fakeGh = (script: string) => {
    const dir = tempDir('fake-gh');
    writeFileSync(join(dir, 'gh'), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, 'gh'), 0o755);
    process.env.PATH = `${dir}${delimiter}${path}`;
  };
  const ok = "printf 'HTTP/1.1 200 OK\\r\\n\\r\\n'";

  it('asks again with the escape flag when gh withholds a body that holds colour codes', async () => {
    fakeGh(`case "$*" in
  *--allow-escape-sequences*) ${ok}; echo 'the log' ;;
  *) ${ok}; echo 'pass --allow-escape-sequences to output it anyway' >&2; exit 1 ;;
esac`);
    expect(await cliTransport('gh')({ method: 'GET', path: '/x' })).toEqual({ status: 200, body: 'the log' });
  });

  it('never passes the flag to a gh that did not ask for it', async () => {
    fakeGh(`case "$*" in *--allow-escape-sequences*) echo 'unknown flag' >&2; exit 1 ;; esac\n${ok}; echo '{"a":1}'`);
    expect(await cliTransport('gh')({ method: 'GET', path: '/x' })).toEqual({ status: 200, body: { a: 1 } });
  });
});
