import { describe, expect, it, vi } from 'vitest';

vi.mock('../../server/sandbox/export.ts', async (original) => ({
  ...(await original<typeof import('../../server/sandbox/export.ts')>()),
  mount: (src: string, dst: string) => ['--mount', `type=bind,src=translated(${src}),dst=${dst}`],
}));

import { mountRefused, probeArgs } from './engines.ts';

describe('the Windows bind mount probe builds its bind with the driver', () => {
  it('uses whatever path the driver mount builder produces, not the raw host path', () => {
    const args = probeArgs('C:/Users/x');
    expect(args).toContain('type=bind,src=translated(C:/Users/x),dst=/m');
    expect(args.join(' ')).not.toContain('src=C:/Users/x');
  });
});

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
