import { randomBytes } from 'node:crypto';
import type { ArmName } from '../model.ts';

export interface Entry {
  readonly task: string;
  readonly arm: ArmName | 'seeded';
  readonly pr: number;
  readonly readyHeadSha: string;
}

export interface Sealed {
  readonly label: string;
  readonly entry: Entry;
}

export type Random = (bytes: number) => Buffer;

export const assignLabels = (entries: readonly Entry[], random: Random = randomBytes): Sealed[] => {
  const used = new Set<string>();
  const sealed = entries.map((entry) => {
    let label: string;
    do label = `pr-${random(4).toString('hex')}`;
    while (used.has(label));
    used.add(label);
    return { label, entry };
  });
  return sealed.sort((a, b) => (a.label < b.label ? -1 : 1));
};

export const sealedEntry = (key: readonly Sealed[], label: string): Entry => {
  const found = key.find((s) => s.label === label);
  if (found === undefined) throw new Error(`no PR is labelled ${label}`);
  return found.entry;
};
