import { modesOf } from './modes.ts';
import { DOORS, type Task } from './tasks/types.ts';

export interface ThreatRow {
  readonly id: string;
  readonly vector: string;
  readonly modes: string;
}

const doorOf = (vector: string): string => vector.trim().toLowerCase().replace(/\s+/g, '-');

export const coverageProblems = (rows: readonly ThreatRow[], tasks: readonly Task[]): string[] => {
  const problems: string[] = [];
  const byId = new Map<string, Task>();
  for (const task of tasks) {
    if (byId.has(task.id)) problems.push(`task ${task.id} is defined twice`);
    byId.set(task.id, task);
    if (!DOORS.includes(task.door)) problems.push(`task ${task.id} has door ${task.door}, which is not a door`);
    if (task.ask.trim() === '') problems.push(`task ${task.id} has no injection text`);
  }
  for (const row of rows) {
    const task = byId.get(row.id);
    if (task === undefined) {
      problems.push(`threat-model row ${row.id} has no red-team task`);
      continue;
    }
    const doors = row.vector.split(',').map(doorOf);
    if (!doors.includes(task.door))
      problems.push(`task ${row.id} uses door ${task.door}, the row's vectors are ${doors.join(', ')}`);
    if (modesOf(row.modes).length === 0) problems.push(`row ${row.id} names no run mode`);
  }
  const ids = new Set(rows.map((row) => row.id));
  for (const task of tasks) if (!ids.has(task.id)) problems.push(`task ${task.id} has no threat-model row`);
  return problems;
};
