import { describe, expect, it } from 'vitest';
import { SandboxDriver } from '../sandbox/container.ts';
import type { Engine } from '../sandbox/engine.ts';
import { siteOf } from '../sandbox/site.ts';

const REFUSED = [
  '*.com',
  '*.evil.example',
  '*',
  'a.com\nb.com',
  'a.com\n*.com',
  'a.com#x',
  'a.com #x',
  ' a.com ',
  'a.com..',
  'a..com',
  '-a.com',
  'a-.com',
  'a_b.com',
  'a\u200b.com',
  'a/b.com',
  'a@b.com',
  'a.com:0',
  'a.com:65536',
  'a.com:443:443',
  '1.2.3.4',
  '127.1',
  '[::1]',
  '',
];

describe('the one website validator behind Allow and the proxy allowlist', () => {
  it('takes a plain host name, IDN included, and nothing else', () => {
    expect(siteOf('A.COM.')).toEqual({ site: 'a.com:443', host: 'a.com', port: 443 });
    expect(siteOf('b\u00fccher.de')?.site).toBe('xn--bcher-kva.de:443');
    expect(siteOf('a.com:8443')?.site).toBe('a.com:8443');
    expect(siteOf('a.com', 22)?.site).toBe('a.com:22');
    for (const raw of REFUSED) expect(siteOf(raw), JSON.stringify(raw)).toBeNull();
  });

  it('makes driver.allow refuse the same rules before it touches the proxy', async () => {
    const driver = new SandboxDriver({ engine: {} as Engine, home: '/nowhere', hq: 'http://x', image: 'x' });
    for (const rule of [...REFUSED, 'a.com', 'A.com:443'])
      await expect(driver.allow(rule), JSON.stringify(rule)).rejects.toThrow(/not a host rule/);
  });
});
