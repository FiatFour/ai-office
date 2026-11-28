import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type Check,
  countOf,
  fetchReport,
  GROUP_ORDER,
  mayStart,
  needsFix,
  type PreflightReport,
  type Run,
  reportOf,
  STATUSES,
  verdictOf,
} from './model.ts';
import './preflight.css';

const useRun = () => {
  const [run, setRun] = useState<Run>({ phase: 'checking', last: null });
  const asked = useRef(0);
  /** Resolves to the state this run ended in, or null when a newer run replaced it. */
  const check = useCallback(async (): Promise<Run | null> => {
    asked.current += 1;
    const mine = asked.current;
    setRun((before) => ({ phase: 'checking', last: reportOf(before) }));
    const ended = await fetchReport().then(
      (report): Run => ({ phase: 'done', report }),
      (error: unknown): Run => ({ phase: 'error', message: error instanceof Error ? error.message : String(error) }),
    );
    if (mine !== asked.current) return null;
    setRun(ended);
    return ended;
  }, []);
  useEffect(() => {
    void check();
    return () => {
      asked.current += 1;
    };
  }, [check]);
  return { run, check };
};

const Detected = ({ report }: { report: PreflightReport }) => {
  const { t } = useTranslation();
  const { host } = report;
  const engines = (host.engines ?? []).map((engine) =>
    engine.running
      ? `${engine.name} ${engine.version}${engine.rootless ? ` ${t('preflight.engine.rootless')}` : ''}`
      : t('preflight.engine.stopped', { name: engine.name }),
  );
  return (
    <section className="panel pf-host" aria-label={t('preflight.detected')}>
      <span className="pixel pf-tag">{t('preflight.detected')}</span>
      <b data-testid="pf-host">{host.label}</b>
      <span className="pf-mute">
        {[host.shell, host.arch, host.kvm ? t('preflight.kvm.yes') : t('preflight.kvm.no')].join(' · ')}
      </span>
      <span className="pf-mute">{engines.length === 0 ? t('preflight.engine.none') : engines.join(' · ')}</span>
      <span className="pf-grow" />
      <span className="pf-mute">{t('preflight.runMode')}</span>
      <b>{t('preflight.cages')}</b>
    </section>
  );
};

const Row = ({ check, port, busy, again }: { check: Check; port: string; busy: boolean; again: () => void }) => {
  const { t } = useTranslation();
  return (
    <li className="pf-row" data-check={check.id} data-status={check.status}>
      <div className="pf-line">
        <span className="pixel pf-status">{check.status}</span>
        {/* i18n-keys: preflight.check.host preflight.check.node preflight.check.git preflight.check.port preflight.check.home preflight.check.engine preflight.check.rootless preflight.check.image preflight.check.kvm */}
        <b>{t(`preflight.check.${check.id}`, { port })}</b>
        <span className="pf-detail">{check.detail}</span>
      </div>
      {needsFix(check) && check.fix !== null ? (
        <div className="pf-fix">
          <span className="pixel pf-tag">{t('preflight.fix')}</span>
          <code>{check.fix}</code>
          <button type="button" className="btn small" disabled={busy} onClick={again}>
            {t('preflight.checkAgain')}
          </button>
        </div>
      ) : null}
    </li>
  );
};

const Preflight = () => {
  const { t } = useTranslation();
  const { run, check } = useRun();
  const report = reportOf(run);
  const verdict = verdictOf(run);
  const busy = run.phase === 'checking';
  const again = () => void check();
  /** Checks once more on the press, because the machine may have changed since the report on screen. */
  const start = async () => {
    const ended = await check();
    if (ended !== null && mayStart(ended)) location.hash = '';
  };
  const port = location.port;

  return (
    <div className="pf" data-phase={run.phase}>
      <header className="panel pf-head">
        <a className="pixel pf-logo" href="#/">
          AGENT WORKS
        </a>
        <span className="pf-mute">{t('preflight.back')}</span>
      </header>
      <main>
        <div className="pf-title">
          <h1 className="pixel">{t('preflight.title')}</h1>
          <span className="pf-mute">{t('preflight.intro')}</span>
          <span className="pf-grow" />
          <span className="pf-mute">
            {t('preflight.terminal')} <code>agent-works doctor</code>
          </span>
        </div>

        {report === null ? null : <Detected report={report} />}

        <section className="panel pf-verdict" data-verdict={verdict}>
          <div role="status" className="pf-summary">
            {/* i18n-keys: preflight.verdict.checking preflight.verdict.ready preflight.verdict.warned preflight.verdict.blocked preflight.verdict.failed */}
            <b className="pixel pf-word">{t(`preflight.verdict.${verdict}`)}</b>
            {report === null ? null : (
              <span className="pf-counts">
                {STATUSES.map((status) => (
                  <span key={status} data-count={status}>
                    {/* i18n-keys: preflight.count.PASS preflight.count.WARN preflight.count.FAIL preflight.count.SKIP */}
                    {t(`preflight.count.${status}`, { count: countOf(report.checks, status) })}
                  </span>
                ))}
              </span>
            )}
            {/* i18n-keys: preflight.hint.checking preflight.hint.ready preflight.hint.warned preflight.hint.blocked preflight.hint.failed */}
            <span>{t(`preflight.hint.${verdict}`)}</span>
            {run.phase === 'error' ? <code>{run.message}</code> : null}
          </div>
          <span className="pf-grow" />
          <button type="button" className="btn" disabled={busy} onClick={again} data-testid="pf-rerun">
            {t('preflight.rerun')}
          </button>
          <button
            type="button"
            className="btn gold pf-start"
            disabled={!mayStart(run)}
            onClick={() => void start()}
            data-testid="pf-start"
          >
            {t('preflight.start')}
          </button>
        </section>

        {report === null ? null : (
          <div className="pf-groups">
            {GROUP_ORDER.map((group) => {
              const checks = report.checks.filter((one) => one.group === group);
              const failed = countOf(checks, 'FAIL');
              const warned = countOf(checks, 'WARN');
              return (
                <section key={group} className="panel pf-card" data-group={group}>
                  <div className="pf-card-head">
                    {/* i18n-keys: preflight.group.computer preflight.group.sandbox */}
                    <h2 className="pixel">{t(`preflight.group.${group}`)}</h2>
                    <span className="pf-grow" />
                    <span className="pf-mute">
                      {failed > 0
                        ? t('preflight.tally.blocking', { count: failed })
                        : warned > 0
                          ? t('preflight.tally.warnings', { count: warned })
                          : t('preflight.tally.good')}
                    </span>
                  </div>
                  <ul>
                    {checks.map((one) => (
                      <Row key={one.id} check={one} port={port} busy={busy} again={again} />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
        <p className="pf-mute pf-foot">{t('preflight.footnote')}</p>
      </main>
    </div>
  );
};

export const screen = { id: 'preflight', ready: '.pf[data-phase="done"]', Component: Preflight };
