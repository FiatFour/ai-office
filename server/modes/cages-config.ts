import { cageShells } from '../agents/cage-shell.ts';
import { claudeCode } from '../agents/claude-code.ts';
import type { Ticket } from '../agents/runtime.ts';
import { github } from '../githost/github.ts';
import { gitlab } from '../githost/gitlab.ts';
import { type ApiCall, cliTransport } from '../githost/host.ts';
import type { SandboxDriver } from '../sandbox/container.ts';
import { withChanges } from '../snapshot/changes.ts';
import { cagesMode, type ModeFactory } from './cages.ts';

export class ConfigError extends Error {}

const KINDS: ReadonlySet<unknown> = new Set(['feature', 'defect', 'chore']);
const LEVELS: ReadonlySet<unknown> = new Set(['LOW', 'MEDIUM', 'HIGH']);

const text = (o: Record<string, unknown>, key: string, where: string): string => {
  const value = o[key];
  if (typeof value !== 'string' || value === '') throw new ConfigError(`${where}.${key} must be a non-empty string`);
  return value;
};

const optText = (o: Record<string, unknown>, key: string, where: string): string | undefined =>
  o[key] === undefined ? undefined : text(o, key, where);

const record = (value: unknown, where: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ConfigError(`${where} must be an object`);
  return value as Record<string, unknown>;
};

const ticketOf = (id: string, raw: unknown): Ticket => {
  const where = `tickets.${id}`;
  const t = record(raw, where);
  if (!KINDS.has(t.kind)) throw new ConfigError(`${where}.kind must be feature, defect or chore`);
  const risk = t.risk === undefined || t.risk === null ? null : record(t.risk, `${where}.risk`);
  if (risk !== null && !LEVELS.has(risk.level))
    throw new ConfigError(`${where}.risk.level must be LOW, MEDIUM or HIGH`);
  return {
    id,
    kind: t.kind as Ticket['kind'],
    title: text(t, 'title', where),
    body: text(t, 'body', where),
    url: optText(t, 'url', where) ?? null,
    risk: risk === null ? null : { level: risk.level as 'LOW', reason: text(risk, 'reason', `${where}.risk`) },
  };
};

export const cagesFromConfig = (
  raw: unknown,
  driver: () => Promise<SandboxDriver | null>,
  log: (call: ApiCall) => void,
): ModeFactory => {
  const c = record(raw, 'config');
  const hostId = text(c, 'host', 'config');
  if (hostId !== 'github' && hostId !== 'gitlab') throw new ConfigError('config.host must be github or gitlab');
  const send = cliTransport(hostId === 'github' ? 'gh' : 'glab', optText(c, 'hostname', 'config'));
  const repo = text(c, 'repo', 'config');
  const base = text(c, 'base', 'config');
  const author = text(c, 'author', 'config');
  const reviewer = text(c, 'reviewer', 'config');
  if (author.toLowerCase() === reviewer.toLowerCase())
    throw new ConfigError('config.author and config.reviewer must be different logins');
  const model = optText(c, 'model', 'config');
  const bin = optText(c, 'bin', 'config');
  const runtime = claudeCode({
    shell: cageShells(driver, text(c, 'source', 'config')),
    ...(model === undefined ? {} : { model }),
    ...(bin === undefined ? {} : { bin }),
  });
  const tickets = Object.fromEntries(
    Object.entries(record(c.tickets, 'config.tickets')).map(([id, t]) => [id, ticketOf(id, t)]),
  );
  try {
    const host = (hostId === 'github' ? github : gitlab)({ send, log, repo, base });
    const mode = cagesMode({
      host,
      repo,
      base,
      tickets,
      author,
      reviewer,
      workers: { [author]: runtime, [reviewer]: runtime },
      egress: {
        allow: async (site) => {
          const active = await driver();
          if (active === null) throw new Error('no container engine is running, so no proxy can allow a website');
          await active.allow(site);
        },
      },
      ...(typeof c.pollMs === 'number' ? { pollMs: c.pollMs } : {}),
    });
    return withChanges(mode, { host, repo, base, tickets });
  } catch (error) {
    throw new ConfigError((error as Error).message);
  }
};
