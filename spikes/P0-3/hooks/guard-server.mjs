import { timingSafeEqual } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkToolCall } from '../protected-paths.mjs';

export const LAYER = 'pretooluse-hook';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const MAX_DENY_LOG_BYTES = 4 * 1024 * 1024;
export const TOKEN_HEADER = 'x-guard-token';

/**
 * @typedef {{
 *   logPath: string, home: string, host?: string, port?: number, workspace?: string, root?: string,
 *   gitClean?: boolean, secret?: string, maxBodyBytes?: number, maxLogBytes?: number, maxDenyLogBytes?: number,
 * }} GuardOptions
 */

/** @param {unknown} value */
const asRecord = (value) => (value && typeof value === 'object' ? /** @type {Record<string, any>} */ (value) : {});

/** @param {string | null} given @param {string} expected */
const sameSecret = (given, expected) => {
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

class BodyTooLarge extends Error {}

/** @param {import('node:http').IncomingMessage} request @param {number} limit */
const readBody = async (request, limit) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};

/** @param {import('node:http').ServerResponse} response @param {number} status @param {string} [body] @param {Record<string, string>} [headers] */
const reply = (response, status, body = '', headers = {}) => {
  if (response.headersSent || response.writableEnded) return;
  response.writeHead(status, { connection: 'close', ...headers }).end(body);
};

/**
 * @param {GuardOptions} options
 */
export const startGuardServer = async ({
  logPath,
  home,
  host = '127.0.0.1',
  port = 0,
  workspace,
  root,
  gitClean: initialGitClean = false,
  secret,
  maxBodyBytes = MAX_BODY_BYTES,
  maxLogBytes = MAX_LOG_BYTES,
  maxDenyLogBytes = MAX_DENY_LOG_BYTES,
}) => {
  writeFileSync(logPath, '');
  let gitClean = initialGitClean;
  let seq = 0;
  const stats = { events: 0, denies: 0, dropped: 0, deniesDropped: 0 };
  const budgets = {
    events: { limit: maxLogBytes, used: 0 },
    denies: { limit: maxDenyLogBytes, used: 0 },
  };
  /** @param {Record<string, unknown>} entry */
  const log = (entry) => {
    stats.events += 1;
    const deny = entry.decision === 'deny';
    if (deny) stats.denies += 1;
    const budget = deny ? budgets.denies : budgets.events;
    if (budget.used > budget.limit) {
      stats[deny ? 'deniesDropped' : 'dropped'] += 1;
      return;
    }
    const line = `${JSON.stringify(entry)}\n`;
    if (budget.used + line.length > budget.limit) {
      const marker = deny ? 'deny-log-truncated' : 'log-truncated';
      appendFileSync(logPath, `${JSON.stringify({ seq: entry.seq, event: marker, decision: 'none' })}\n`);
      budget.used = budget.limit + 1;
      stats[deny ? 'deniesDropped' : 'dropped'] += 1;
      return;
    }
    appendFileSync(logPath, line);
    budget.used += line.length;
  };

  /** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response */
  const handle = async (request, response) => {
    let target;
    try {
      target = new URL(request.url ?? '/', 'http://guard.invalid');
    } catch {
      reply(response, 400, 'bad url');
      return;
    }
    if (request.method !== 'POST' || target.pathname !== '/hook') {
      reply(response, 404);
      return;
    }
    if (secret !== undefined && !sameSecret(String(request.headers[TOKEN_HEADER] ?? ''), secret)) {
      reply(response, 401);
      return;
    }
    let payload;
    try {
      payload = asRecord(JSON.parse(await readBody(request, maxBodyBytes)));
    } catch (error) {
      reply(
        response,
        error instanceof BodyTooLarge ? 413 : 400,
        error instanceof BodyTooLarge ? 'too large' : 'invalid json',
      );
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
      /** @type {import('../protected-paths.mjs').Verdict} */
      let verdict;
      try {
        verdict = checkToolCall(
          { tool_name: payload.tool_name, tool_input: payload.tool_input },
          { home, cwd: typeof payload.cwd === 'string' ? payload.cwd : '/', workspace, root, gitClean },
        );
      } catch (error) {
        verdict = {
          blocked: true,
          path: '',
          reason: `the guard failed on this call (${/** @type {Error} */ (error).message})`,
        };
      }
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
    log(entry);
    reply(response, 200, body, body ? { 'content-type': 'application/json' } : {});
  };

  const server = createServer((request, response) => {
    handle(request, response).catch(() => reply(response, 500, 'guard error'));
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
    else socket.destroy();
  });
  server.listen(port, host);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://${host}:${address.port}`,
    hookUrl: `http://${host}:${address.port}/hook`,
    token: secret,
    port: address.port,
    stats: () => ({ ...stats }),
    /** @param {boolean} value */
    setGitClean: (value) => {
      gitClean = value === true;
    },
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
      secret: { type: 'string' },
      workspace: { type: 'string' },
      root: { type: 'string' },
      'git-clean': { type: 'boolean', default: false },
    },
  });
  const server = await startGuardServer({
    logPath: values.log ?? 'guard-events.jsonl',
    home: String(values.home),
    host: String(values.host),
    port: Number(values.port),
    ...(values.secret ? { secret: values.secret } : {}),
    ...(values.workspace ? { workspace: values.workspace } : {}),
    ...(values.root ? { root: values.root } : {}),
    gitClean: values['git-clean'] === true,
  });
  console.log(server.hookUrl);
}
