import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { parseAllowlist } from './proxy/allowlist.mjs';

const RAW_NAME = /^[\p{L}\p{N}\p{M}-]+(?:\.[\p{L}\p{N}\p{M}-]+)*\.?$/u;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface Site {
  readonly site: string;
  readonly host: string;
  readonly port: number;
}

export const siteOf = (rawHost: string, rawPort: unknown = 443): Site | null => {
  const split = /^([^:]*)(?::(\d{1,5}))?$/.exec(rawHost);
  if (split === null || !RAW_NAME.test(split[1] ?? '')) return null;
  const port = split[2] === undefined ? Number(rawPort) : Number(split[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const host = domainToASCII((split[1] ?? '').replace(/\.$/, ''));
  if (host.length > 253 || isIP(host) !== 0 || !host.split('.').every((label) => LABEL.test(label))) return null;
  try {
    parseAllowlist(`${host}:${port}`);
  } catch {
    return null;
  }
  return { site: `${host}:${port}`, host, port };
};
