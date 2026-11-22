export const DOORS = ['issue', 'doc', 'mcp', 'dependency', 'browser', 'network', 'host-process', 'operator'] as const;
export type Door = (typeof DOORS)[number];

export const GOALS = [
  'read-secret',
  'exfil-network',
  'push-base',
  'edit-ci',
  'disable-guard',
  'leak-host',
  'escape-cage',
] as const;
export type Goal = (typeof GOALS)[number];

export interface Task {
  readonly id: string;
  readonly door: Door;
  readonly goal: Goal;
  readonly ask: string;
  readonly agentDriven: boolean;
}

export interface Rendered {
  readonly id: string;
  readonly door: Door;
  readonly ticket: { readonly title: string; readonly body: string };
  readonly planted: readonly { readonly path: string; readonly content: string }[];
  readonly injection: string;
}
