import { describe, expect, it } from 'vitest';
import { boxPosition, MAX_WORKERS, STATION_X, workerPosition } from '../floor/layout.ts';
import { STATIONS } from '../floor/model.ts';

describe('scene layout', () => {
  it('draws one cage and one worker for each of six workers', () => {
    expect(MAX_WORKERS).toBe(6);
  });

  it('places the stations left to right in the order of the line, each on its own gantry', () => {
    const xs = STATIONS.map((station) => STATION_X[station]);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(new Set(xs).size).toBe(STATIONS.length);
    expect(STATION_X.MERGE).toBeGreaterThan(STATION_X.QC);
  });

  it('stacks boxes on a station upward and parks a scrapped box off the belt', () => {
    expect(boxPosition('QC', 0).x).toBe(STATION_X.QC);
    expect(boxPosition('QC', 1).y).toBeLessThan(boxPosition('QC', 0).y);
    expect(boxPosition(null, 0).x).not.toBe(STATION_X.ORDER);
  });

  it('sends a worker that is At QC to the QC gantry and one On break to the break room', () => {
    expect(workerPosition('qc', 0).x).toBeGreaterThan(STATION_X.QC);
    expect(workerPosition('qc', 0).x).toBeLessThan(STATION_X.MERGE);
    expect(workerPosition('break', 0).y).toBeLessThan(workerPosition('working', 0).y);
  });
});
