import { describe, expect, it } from 'vitest';
import { contrastProblems, motionProblems, rawKeyProblems, rowRatio } from '../e2e/gates.mjs';
import { registerScreens } from '../floor/screens.ts';

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

  it('lists a gradient or image as not measured instead of passing it silently', () => {
    expect(contrastProblems([{ ...row(opaque(0, 0, 0), [opaque(0, 0, 0)]), unknown: true }], 't').unchecked).toBe(1);
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
});

const Component = () => null;

describe('screen registry', () => {
  it('refuses two screen files for one folder', () => {
    const screen = { id: 'a', Component };
    expect(() =>
      registerScreens({ '../screens/a/screen.tsx': { screen }, '../../screens/a/screen.tsx': { screen } }),
    ).toThrow('two screens named a');
  });
});
