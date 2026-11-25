import { describe, expect, it } from 'vitest';
import { flipLabel } from '../../spikes/P0-6/rows-firewall.mjs';

describe('flipLabel', () => {
  it('says nothing when the proxy denied the connect (403)', () => {
    expect(flipLabel(403)).toBe('');
  });
  it('says a connection opened on 200, the only status that proves one', () => {
    expect(flipLabel(200)).toBe('FLIP, a connection opened: ');
  });
  it('calls any other status a weak flip', () => {
    for (const status of [0, 502, 504]) expect(flipLabel(status)).toMatch(/^WEAK FLIP/);
  });
});
