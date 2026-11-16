import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAsync } from './cage.mjs';
import { startGuardServer } from './hooks/guard-server.mjs';
import { denyRules, FORWARDER_PATH, managedSettings } from './settings.mjs';

describe('managedSettings', () => {
  it('turns every built-in pattern into Read and Edit deny rules', () => {
    const rules = denyRules();
    for (const rule of [
      'Read(**/.env)',
      'Edit(**/.env)',
      'Read(~/.ssh/**)',
      'Edit(~/.ssh/**)',
      'Read(**/id_ed25519*)',
    ]) {
      expect(rules).toContain(rule);
    }
    expect(rules).not.toContain('Read(**/.env.*)');
    expect(rules.some((rule) => rule.includes('.env.example'))).toBe(false);
  });

  it('sets onFailure block on the PreToolUse guard hook and on no other hook', () => {
    const settings = managedSettings({ hookUrl: 'http://h:1/hook', layers: ['deny', 'hook'] });
    const guard = settings.hooks?.PreToolUse?.[0]?.hooks[0];
    expect(guard).toMatchObject({ type: 'http', url: 'http://h:1/hook', onFailure: 'block' });
    const others = Object.entries(settings.hooks ?? {})
      .filter(([event]) => event !== 'PreToolUse')
      .flatMap(([, groups]) => groups.flatMap((group) => group.hooks));
    expect(others.length).toBeGreaterThanOrEqual(5);
    for (const hook of others) expect(hook).not.toHaveProperty('onFailure');
  });

  it('forwards SessionStart through a command hook because the http type did not fire for it', () => {
    const settings = managedSettings({ hookUrl: 'http://h:1/hook', layers: ['hook'] });
    expect(settings.hooks?.SessionStart?.[0]?.hooks[0]).toMatchObject({
      type: 'command',
      command: "node /etc/claude-code/forward-event.mjs 'http://h:1/hook'",
    });
  });

  it('quotes a hook URL that carries a token so the shell does not split it at &', () => {
    const url = 'http://h:1/hook?token=a b&via=command';
    const settings = managedSettings({ hookUrl: url, layers: ['hook'] });
    expect(settings.hooks?.SessionStart?.[0]?.hooks[0]).toMatchObject({
      command: "node /etc/claude-code/forward-event.mjs 'http://h:1/hook?token=a b&via=command'",
    });
  });

  it('omits the hooks for deny-only and the deny rules for hook-only', () => {
    expect(managedSettings({ hookUrl: 'http://h:1/hook', layers: ['deny'] }).hooks).toBeUndefined();
    expect(managedSettings({ hookUrl: 'http://h:1/hook', layers: ['hook'] }).permissions?.deny).toBeUndefined();
  });

  it('can leave onFailure off to show the fail-open default', () => {
    const settings = managedSettings({ hookUrl: 'http://h:1/hook', layers: ['hook'], failClosed: false });
    expect(settings.hooks?.PreToolUse?.[0]?.hooks[0]).not.toHaveProperty('onFailure');
  });

  it('locks the hooks and the permission mode in managed settings', () => {
    const settings = managedSettings({ hookUrl: 'http://h:1/hook', layers: ['deny', 'hook'] });
    expect(settings.allowManagedHooksOnly).toBe(true);
    expect(settings.permissions?.disableBypassPermissionsMode).toBe('disable');
  });
});

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('guard server', () => {
  let dir: string;
  let server: Awaited<ReturnType<typeof startGuardServer>>;
  const post = async (body: unknown) => {
    const response = await fetch(`${server.url}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.text()) as string };
  };
  const pre = (tool_name: string, tool_input: Record<string, unknown>) => ({
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    cwd: join(dir, 'repo'),
    tool_name,
    tool_input,
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'p0-3-guard-'));
    mkdirSync(join(dir, 'repo'));
    writeFileSync(join(dir, 'repo', '.env'), 'KEY=fake\n');
    server = await startGuardServer({ logPath: join(dir, 'events.jsonl'), home: join(dir, 'home') });
  });
  afterAll(() => server.close());

  it('denies a protected Bash call with the layer name in the reason', async () => {
    const { status, body } = await post(pre('Bash', { command: 'cat .env' }));
    expect(status).toBe(200);
    const output = JSON.parse(body).hookSpecificOutput;
    expect(output).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(output.permissionDecisionReason).toContain('layer 4');
  });

  it('answers an allowed call with an empty 2xx body', async () => {
    const { status, body } = await post(pre('Bash', { command: 'echo hi' }));
    expect(status).toBe(200);
    expect(body).toBe('');
  });

  it('logs events in order with the decision and layer', async () => {
    await post({ hook_event_name: 'SessionStart', session_id: 's2' });
    await post(pre('Read', { file_path: '.env' }));
    await post({ hook_event_name: 'PostToolUse', session_id: 's2', tool_name: 'Bash' });
    await post({ hook_event_name: 'SubagentStart', session_id: 's2', agent_id: 'a1' });
    await post({ hook_event_name: 'Stop', session_id: 's2' });
    const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const seqs = lines.map((line) => line.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const blocked = lines.filter((line) => line.decision === 'deny');
    expect(blocked.length).toBeGreaterThanOrEqual(2);
    expect(blocked.every((line) => line.layer === 'pretooluse-hook')).toBe(true);
    expect(lines.find((line) => line.event === 'SubagentStart')).toMatchObject({ agent_id: 'a1' });
  });

  it('rejects a body that is not JSON with a 400 so that onFailure block applies', async () => {
    const response = await fetch(`${server.url}/hook`, { method: 'POST', body: 'not json' });
    expect(response.status).toBe(400);
  });

  it('refuses connections after close', async () => {
    const other = await startGuardServer({ logPath: join(dir, 'other.jsonl'), home: dir });
    const { url } = other;
    await other.close();
    await expect(fetch(`${url}/hook`, { method: 'POST', body: '{}' })).rejects.toThrow();
  });
});

describePosix('event forwarder', () => {
  it('posts its stdin to the server and exits 0 even when the server is down', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p0-3-fwd-'));
    const server = await startGuardServer({ logPath: join(dir, 'e.jsonl'), home: dir });
    const forwarder = new URL('./hooks/forward-event.mjs', import.meta.url).pathname;
    const send = (url: string) =>
      runAsync(
        'node',
        [forwarder, `${url}/hook`],
        JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'f1' }),
      );
    expect((await send(server.url)).code).toBe(0);
    const logged = readFileSync(join(dir, 'e.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(logged).toMatchObject([{ event: 'SessionStart', session_id: 'f1' }]);
    const { url } = server;
    await server.close();
    expect((await send(url)).code).toBe(0);
    expect(FORWARDER_PATH).toBe('/etc/claude-code/forward-event.mjs');
  });
});
