import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkToolCall } from '../protected-paths.mjs';

export const LAYER = 'pretooluse-hook';

/**
 * @typedef {{
 *   logPath: string, home: string, host?: string, port?: number, mapDir?: (path: string) => string,
 * }} GuardOptions
 */

/** @param {unknown} value */
const asRecord = (value) => (value && typeof value === 'object' ? /** @type {Record<string, any>} */ (value) : {});

/**
 * @param {GuardOptions} options
 */
export const startGuardServer = async ({ logPath, home, host = '127.0.0.1', port = 0, mapDir }) => {
  writeFileSync(logPath, '');
  let seq = 0;
  const server = createServer(async (request, response) => {
    const target = new URL(request.url ?? '/', 'http://guard.invalid');
    if (request.method !== 'POST' || target.pathname !== '/hook') {
      response.writeHead(404).end();
      return;
    }
    let payload;
    try {
      payload = asRecord(JSON.parse(await text(request)));
    } catch {
      response.writeHead(400).end('invalid json');
      return;
    }
    const event = String(payload.hook_event_name ?? 'unknown');
    /** @type {Record<string, unknown>} */
    const entry = {
      seq: ++seq,
      ts: Date.now(),
      event,
      session_id: payload.session_id,
      agent_id: payload.agent_id,
      tool: payload.tool_name,
      via: target.searchParams.get('via') ?? undefined,
      decision: 'none',
      layer: undefined,
      reason: undefined,
      target: undefined,
    };
    let body = '';
    if (event === 'PreToolUse') {
      const verdict = checkToolCall(
        { tool_name: String(payload.tool_name ?? ''), tool_input: asRecord(payload.tool_input) },
        { home, cwd: String(payload.cwd ?? '/'), mapDir },
      );
      entry.decision = verdict.blocked ? 'deny' : 'allow';
      if (verdict.blocked) {
        entry.layer = LAYER;
        entry.reason = verdict.reason;
        entry.target = verdict.path;
        body = JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Blocked by layer 4 (${LAYER}): ${verdict.reason}`,
          },
        });
      }
    }
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
    response.writeHead(200, body ? { 'content-type': 'application/json' } : {}).end(body);
  });
  server.listen(port, host);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://${host}:${address.port}`,
    port: address.port,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      log: { type: 'string' },
      home: { type: 'string', default: '/home/node' },
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '0' },
    },
  });
  const server = await startGuardServer({
    logPath: values.log ?? 'guard-events.jsonl',
    home: String(values.home),
    host: String(values.host),
    port: Number(values.port),
  });
  console.log(server.url);
}
