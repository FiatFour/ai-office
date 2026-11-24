import { describe, expect, it } from 'vitest';
import { mountRefused } from './engines.ts';

describe('the Windows bind mount probe', () => {
  it('reads a daemon that cannot see the Windows path as a refusal', () => {
    expect(
      mountRefused(
        'docker: Error response from daemon: invalid mount config for type "bind": invalid mount path: \'C:/Users/x\' mount path must be absolute.',
      ),
    ).toBe(true);
  });

  it('reads a missing image as an accepted mount', () => {
    expect(
      mountRefused(
        "Unable to find image 'aw-no-such-image:0' locally\ndocker: Error response from daemon: pull access denied",
      ),
    ).toBe(false);
    expect(mountRefused('')).toBe(false);
  });
});
