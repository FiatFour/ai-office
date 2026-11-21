import { BlockList, isIP } from 'node:net';

/**
 * Ranges a proxy must never dial on a cage's behalf. Each is [network, prefix length].
 * @type {Record<'ipv4' | 'ipv6', Array<[string, number]>>}
 */
export const NON_PUBLIC = {
  ipv4: [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ],
  ipv6: [
    ['::', 128],
    ['::1', 128],
    ['64:ff9b::', 96],
    ['100::', 64],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
  ],
};

const mapped = new BlockList();
mapped.addSubnet('::ffff:0:0', 96, 'ipv6');
const blocked = new BlockList();
for (const [network, prefix] of NON_PUBLIC.ipv4) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of NON_PUBLIC.ipv6) blocked.addSubnet(network, prefix, 'ipv6');

/**
 * True for a routable unicast address. IPv4-mapped IPv6 is rejected whatever it maps to, so `::ffff:10.0.0.1` and
 * `::ffff:8.8.8.8` both fail. A resolver has no reason to return either.
 * @param {string} address
 */
export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 4) return !blocked.check(address, 'ipv4');
  return !mapped.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
