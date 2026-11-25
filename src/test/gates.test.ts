import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { hasSqlite } from '../../server/test/helpers.ts';
import { negativeNote } from '../e2e/canvas-compare.mjs';
import {
  allowlistProblems,
  behindRatio,
  contrastProblems,
  motionProblems,
  notReadyLines,
  rawKeyProblems,
  registeredScreens,
  rowRatio,
} from '../e2e/gates.mjs';
import { freePort, interruptible, startHq, syntheticFiles, withFreePort, within } from '../e2e/harness.mjs';

const opaque = (r: number, g: number, b: number) => [r, g, b, 255];
const row = (fg: number[], layers: number[][], html = '<p>') => ({ text: 'x', html, fg, layers, unknown: false });

describe('contrast gate arithmetic', () => {
  it('puts #767676 on white just over 4.5 and #777777 just under', () => {
    expect(rowRatio(row(opaque(0x76, 0x76, 0x76), [opaque(255, 255, 255)]))).toBe(4.54);
    expect(rowRatio(row(opaque(0x77, 0x77, 0x77), [opaque(255, 255, 255)]))).toBe(4.48);
    expect(contrastProblems([row(opaque(0x76, 0x76, 0x76), [opaque(255, 255, 255)])], 't').problems).toEqual([]);
    expect(contrastProblems([row(opaque(0x77, 0x77, 0x77), [opaque(255, 255, 255)])], 't').problems).toHaveLength(1);
  });

  it('blends a translucent background and translucent text before measuring', () => {
    const half = [0, 0, 0, 128];
    expect(rowRatio(row(opaque(255, 255, 255), [half, opaque(255, 255, 255)]))).toBeCloseTo(3.95, 1);
    expect(rowRatio(row([0, 0, 0, 128], [opaque(255, 255, 255)]))).toBeCloseTo(3.95, 1);
  });

  it('measures text over a gradient or image by its worst pixel behind it', () => {
    const light = row(opaque(0xbb, 0xbb, 0xbb), [opaque(255, 255, 255)]);
    expect(behindRatio(light, [[255, 255, 255]])).toBeCloseTo(1.92, 1);
    expect(
      behindRatio(row(opaque(0x55, 0x55, 0x55), []), [
        [255, 255, 255],
        [0, 0, 0],
      ]),
    ).toBeLessThan(3);
    const over = { ...light, unknown: true, behind: [[255, 255, 255]] };
    expect(contrastProblems([over], 't').problems).toEqual(['t "x" 1.92:1, needs 4.5:1']);
    const fine = {
      ...row(opaque(0x22, 0x22, 0x22), []),
      unknown: true,
      behind: [
        [255, 255, 255],
        [238, 238, 238],
      ],
    };
    expect(contrastProblems([fine], 't').problems).toEqual([]);
    const mixed = {
      ...fine,
      behind: [
        [255, 255, 255],
        [20, 20, 20],
      ],
    };
    expect(contrastProblems([mixed], 't').problems).toHaveLength(1);
  });

  it('fails text it cannot measure over a gradient unless the screen allowlists it with a reason', () => {
    const unmeasured = { ...row(opaque(0, 0, 0), [opaque(0, 0, 0)]), unknown: true };
    expect(contrastProblems([unmeasured], 't').problems).toEqual([
      't "x" over a gradient or image is not measurable, and its screen does not allowlist it',
    ]);
    expect(contrastProblems([{ ...unmeasured, behind: null }], 't').problems).toHaveLength(1);
    expect(contrastProblems([{ ...unmeasured, behind: [] }], 't').problems).toHaveLength(1);
    expect(contrastProblems([{ ...unmeasured, allowed: 'its own gradient' }], 't')).toEqual({
      problems: [],
      exceptions: [],
      allowed: ['t "x" over a gradient or image is allowlisted: its own gradient'],
    });
  });

  it('compares the ratio unrounded, so 4.4967 (which displays as 4.50) fails', () => {
    const teal = row(opaque(23, 132, 132), [opaque(255, 255, 255)]);
    expect(rowRatio(teal)).toBe(4.5);
    expect(contrastProblems([teal], 't').problems).toEqual(['t "x" 4.497:1, needs 4.5:1']);
    const pixels = [[255, 255, 255]];
    expect(contrastProblems([{ ...teal, unknown: true, behind: pixels }], 't').problems).toHaveLength(1);
  });

  it('lets an allowlist excuse only text the sampler could not measure', () => {
    const base = { ...row(opaque(0xbb, 0xbb, 0xbb), [opaque(255, 255, 255)]), unknown: true, allowed: 'it is fine' };
    // measured pixels: judged by them, the allowlist does not matter
    expect(contrastProblems([{ ...base, behind: [[255, 255, 255]] }], 't').problems).toHaveLength(1);
    // could not sample, or clipped to its own text: the allowlist excuses it
    for (const found of [{}, { behind: null }, { behind: [] }, { clipped: true, behind: [[255, 255, 255]] }])
      expect(contrastProblems([{ ...base, ...found }], 't')).toMatchObject({
        problems: [],
        allowed: [expect.any(String)],
      });
  });

  it('refuses an allowlist selector by what it matches: a page root or more than 3 text rows, whatever its spelling', () => {
    const entry = (selector: string, roots: boolean, rows: number, valid = true) => ({ selector, roots, rows, valid });
    for (const selector of [
      '*',
      'BODY',
      'html body',
      'body *',
      '[class]',
      ':not(.x)',
      'main',
      '#root',
      'p, body',
      ' * ',
    ])
      expect(allowlistProblems([entry(selector, true, 1)], 't')).toMatchObject({
        refused: [selector],
        problems: [
          expect.stringContaining(`contrastAllow selector "${selector}" is too broad: it matches the whole page`),
        ],
      });
    expect(allowlistProblems([entry('p', false, 4)], 't').problems).toEqual([
      't contrastAllow selector "p" is too broad: it covers 4 text rows, more than 3, so it excuses nothing; name the element',
    ]);
    expect(allowlistProblems([entry('#v1,#v2,#v3,#v4', false, 4)], 't').refused).toEqual(['#v1,#v2,#v3,#v4']);
    expect(
      allowlistProblems([entry('p', false, 3), entry('.clip', false, 1), entry('section p', false, 0)], 't'),
    ).toEqual({
      problems: [],
      refused: [],
    });
    expect(allowlistProblems([entry('p[', false, 0, false)], 't').problems[0]).toContain('is not a valid selector');
  });

  it('excuses only the Needs-you chip, matched on colours, ratio, class and mood', () => {
    const chip = '<span class="chip" data-mood="needs">';
    const cream = opaque(0xf5, 0xf3, 0xec);
    const red = opaque(0xef, 0x53, 0x50);
    expect(contrastProblems([row(cream, [red], chip)], 't')).toMatchObject({
      problems: [],
      exceptions: [expect.any(String)],
    });
    expect(contrastProblems([row(cream, [red], '<span class="chip" data-mood="idle">')], 't').problems).toHaveLength(1);
    expect(contrastProblems([row(opaque(0xf5, 0xf3, 0xed), [red], chip)], 't').problems).toHaveLength(1);
  });
});

