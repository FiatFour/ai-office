import { describe, expect, it } from 'vitest';
import { ConfigError, firewallFromConfig } from '../modes/cages-config.ts';
import { DEFAULT_ALLOWLIST, firewallPolicy, POLICIES } from '../sandbox/firewall.ts';
import { isAllowed, parseAllowlist, toSquidConf } from '../sandbox/proxy/allowlist.mjs';
import { siteOf } from '../sandbox/site.ts';
import { firewallCount } from '../snapshot/firewall.ts';

const rulesOf = (list: readonly string[]) => parseAllowlist(list.join('\n'));
const config = (firewall: unknown) => ({ author: 'nova', reviewer: 'vega', firewall });

describe('firewall policies', () => {
  it('locked holds the model API and the package registry, and no git host', () => {
    expect(POLICIES.locked).toEqual(['api.anthropic.com', 'registry.npmjs.org']);
  });

  it('balanced adds GitHub and is the default', () => {
    expect(POLICIES.balanced).toEqual(['api.anthropic.com', 'github.com', 'api.github.com', 'registry.npmjs.org']);
    expect(DEFAULT_ALLOWLIST).toBe(POLICIES.balanced);
    expect(firewallPolicy().allowlist).toEqual(POLICIES.balanced);
  });

  it('open allows any DNS name on 443 and nothing that spells an address or a bare name', () => {
    const open = rulesOf(POLICIES.open);
    for (const host of ['example.com', 'a.b.evil.test', 'xn--bcher-kva.example'])
      expect(isAllowed(open, host, 443), host).toBe(true);
    for (const host of [
      '127.0.0.1',
      '[::1]',
      '2130706433',
      '127.1',
      '0x7f.0.0.1',
      '0x7f000001',
      'localhost',
      'aw-proxy',
    ])
      expect(isAllowed(open, host, 443), host).toBe(false);
    expect(isAllowed(open, 'example.com', 22)).toBe(false);
  });

  it('keeps * out of an Allow and out of the Squid renderer', () => {
    expect(siteOf('*')).toBeNull();
    expect(() => toSquidConf(rulesOf(['*']), { dnsServer: '10.0.0.2' })).toThrow(/no form/);
  });

  it('adds project and per-worker rules to the policy', () => {
    const made = firewallFromConfig(
      config({ policy: 'locked', allow: ['pypi.org', 'registry.npmjs.org'], workers: { nova: ['*.crates.io:443'] } }),
    );
    expect(made).toEqual({
      allowlist: ['api.anthropic.com', 'registry.npmjs.org', 'pypi.org'],
      workers: { nova: ['*.crates.io:443'] },
    });
    expect(firewallFromConfig({ author: 'nova', reviewer: 'vega' })).toEqual(firewallPolicy());
  });

  it('refuses a setting that would widen or silently drop a rule', () => {
    for (const bad of [
      { policy: 'wide' },
      { policy: 'constructor' },
      { allowed: ['pypi.org'] },
      { allow: 'pypi.org' },
      { allow: ['*'] },
      { allow: ['*:443'] },
      { allow: ['pypi.org\n*'] },
      { allow: ['pypi.org # why'] },
      { allow: ['10.0.0.1'] },
      { workers: { mira: ['pypi.org'] } },
      { workers: { nova: ['*'] } },
    ])
      expect(() => firewallFromConfig(config(bad)), JSON.stringify(bad)).toThrow(ConfigError);
  });
});

describe('firewallCount', () => {
  const denial = (host: string, reason = 'not-allowlisted') => ({ host, port: 443, reason });

  it('counts each blocked site once and drops one the allowlist has since opened', () => {
    const denials = [denial('pypi.org'), denial('pypi.org'), denial('evil.test'), denial('registry.npmjs.org')];
    expect(firewallCount(denials, POLICIES.balanced)).toEqual({ blocked: 2, allowed: 4 });
  });

  it('keeps counting a denial an allowlist entry does not lift', () => {
    expect(firewallCount([denial('github.com', 'sni-mismatch')], POLICIES.balanced).blocked).toBe(1);
  });

  it('reports no number of allowed sites for the open policy', () => {
    expect(firewallCount([], POLICIES.open)).toEqual({ blocked: 0, allowed: null });
  });
});
