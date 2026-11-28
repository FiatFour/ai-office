import { ENGINE_NAMES, type EngineName } from '../sandbox/engine.ts';
import { type HostEngine, type HostInfo, hostInfo } from '../snapshot/host.ts';
import { type Check, canStart, type DoctorContext, runDoctor } from './checks.ts';

export interface PreflightReport {
  readonly checkedAt: number;
  readonly host: HostInfo;
  readonly checks: readonly Check[];
  readonly canStart: boolean;
}

const once = <T>(ask: () => Promise<T>): (() => Promise<T>) => {
  let asked: Promise<T> | undefined;
  return () => (asked ??= ask());
};

/** One run of the doctor checks and the host's engine list, asking each engine each question once. */
export const inspect = async (ctx: DoctorContext): Promise<PreflightReport> => {
  const asking = (name: EngineName) => {
    const engine = ctx.engines[name];
    return { ...engine, version: once(() => engine.version()), info: once(() => engine.info()) };
  };
  const engines = { docker: asking('docker'), podman: asking('podman') };
  const [checks, listed] = await Promise.all([
    runDoctor({ ...ctx, engines }),
    Promise.all(
      ENGINE_NAMES.map(async (name): Promise<HostEngine[]> => {
        if ((await engines[name].version()) === null) return [];
        const info = await engines[name].info();
        return [
          info.ok
            ? { name, running: true, version: info.version ?? '', rootless: info.rootless }
            : { name, running: false },
        ];
      }),
    ),
  ]);
  return {
    checkedAt: Date.now(),
    host: { ...hostInfo(ctx.host, ctx.exists), engines: listed.flat() },
    checks,
    canStart: canStart(checks),
  };
};

export interface Preflight {
  /** The host as last seen. */
  readonly host: () => HostInfo;
  /** Runs the checks. Callers that arrive while a run is going share it, so a page cannot pile up engine processes. */
  readonly run: (port: number) => Promise<PreflightReport>;
}

export const preflightService = (context: (port: number) => DoctorContext): Preflight => {
  const first = context(0);
  let host = hostInfo(first.host, first.exists);
  let running: Promise<PreflightReport> | null = null;
  return {
    host: () => host,
    run: (port) => {
      running ??= inspect(context(port))
        .then((report) => {
          host = report.host;
          return report;
        })
        .finally(() => {
          running = null;
        });
      return running;
    },
  };
};