describe('key and motion gate arithmetic', () => {
  it('flags a text that is a dotted locale key and nothing else', () => {
    expect(
      rawKeyProblems(['floor.hud.demo', 'Demo data', 'v1.2', 'floor.yaml is a file', 'agent-works.yaml'], 't', [
        'floor',
      ]),
    ).toEqual(['t shows the raw key "floor.hud.demo"']);
  });

  it('flags running animations and SVG animation elements', () => {
    expect(motionProblems({ running: [], smil: 0 }, 't')).toEqual([]);
    expect(motionProblems({ running: ['CSSAnimation belt'], smil: 2 }, 't')).toHaveLength(2);
  });

  it('flags an element moved by script, which no animation object shows', () => {
    expect(motionProblems({ running: [], smil: 0, scripted: ['div.spark'] }, 't')).toEqual([
      't moves div.spark by script under prefers-reduced-motion',
    ]);
  });
});

describe('registered screens', () => {
  it('lists the synthetic zz-gate-* screens only while lane 11b sets its flag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-screens-'));
    try {
      for (const id of ['hq', 'zz-gate-good', 'zz-gate-render', 'terminal']) {
        mkdirSync(join(dir, id));
        writeFileSync(join(dir, id, 'screen.tsx'), '');
      }
      mkdirSync(join(dir, 'empty'));
      expect(registeredScreens(dir, {})).toEqual(['hq', 'terminal']);
      expect(registeredScreens(dir, { AW_GATE_FIXTURES: '0' })).toEqual(['hq', 'terminal']);
      expect(registeredScreens(dir, { AW_GATE_FIXTURES: '1' }).sort()).toEqual([
        'hq',
        'terminal',
        'zz-gate-good',
        'zz-gate-render',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('port choice', () => {
  const hold = async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, port: (server.address() as AddressInfo).port };
  };

  it('hands out a port nothing holds, even while the last one is still held', async () => {
    const first = await freePort();
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(first, '127.0.0.1', resolve));
    try {
      for (let i = 0; i < 5; i += 1) expect(await freePort()).not.toBe(first);
    } finally {
      server.close();
    }
  });

  it('retries a start that lost its port', async () => {
    const tried: number[] = [];
    const ports = [7, 7, 41000];
    const got = await withFreePort(
      async (port) => {
        tried.push(port);
        if (port === 7) throw new Error('EADDRINUSE');
        return port;
      },
      5,
      async () => ports.shift() ?? 0,
    );
    expect(tried).toEqual([7, 7, 41000]);
    expect(got).toBe(41000);
    await expect(
      withFreePort(
        async () => {
          throw new Error('always');
        },
        2,
        async () => 1,
      ),
    ).rejects.toThrow('always');
  });

  it('gives up at once when the HQ it started exits, instead of waiting out the deadline', async () => {
    const { server, port } = await hold();
    try {
      await expect(startHq({ port })).rejects.toThrow(`HQ exited on port ${port}`);
    } finally {
      server.close();
    }
  }, 12_000);
});

describe('not ready lines', () => {
  it('names the screen and the cause, and only for a screen that was not ready', () => {
    expect(
      notReadyLines([
        { screen: 'a', notReady: null },
        { screen: 'probe', notReady: 'not ready' },
        { screen: 'b', notReady: 'screen prob: exports id prob, expected probe' },
      ]),
    ).toEqual(['FAIL lane 11 probe: not ready', 'FAIL lane 11 b: screen prob: exports id prob, expected probe']);
  });
});

describe('compare verdict note', () => {
  it('says when the entry negative tests were skipped', () => {
    expect(negativeNote(0)).toContain('SKIPPED');
    expect(negativeNote(0)).toContain('2 layout');
    expect(negativeNote(9)).toBe('11 negative tests each failed as they should');
    expect(negativeNote(9)).not.toContain('SKIPPED');
  });
});

const answers = async (url: string) => {
  try {
    return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(500) })).ok;
  } catch {
    return false;
  }
};
const never = async (url: string, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await answers(url)) return false;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return true;
};

