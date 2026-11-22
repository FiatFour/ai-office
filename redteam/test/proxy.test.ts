import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROXY_DIR } from '../../spikes/P0-6/rig.mjs';

const PRODUCT = fileURLToPath(new URL('../../server/sandbox/proxy', import.meta.url));
const SPIKE = fileURLToPath(new URL('../../spikes/P0-2/proxy', import.meta.url));

describe('the proxy the red-team rig mounts', () => {
  it('is the product proxy, not a spike copy', () => {
    expect(PROXY_DIR).toBe(PRODUCT);
  });

  it('is byte for byte what the spike copy holds, so the two cannot drift apart unseen', () => {
    const files = readdirSync(PRODUCT).sort();
    expect(readdirSync(SPIKE).sort()).toEqual(files);
    for (const file of files)
      expect(readFileSync(join(SPIKE, file), 'utf8')).toBe(readFileSync(join(PRODUCT, file), 'utf8'));
  });
});
