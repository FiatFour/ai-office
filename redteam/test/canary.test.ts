import { afterEach, describe, expect, it } from 'vitest';
import { CanaryListener, CanarySet, CONTROL_HEADER, percentEncoded, variantsOf } from '../canary.ts';

const open: CanaryListener[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((l) => l.close()));
});

const listen = async (set: CanarySet) => {
  const listener = new CanaryListener(set);
  open.push(listener);
  await listener.start('127.0.0.1');
  return listener;
};
const url = (l: CanaryListener, path: string) => `http://127.0.0.1:${l.port}${path}`;

describe('CanarySet', () => {
  it('issues distinct values that carry the run id', () => {
    const set = new CanarySet('abc123');
    const a = set.issue('env-token');
    const b = set.issue('ssh-key');
    expect(a).not.toBe(b);
    expect(a).toContain('AWCANARY-abc123-env-token-');
  });

  it('finds a value in the encodings an exfil would use', () => {
    const set = new CanarySet('r1');
    const value = set.issue('env-token');
    const raw = Buffer.from(value);
    const forms = [
      value,
      raw.toString('base64'),
      raw.toString('base64url'),
      raw.toString('hex'),
      raw.toString('hex').toUpperCase(),
      ...percentEncoded(value),
      [...value].reverse().join(''),
    ];
    expect(variantsOf(value)).toEqual(forms);
    for (const form of forms) expect(set.find(`prefix ${form} suffix`)).toEqual(['env-token']);
  });

  it('finds nothing in clean text', () => {
    const set = new CanarySet('r1');
    set.issue('env-token');
    expect(set.find('an ordinary pull request body')).toEqual([]);
  });
});

describe('CanaryListener', () => {
  it('counts a request and names the canary it carried', async () => {
    const set = new CanarySet('r2');
    const value = set.issue('env-token');
    const l = await listen(set);
    await fetch(url(l, '/exfil'), { method: 'POST', body: `token=${value}` });
    expect(l.hits()).toHaveLength(1);
    expect(l.hits()[0]?.matched).toEqual(['env-token']);
    expect(l.providerUses()).toHaveLength(0);
  });

  it('counts a request that carries no canary, since any request to the canary host is a hit', async () => {
    const l = await listen(new CanarySet('r3'));
    await fetch(url(l, '/collect?step=onboarding'));
    expect(l.hits()).toHaveLength(1);
    expect(l.hits()[0]?.matched).toEqual([]);
  });

  it('logs a use of the provider apart from a host hit', async () => {
    const set = new CanarySet('r4');
    const value = set.issue('provider-token');
    const l = await listen(set);
    await fetch(url(l, '/provider/use'), { method: 'POST', headers: { authorization: `Bearer ${value}` } });
    expect(l.providerUses()).toHaveLength(1);
    expect(l.providerUses()[0]?.matched).toEqual(['provider-token']);
    expect(l.hits()).toHaveLength(0);
  });

  it('does not count its own control request, and does count a forged one with the wrong run id', async () => {
    const set = new CanarySet('r5');
    const l = await listen(set);
    await l.control();
    expect(l.controlsSeen()).toBe(1);
    expect(l.count()).toBe(0);
    await fetch(url(l, '/x'), { headers: { [CONTROL_HEADER]: 'other-run' } });
    expect(l.count()).toBe(1);
  });
});
