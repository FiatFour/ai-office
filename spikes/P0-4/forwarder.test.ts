import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { parseArgs } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const script = join(import.meta.dirname, 'githost.mjs');
const fakeGh = `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const dir = process.env.FAKE_GH_DIR;
writeFileSync(dir + '/forwarder.json', JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }));
process.on('SIGINT', () => { writeFileSync(dir + '/hook-removed', ''); process.exit(0); });
console.log('Forwarding Webhook events from GitHub...');
setInterval(() => {}, 1000);
`;

const pids: number[] = [];

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function listen() {
  const dir = mkdtempSync(join(tmpdir(), 'p0-4-forwarder-'));
  writeFileSync(join(dir, 'gh'), fakeGh);
  chmodSync(join(dir, 'gh'), 0o755);
  const node = spawn(
    process.execPath,
    [script, 'listen', '--repo', 'o/r', '--port', '0', '--seconds', '60', '--out', dir],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, GITHUB_TOKEN: 'unused', FAKE_GH_DIR: dir },
    },
  );
  pids.push(node.pid as number);
  let output = '';
  node.stdout?.on('data', (chunk) => {
    output += chunk;
  });
  node.stderr?.on('data', (chunk) => {
    output += chunk;
  });
  const exited = once(node, 'exit');
  await expect.poll(() => output, { timeout: 5000 }).toContain('listening');
  const forwarder: { pid: number; argv: string[] } = JSON.parse(readFileSync(join(dir, 'forwarder.json'), 'utf8'));
  pids.push(forwarder.pid);
  const { values } = parseArgs({ args: forwarder.argv, strict: false, allowPositionals: true });
  return { node, dir, exited, forwarder, url: String(values.url), secret: String(values.secret) };
}

afterEach(() => {
  for (const pid of pids.splice(0)) if (alive(pid)) process.kill(pid, 'SIGKILL');
});

describe.skipIf(process.platform === 'win32')('webhook forwarder lifetime', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)(
    'stops the forwarder and its hook when %s reaches the listener group',
    async (signal) => {
      const { node, dir, exited, forwarder } = await listen();
      process.kill(-(node.pid as number), signal);
      await exited;
      expect(existsSync(join(dir, 'hook-removed'))).toBe(true);
      await expect.poll(() => alive(forwarder.pid)).toBe(false);
    },
  );

  it('answers a delivery it cannot parse with 400 and keeps listening', async () => {
    const { node, dir, exited, url, secret } = await listen();
    const send = (event: string, body: object) => {
      const raw = JSON.stringify(body);
      const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
      return fetch(url, {
        method: 'POST',
        headers: { 'x-github-event': event, 'x-hub-signature-256': signature },
        body: raw,
      });
    };
    expect((await send('push', { repository: { full_name: 'o/r' }, ref: 'r' })).status).toBe(400);
    expect((await send('ping', { zen: 'hi' })).status).toBe(202);
    expect(alive(node.pid as number)).toBe(true);
    process.kill(-(node.pid as number), 'SIGINT');
    await exited;
    expect(existsSync(join(dir, 'hook-removed'))).toBe(true);
  });
});
