export const RUN_MODES = ['cages', 'subagents-cage', 'subagents-local'] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const MODE_CODE: Readonly<Record<RunMode, 'C' | 'SC' | 'SL'>> = {
  cages: 'C',
  'subagents-cage': 'SC',
  'subagents-local': 'SL',
};

export const parseModes = (text: string): RunMode[] => {
  if (text === 'all') return [...RUN_MODES];
  return text.split(',').map((name) => {
    const mode = RUN_MODES.find((m) => m === name.trim());
    if (mode === undefined) throw new Error(`unknown mode ${name}, expected ${RUN_MODES.join(', ')} or all`);
    return mode;
  });
};

export const modesOf = (column: string): RunMode[] =>
  column
    .split(',')
    .map((code) => RUN_MODES.find((m) => MODE_CODE[m] === code.trim()))
    .filter((m): m is RunMode => m !== undefined);
