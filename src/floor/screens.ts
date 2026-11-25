import type { ComponentType } from 'react';

/** `ready` is a selector that is present once the screen has drawn what its gates need. It defaults to the registry wrapper. `contrastAllow` lists elements the contrast gate may not measure, each with a reason. */
export type ScreenModule = {
  readonly id: string;
  readonly Component: ComponentType;
  readonly ready?: string;
  readonly contrastAllow?: readonly { readonly selector: string; readonly reason: string }[];
};

export type Loader = () => Promise<{ readonly screen?: ScreenModule }>;

export type Loaded =
  | { readonly ok: true; readonly screen: ScreenModule }
  | { readonly ok: false; readonly id: string; readonly error: string };

/** One route per screen folder. Loading is lazy and never throws, so a broken screen cannot take the floor down. */
export type Route = { readonly id: string; readonly load: () => Promise<Loaded> };

const SCREEN_FILE = /\/screens\/([\w-]+)\/screen\.tsx$/;

const fail = (id: string, text: string): Loaded => ({ ok: false, id, error: `screen ${id}: ${text}` });

export const validateScreen = (dir: string, module: { readonly screen?: ScreenModule }): Loaded => {
  const { screen } = module;
  if (screen === undefined) return fail(dir, 'must export `screen`');
  if (screen.id !== dir) return fail(screen.id, `exports id ${screen.id}, expected ${dir}`);
  if (typeof screen.Component !== 'function') return fail(dir, 'its screen has no Component');
  if (screen.ready !== undefined && typeof screen.ready !== 'string') return fail(dir, 'ready must be a selector');
  return { ok: true, screen };
};

export const loadScreen = async (dir: string, load: Loader): Promise<Loaded> => {
  try {
    return validateScreen(dir, await load());
  } catch (error) {
    return fail(dir, `failed to load: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/** Stray paths are returned as errors, a second file for one folder makes that folder's route an error. */
export const listRoutes = (
  loaders: Readonly<Record<string, Loader>>,
): { readonly routes: readonly Route[]; readonly errors: readonly string[] } => {
  const routes = new Map<string, Route>();
  const errors: string[] = [];
  for (const [path, load] of Object.entries(loaders)) {
    const dir = SCREEN_FILE.exec(path)?.[1];
    if (dir === undefined) {
      errors.push(`not a screen file: ${path}`);
      continue;
    }
    if (routes.has(dir)) {
      const error = `screen ${dir}: two screens named ${dir}`;
      errors.push(error);
      routes.set(dir, { id: dir, load: async () => fail(dir, `two screens named ${dir}`) });
    } else routes.set(dir, { id: dir, load: () => loadScreen(dir, load) });
  }
  return { routes: [...routes.values()].sort((a, b) => a.id.localeCompare(b.id)), errors };
};

export const routeFromHash = (hash: string, routes: readonly Route[]): Route | null =>
  routes.find((route) => hash === `#/${route.id}`) ?? null;

const listed = listRoutes(import.meta.glob<{ readonly screen?: ScreenModule }>('../screens/*/screen.tsx'));
for (const error of listed.errors) console.error(error);

export const ROUTES = listed.routes;
