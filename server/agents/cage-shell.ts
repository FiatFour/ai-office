import type { CageView, SandboxDriver } from '../sandbox/container.ts';
import type { CageShell } from './claude-code.ts';

export const cageShells = (
  driver: () => Promise<SandboxDriver | null>,
  source: string,
): ((worker: string, task: string) => CageShell) => {
  const cages = new Map<string, Promise<CageView>>();
  return (worker, task) => {
    const key = `${worker}\n${task}`;
    const cageFor = async (): Promise<{ active: SandboxDriver; cage: CageView }> => {
      const active = await driver();
      if (active === null) throw new Error('no container engine is available, so no cage can run an agent');
      let cage = cages.get(key);
      if (cage === undefined) {
        cage = active.startCage({ task, worker, source });
        cages.set(key, cage);
        cage.catch(() => cages.delete(key));
      }
      return { active, cage: await cage };
    };
    return {
      async renew() {
        const old = cages.get(key);
        if (old === undefined) return;
        cages.delete(key);
        const view = await old.catch(() => null);
        if (view !== null) await (await driver())?.releaseCage(view.id);
      },
      async exec(argv, options) {
        const { active, cage } = await cageFor();
        return active.exec(cage.id, argv, options);
      },
    };
  };
};
