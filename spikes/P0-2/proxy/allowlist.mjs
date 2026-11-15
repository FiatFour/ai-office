import { isIP } from 'node:net';

/** @typedef {{ host: string, wildcard: boolean, port: number }} Rule */

const DEFAULT_PORT = 443;
const HOST_LABEL = /^[a-z0-9-]+$/;

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
 * One rule per line: `host`, `host:port`, `*.domain` or `*.domain:port`. `#` starts a comment.
 * `*.domain` matches subdomains of `domain`, not `domain` itself.
 * @param {string} text
 * @returns {Rule[]}
 */
export function parseAllowlist(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter((line) => line !== '')
    .map((line) => {
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
  return rules.some(
    (rule) => rule.port === port && (rule.wildcard ? name.endsWith(`.${rule.host}`) : name === rule.host),
  );
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
 * @param {Rule[]} rules
 * @param {{ dnsServer: string }} options
 */
export function toSquidConf(rules, { dnsServer }) {
  const ruleLines = rules.flatMap((rule, index) => [
    `acl r${index}_host dstdom_regex -n -i ${rule.wildcard ? `\\.${regexEscape(rule.host)}$` : `^${regexEscape(rule.host)}$`}`,
    `acl r${index}_port port ${rule.port}`,
    `http_access allow CONNECT r${index}_host r${index}_port`,
  ]);
  return [
    'http_port 3128',
    `dns_nameservers ${dnsServer}`,
    'cache deny all',
    'access_log /var/log/squid/access.log',
    'acl CONNECT method CONNECT',
    ...ruleLines,
    'http_access deny all',
    '',
  ].join('\n');
}
