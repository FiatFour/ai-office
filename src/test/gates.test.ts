import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
import { freePort, startHq, withFreePort } from '../e2e/harness.mjs';

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

  it('refuses broad allowlist selectors by name: *, body, html, main, #root and a bare tag matching more than 3 elements', () => {
    const entry = (selector: string, count: number, valid = true) => ({ selector, count, valid });
    for (const selector of ['*', 'body', 'html', 'main', '#root', ':root', ' * '])
      expect(allowlistProblems([entry(selector, 1)], 't')).toMatchObject({
        refused: [selector],
        problems: [
          expect.stringContaining(`contrastAllow selector "${selector}" is too broad: it matches the whole page`),
        ],
      });
    expect(allowlistProblems([entry('p', 4)], 't').problems).toEqual([
      't contrastAllow selector "p" is too broad: it is a bare tag that matches 4 elements, more than 3, so it excuses nothing; name the element',
    ]);
    expect(
      allowlistProblems([entry('p', 3), entry('.clip', 90), entry('section p', 90), entry('#hero', 1)], 't'),
    ).toEqual({
      problems: [],
      refused: [],
    });
    expect(allowlistProblems([entry('p[', 0, false)], 't').problems[0]).toContain('is not a valid selector');
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
