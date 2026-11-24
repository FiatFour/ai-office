import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerScreens, SCREENS, screenFromHash } from '../floor/screens.ts';

const Component = () => null;
const at = (dir: string, id = dir) => [`../screens/${dir}/screen.tsx`, { screen: { id, Component } }] as const;

describe('screen registry', () => {
  it('finds every src/screens/<id>/screen.tsx by glob, so no shared file lists them', () => {
    expect(SCREENS.map((screen) => screen.id)).toEqual([...SCREENS.map((screen) => screen.id)].sort());
  });

  it('registers screens sorted by id and routes #/<id> to them', () => {
    const screens = registerScreens(Object.fromEntries([at('terminal'), at('preflight')]));
    expect(screens.map((screen) => screen.id)).toEqual(['preflight', 'terminal']);
    expect(screenFromHash('#/terminal', screens)?.id).toBe('terminal');
    expect(screenFromHash('', screens)).toBeNull();
    expect(screenFromHash('#/terminal/x', screens)).toBeNull();
  });

  it('refuses a screen whose id is not its directory, a file with no export, and a stray path', () => {
    expect(() => registerScreens(Object.fromEntries([at('terminal', 'term')]))).toThrow('expected "terminal"');
    expect(() => registerScreens({ '../screens/a/screen.tsx': {} })).toThrow('must export `screen`');
    expect(() => registerScreens({ '../elsewhere/screen.tsx': { screen: { id: 'a', Component } } })).toThrow(
      'not a screen file',
    );
  });
});

describe('canvas artboards', () => {
  it('holds all 24 artboards the canvas lists, as docs/review/canvas/<Name>.dc.txt', () => {
    const dir = join(import.meta.dirname, '../../docs/review/canvas');
    const boards = Object.keys(JSON.parse(readFileSync(join(dir, 'canvas.json'), 'utf8')).boards as object);
    expect(boards).toHaveLength(24);
    for (const board of boards) {
      const text = readFileSync(join(dir, board.replace(/\.dc\.html$/, '.dc.txt')), 'utf8');
      expect(text).toContain('<x-dc>');
    }
  });
});