/** `os.tmpdir()` reads TMPDIR on Linux and macOS and TEMP or TMP on Windows. */
const tmpEnv = (dir: string) => ({ TMPDIR: dir, TEMP: dir, TMP: dir });
const homesIn = (dir: string) => readdirSync(dir).filter((name) => name.startsWith('aw-e2e-'));

describe.skipIf(!hasSqlite)('an HQ the gate kit starts never outlives the run', () => {
  it('stops an HQ that is still starting when a signal arrives, and refuses to start another', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'gate-starting-'));
    for (const [name, value] of Object.entries(tmpEnv(scratch))) vi.stubEnv(name, value);
    try {
      vi.resetModules();
      const harness = await import('../e2e/harness.mjs');
      const port = await harness.freePort();
      const starting = harness.startHq({ port });
      const outcome = starting.then(
        () => 'started',
        (error: Error) => error.message,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(homesIn(scratch)).toHaveLength(1);
      await harness.stopAllHq();
      expect(await outcome).toContain('HQ exited');
      expect(await never(`http://127.0.0.1:${port}`, 4000)).toBe(true);
      expect(homesIn(scratch)).toEqual([]);
      await expect(harness.startHq({ port: await harness.freePort() })).rejects.toThrow('refused');
    } finally {
      vi.unstubAllEnvs();
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);

  it('kills its children and removes their homes when the process exits without cleaning up', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'gate-exit-'));
    try {
      const script = `import { startHqFree } from ${JSON.stringify(new URL('../e2e/harness.mjs', import.meta.url).href)};
        const hq = await startHqFree(); console.log(hq.url); process.exit(0);`;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        env: { ...process.env, ...tmpEnv(scratch) },
      });
      expect(await never(out.trim(), 3000)).toBe(true);
      expect(homesIn(scratch)).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('an interrupted run', () => {
  it('cleans up on the first signal and exits at once on the second, even while the cleanup hangs', async () => {
    const exits: number[] = [];
    let cleaned = 0;
    const run = interruptible({
      cleanup: () => {
        cleaned += 1;
        return new Promise(() => {});
      },
      exit: (code) => exits.push(code),
      limitMs: 60_000,
    });
    expect(run.stopping).toBe(false);
    run.on(130)();
    expect([cleaned, exits, run.stopping]).toEqual([1, [], true]);
    run.on(130)();
    expect([cleaned, exits]).toEqual([1, [130]]);
  });

  it('gives up on a cleanup that takes longer than its limit', async () => {
    const exits: number[] = [];
    interruptible({ cleanup: () => new Promise(() => {}), exit: (code) => exits.push(code), limitMs: 50 }).on(143)();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(exits).toEqual([143]);
  });

  it('exits after a cleanup that finishes', async () => {
    const exits: number[] = [];
    interruptible({ cleanup: async () => {}, exit: (code) => exits.push(code) }).on(130)();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exits).toEqual([130]);
  });
});

describe('browser close', () => {
  it('is given up on after its timeout instead of hanging the run', async () => {
    expect(await within(new Promise(() => {}), 50)).toBeUndefined();
    expect(await within(Promise.resolve('closed'), 50)).toBe('closed');
  });
});

describe('synthetic gate screens', () => {
  it('are never tracked: no tracked file path uses the zz-gate- prefix', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], {
      encoding: 'utf8',
      cwd: join(import.meta.dirname, '..', '..'),
    })
      .split('\0')
      .filter(Boolean);
    expect(syntheticFiles(tracked)).toEqual([]);
    expect(syntheticFiles(['src/screens/zz-gate-good/screen.tsx', 'src/screens/hq/screen.tsx'])).toEqual([
      'src/screens/zz-gate-good/screen.tsx',
    ]);
  });
});
