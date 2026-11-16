/**
 * Every switch that turns one mechanism off. `scope` names the rig the replay needs to start for the mutation, so the
 * mutation run only replays the rows that rig serves. `collateral` lists rows that flip without declaring the switch
 * because they observe through the mechanism, each with the reason. A mutation applies to the fixture, cage, network or
 * policy the replay builds, never to the repository's own files.
 * @typedef {'cages' | 'firewall' | 'git' | 'host'} Scope
 * `flipsNothing` marks a mutation that is measured to turn no row to FAIL, kept so the claim that one switch alone is not
 * enough stays a replayed fact.
 * @type {Record<string, { scope: Scope, switch: string, collateral?: Record<string, string>, flipsNothing?: true }>}
 */
export const MUTATIONS = {
  'mask-off': {
    scope: 'cages',
    switch: 'the masked cage starts without the empty read-only bind over each protected file',
  },
  'preflight-off': {
    scope: 'cages',
    switch: 'the preflight reports every repo clean',
  },
  'host-home-mounted': {
    scope: 'cages',
    switch: 'the masked cage also mounts the fixture host home',
  },
  'settings-writable': {
    scope: 'cages',
    switch: 'the managed settings file is world writable',
    collateral: {
      'guard-token-forge': 'the row reads the token from the settings file the mutation lets the agent rewrite',
    },
  },
  'hook-always-allows': {
    scope: 'cages',
    switch: 'the layer 4 hook endpoint answers every tool call with no decision',
  },
  'cage-privileged': {
    scope: 'cages',
    switch: 'a cage starts with --privileged and the docker socket mounted',
  },
  'network-open': {
    scope: 'firewall',
    switch: 'the cage network is a normal bridge: no --internal and no inhibit_ipv4',
  },
  'inhibit-off': {
    scope: 'firewall',
    switch: 'the cage network keeps --internal and loses inhibit_ipv4',
  },
  'internal-off': {
    scope: 'firewall',
    switch: 'the cage network keeps inhibit_ipv4 and loses --internal',
    flipsNothing: true,
  },
  'allow-example': {
    scope: 'firewall',
    switch: 'the proxy allowlist also names example.com',
    collateral: { 'fw-label-spoof': 'the row reads the deny event that an allowed host would no longer produce' },
  },
  'sni-off': {
    scope: 'firewall',
    switch: 'a copy of the proxy skips the ClientHello check',
  },
  'public-check-off': {
    scope: 'firewall',
    switch: 'a copy of the proxy dials non-public addresses',
  },
  'deny-cap-off': {
    scope: 'firewall',
    switch: 'a copy of the proxy has no deny event rate cap',
  },
  'precommit-hook-off': {
    scope: 'git',
    switch: 'the pre-commit hook exits 0',
  },
  'prepush-hook-off': {
    scope: 'git',
    switch: 'the pre-push hook exits 0',
  },
  'git-hardening-off': {
    scope: 'host',
    switch: 'the guard and the scan read the agent repo with plain git and no hardened flags',
  },
  'ws-origin-off': {
    scope: 'host',
    switch: 'a copy of the terminal server accepts any WebSocket Origin',
  },
  'host-check-off': {
    scope: 'host',
    switch: 'a copy of the terminal server answers any Host header',
  },
  'bind-all': {
    scope: 'host',
    switch: 'a copy of the terminal server binds 0.0.0.0',
  },
  'signature-check-off': {
    scope: 'host',
    switch: 'the webhook receiver accepts any delivery',
  },
};

/** @param {string | undefined} id */
export const isMutation = (id) => id !== undefined && id in MUTATIONS;

/**
 * Compares what a mutated replay did with what the table declares. A row the mutation must flip has to be FAIL, and any
 * other row that is FAIL has to be named as collateral for that mutation.
 * @param {string} id
 * @param {string[]} declared rows whose Mutation cell names `id`
 * @param {Record<string, string>} statuses replay status per row id
 * @returns {string[]}
 */
export const flipProblems = (id, declared, statuses) => {
  const collateral = Object.keys(MUTATIONS[id]?.collateral ?? {});
  const flips = new Set([...declared, ...collateral]);
  /** @type {string[]} */
  const problems = [];
  for (const row of declared) {
    if (statuses[row] !== 'FAIL')
      problems.push(`${id} did not turn ${row} to FAIL (it was ${statuses[row] ?? 'missing'})`);
  }
  for (const [row, status] of Object.entries(statuses)) {
    if (status === 'FAIL' && !flips.has(row))
      problems.push(`${id} turned ${row} to FAIL and the table does not declare it`);
  }
  return problems;
};
