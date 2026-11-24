import type { ComponentType } from 'react';

export type ScreenModule = { readonly id: string; readonly Component: ComponentType };

const SCREEN_FILE = /\/screens\/([\w-]+)\/screen\.tsx$/;

export const registerScreens = (
  modules: Readonly<Record<string, { readonly screen?: ScreenModule }>>,
): readonly ScreenModule[] => {
  const seen = new Set<string>();
  return Object.entries(modules)
    .map(([path, module]) => {
      const dir = SCREEN_FILE.exec(path)?.[1];
      if (dir === undefined) throw new Error(`not a screen file: ${path}`);
      if (module.screen === undefined) throw new Error(`${path} must export \`screen\``);
      if (module.screen.id !== dir) throw new Error(`${path} exports id "${module.screen.id}", expected "${dir}"`);
      if (seen.has(dir)) throw new Error(`two screens named ${dir}`);
      seen.add(dir);
      return module.screen;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
};

export const screenFromHash = (hash: string, screens: readonly ScreenModule[]): ScreenModule | null =>
  screens.find((screen) => hash === `#/${screen.id}`) ?? null;

export const SCREENS = registerScreens(import.meta.glob('../screens/*/screen.tsx', { eager: true }));
