import { NOT_ALLOWLISTED } from '../sandbox/firewall.ts';
import { isAllowed, parseAllowlist } from '../sandbox/proxy/allowlist.mjs';

/** The two numbers of the FIREWALL zone. */
export interface FirewallCount {
  /** Distinct sites among the denials HQ holds, without those the allowlist has since opened. */
  readonly blocked: number;
  /** Project allowlist rules, or `null` when the policy allows every site. */
  readonly allowed: number | null;
}

export const firewallCount = (
  denials: Iterable<{ readonly host: string; readonly port: number; readonly reason: string }>,
  allowlist: readonly string[],
): FirewallCount => {
  const rules = parseAllowlist(allowlist.join('\n'));
  const blocked = new Set<string>();
  for (const { host, port, reason } of denials)
    if (reason !== NOT_ALLOWLISTED || !isAllowed(rules, host, port)) blocked.add(`${host}:${port}`);
  return { blocked: blocked.size, allowed: rules.some((rule) => rule.any) ? null : rules.length };
};
