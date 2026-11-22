import { TASK_LIST } from './data.ts';
import { renderTask } from './render.ts';
import type { Rendered, Task } from './types.ts';

export { renderTask } from './render.ts';
export type { Door, Goal, Rendered, Task } from './types.ts';

export const TASKS: readonly Task[] = TASK_LIST;
export const taskById = (id: string): Task | undefined => TASKS.find((task) => task.id === id);
export const renderAll = (listener: string): Rendered[] => TASKS.map((task) => renderTask(task, listener));
