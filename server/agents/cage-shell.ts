import type { CageView, SandboxDriver } from '../sandbox/container.ts';
import type { CageShell } from './claude-code.ts';

export const cageShells = (
  driver: () => Promise<SandboxDriver | null>,
  source: string,
): ((worker: string, task: string) => CageShell) => {
  const cages = new Map<string, Promise<CageView>>();
  const cageFor = async (worker: string, task: string): Promise<{ active: SandboxDriver; cage: CageView }> => {
    const active = await driver();
    if (active === null) throw new Error('no container engine is available, so no cage can run an agent');
    const key = `${worker}\n${task}`;
    let cage = cages.get(key);
    if (cage === undefined) {
      cage = active.startCage({ task, worker, source });
      cages.set(key, cage);
      cage.catch(() => cages.delete(key));
    }
    return { active, cage: await cage };
  };
  return (worker, task) => ({
    async exec(argv, options) {
      const { active, cage } = await cageFor(worker, task);
      return active.exec(cage.id, argv, options);
    },
  });
};
