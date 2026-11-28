import { isIP } from 'node:net';
import { NON_PUBLIC } from './address.mjs';

/** @typedef {{ host: string, wildcard: boolean, port: number, any?: boolean }} Rule */

const DEFAULT_PORT = 443;
const HOST_LABEL = /^[a-z0-9-]+$/;
const ANY_HOST = /^\*(?::(\d+))?$/;
/** A name with a dot and a non-numeric top label, so no numeric spelling of an address and no bare container name. */
const DNS_NAME = /^(?:[a-z0-9_-]+\.)+[a-z][a-z0-9-]*$/;

/** @param {string} host */
export function normalizeHost(host) {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return bare.toLowerCase().replace(/\.$/, '');
}

/** @param {string} host */
export function isIpLiteral(host) {
  return isIP(normalizeHost(host)) !== 0;
}

/**
 * One rule per line: `host`, `host:port`, `*.domain`, `*.domain:port`, `*` or `*:port`. `#` starts a comment.
 * `*.domain` matches subdomains of `domain`, not `domain` itself. `*` matches every DNS name.
 * @param {string} text
 * @returns {Rule[]}
 */
export function parseAllowlist(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter((line) => line !== '')
    .map((line) => {
      const any = ANY_HOST.exec(line);
      if (any !== null) {
        return { host: '', wildcard: true, any: true, port: any[1] === undefined ? DEFAULT_PORT : Number(any[1]) };
      }
      const match = /^(\*\.)?([^:\s]+)(?::(\d+))?$/.exec(line);
      const name = match?.[2] === undefined ? '' : normalizeHost(match[2]);
      if (match === null || isIP(name) !== 0 || !name.split('.').every((label) => HOST_LABEL.test(label))) {
        throw new Error(`allowlist: not a host rule: ${line}`);
      }
      return {
        host: name,
        wildcard: match[1] !== undefined,
        port: match[3] === undefined ? DEFAULT_PORT : Number(match[3]),
      };
    });
}

/**
 * @param {Rule[]} rules
 * @param {string} host
 * @param {number} port
 */
export function isAllowed(rules, host, port) {
  if (isIpLiteral(host)) return false;
  const name = normalizeHost(host);
  return rules.some((rule) => {
    if (rule.port !== port) return false;
    if (rule.any) return DNS_NAME.test(name);
    return rule.wildcard ? name.endsWith(`.${rule.host}`) : name === rule.host;
  });
}

/**
 * Parses a CONNECT request target, `host:port` or `[v6]:port`.
 * @param {string} target
 * @returns {{ host: string, port: number } | null}
 */
export function parseConnectTarget(target) {
  const match = /^(\[[^\]]+\]|[^:[\]]+):(\d{1,5})$/.exec(target);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const port = Number(match[2]);
  return port > 0 && port < 65536 ? { host: normalizeHost(match[1]), port } : null;
}

/** @param {string} text */
const regexEscape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Squid config that allows CONNECT only to the rules' host and port pairs, with the same matching as `isAllowed`.
 * `-n` stops Squid from reverse-resolving an IP-literal target, so IP literals never match a rule.
 * Each rule first denies CONNECT when its name resolves to a non-public address, then allows it. Squid evaluates ACLs
 * left to right and stops at the first miss, so a name outside the allowlist is never resolved.
 * @param {Rule[]} rules
 * @param {{ dnsServer: string }} options
 */
export function toSquidConf(rules, { dnsServer }) {
  if (rules.some((rule) => rule.any)) throw new Error('allowlist: the Squid config has no form for the * rule');
  const ruleLines = rules.flatMap((rule, index) => [
    `acl r${index}_host dstdom_regex -n -i ${rule.wildcard ? `\\.${regexEscape(rule.host)}$` : `^${regexEscape(rule.host)}$`}`,
    `acl r${index}_port port ${rule.port}`,
    `http_access deny CONNECT r${index}_host r${index}_port non_public_dst`,
    `http_access allow CONNECT r${index}_host r${index}_port`,
  ]);
  return [
    'http_port 3128',
    `dns_nameservers ${dnsServer}`,
    'cache deny all',
    'access_log /var/log/squid/access.log',
    'acl CONNECT method CONNECT',
    `acl non_public_dst dst ${[...NON_PUBLIC.ipv4, ...NON_PUBLIC.ipv6].map(([network, prefix]) => `${network}/${prefix}`).join(' ')}`,
    ...ruleLines,
    'http_access deny all',
    '',
  ].join('\n');
}
