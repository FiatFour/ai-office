import type { Mood, StationLabel } from './model.ts';

export const SCENE = { width: 480, height: 270 } as const;
export const MAX_WORKERS = 6;

export const BELT_Y = 124;
export const STATION_X: Readonly<Record<StationLabel, number>> = {
  ORDER: 190,
  CODE: 214,
  TEST: 254,
  QC: 284,
  MERGE: 309,
  SHIPPING: 337,
};

export const boxPosition = (station: StationLabel | null, stack: number): { x: number; y: number } =>
  station === null ? { x: 192, y: 100 - stack * 10 } : { x: STATION_X[station], y: BELT_Y - stack * 10 };

export const cagePosition = (slot: number): { x: number; y: number } => ({
  x: 100 + 43 * (slot % 2),
  y: 108 + 44 * Math.floor(slot / 2),
});

export const workerPosition = (mood: Mood, slot: number): { x: number; y: number } => {
  const cage = cagePosition(slot);
  if (mood === 'qc') return { x: 287, y: 150 + 14 * slot };
  if (mood === 'break') return { x: 151 + 20 * (slot % 3), y: 64 + 18 * Math.floor(slot / 3) };
  return { x: cage.x + 14, y: cage.y + 18 };
};

export const percent = (x: number, y: number): { left: string; top: string } => ({
  left: `${(((x - 2) / SCENE.width) * 100).toFixed(2)}%`,
  top: `${(((y - 14) / SCENE.height) * 100).toFixed(2)}%`,
});
