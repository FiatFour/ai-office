import { appendFileSync } from 'node:fs';
import { describe, it } from 'vitest';

export type Status = 'pass' | 'fail' | 'not-run';

export interface Row {
  readonly driver: string;
  readonly os: string;
  readonly case: string | null;
  readonly status: Status;
  readonly reason: string | null;
}

const OS_NAMES: Record<string, string> = { linux: 'linux', darwin: 'macos', win32: 'windows' };

export const OS: string = OS_NAMES[process.platform] ?? process.platform;

export type DriverId = string;

export const record = (entry: Omit<Row, 'os'>): void => {
  const file = process.env.CONTRACT_RESULTS;
  if (file !== undefined && file !== '') appendFileSync(file, `${JSON.stringify({ ...entry, os: OS })}\n`);
};

export class NotRun extends Error {}

export interface Subject {
  readonly has: ReadonlySet<string>;
}

export interface Case<S extends Subject> {
  readonly id: string;
  readonly rule: string;
  readonly needs?: readonly string[];
  readonly run: (subject: S) => Promise<void>;
}

export interface Outcome {
  readonly status: Status;
  readonly reason: string | null;
  readonly error: unknown;
}

export const attempt = async <S extends Subject>(item: Case<S>, subject: S): Promise<Outcome> => {
  const lacking = (item.needs ?? []).filter((need) => !subject.has.has(need));
  if (lacking.length > 0) return { status: 'not-run', reason: `needs ${lacking.join(', ')}`, error: null };
  try {
    await item.run(subject);
    return { status: 'pass', reason: null, error: null };
  } catch (error) {
    if (error instanceof NotRun) return { status: 'not-run', reason: error.message, error: null };
    return {
      status: 'fail',
      reason: error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error),
      error,
    };
  }
};

export const registerCases = <S extends Subject>(
  driver: DriverId,
  cases: readonly Case<S>[],
  subject: () => S,
  timeoutMs: number,
): void => {
  for (const item of cases) {
    it(
      item.id,
      async (context) => {
        const outcome = await attempt(item, subject());
        record({ driver, case: item.id, status: outcome.status, reason: outcome.reason });
        if (outcome.status === 'not-run') context.skip(outcome.reason ?? 'not run');
        if (outcome.status === 'fail') throw outcome.error;
      },
      timeoutMs,
    );
  }
};

export const registerNotRun = (driver: DriverId, reason: string): void => {
  record({ driver, case: null, status: 'not-run', reason });
  describe(driver, () => {
    it.skip(`not run: ${reason}`, () => {});
  });
};
