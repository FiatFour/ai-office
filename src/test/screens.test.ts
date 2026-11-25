import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Loader, listRoutes, loadScreen, ROUTES, routeFromHash, validateScreen } from '../floor/screens.ts';

const Component = () => null;
const ok =
  (dir: string, id = dir): Loader =>
  async () => ({ screen: { id, Component } });
const at = (dir: string, load: Loader = ok(dir)) => [`../screens/${dir}/screen.tsx`, load] as const;

describe('screen registry', () => {
  it('lists every src/screens/<id>/screen.tsx by glob and every one of them loads, so a bad screen fails here', async () => {
    // `zz-gate-*` are lane 11b's synthetic screens, some broken on purpose. A leftover from a killed run is not a screen of the product.
    const real = ROUTES.filter((route) => process.env.AW_GATE_FIXTURES === '1' || !route.id.startsWith('zz-gate-'));
    expect(real.map((route) => route.id)).toEqual([...real.map((route) => route.id)].sort());
    for (const route of real) expect(await route.load()).toMatchObject({ ok: true });
  });

  it('sorts routes by id and routes #/<id> to them', () => {
    const { routes, errors } = listRoutes(Object.fromEntries([at('terminal'), at('preflight')]));
    expect(errors).toEqual([]);
    expect(routes.map((route) => route.id)).toEqual(['preflight', 'terminal']);
    expect(routeFromHash('#/terminal', routes)?.id).toBe('terminal');
    expect(routeFromHash('', routes)).toBeNull();
    expect(routeFromHash('#/terminal/x', routes)).toBeNull();
  });

  it('names the cause of a screen whose id is not its folder, one with no export, and a bad ready selector', () => {
    expect(validateScreen('probe', { screen: { id: 'prob', Component } })).toEqual({
      ok: false,
      id: 'prob',
      error: 'screen prob: exports id prob, expected probe',
    });
    expect(validateScreen('probe', {})).toMatchObject({ ok: false, error: 'screen probe: must export `screen`' });
    expect(validateScreen('probe', { screen: { id: 'probe', Component, ready: 3 as never } })).toMatchObject({
      ok: false,
      error: 'screen probe: ready must be a selector',
    });
    expect(validateScreen('probe', { screen: { id: 'probe', Component, ready: '#x' } })).toMatchObject({ ok: true });
  });

  it('turns a module that throws into an error for that screen only', async () => {
    const boom: Loader = async () => {
      throw new Error('boom');
    };
    const { routes } = listRoutes(Object.fromEntries([at('a'), at('b', boom), at('c')]));
    const loaded = await Promise.all(routes.map((route) => route.load()));
    expect(loaded.map((one) => one.ok)).toEqual([true, false, true]);
    expect(loaded[1]).toMatchObject({ error: 'screen b: failed to load: boom' });
    expect(await loadScreen('b', boom)).toMatchObject({ ok: false });
  });

  it('reports a stray path and makes a folder with two screen files an error route', async () => {
    const { routes, errors } = listRoutes({
      '../elsewhere/screen.tsx': ok('a'),
      '../screens/a/screen.tsx': ok('a'),
      '../../screens/a/screen.tsx': ok('a'),
    });
    expect(errors).toEqual(['not a screen file: ../elsewhere/screen.tsx', 'screen a: two screens named a']);
    expect(await routes[0]?.load()).toMatchObject({ ok: false, error: 'screen a: two screens named a' });
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
