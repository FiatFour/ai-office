import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Drawer } from './Drawer.tsx';
import { LANGS, type Lang } from './i18n.ts';
import { floorView, type Mood, STATIONS, type WorkerView } from './model.ts';
import { Scene } from './Scene.tsx';
import { useHq } from './useHq.ts';

const MOOD_CHIP: Record<Mood, { bg: string; fg: string }> = {
  working: { bg: '#42a5f5', fg: '#15181c' },
  needs: { bg: '#ef5350', fg: '#15181c' },
  qc: { bg: '#ffca28', fg: '#15181c' },
  break: { bg: '#9aa1ab', fg: '#15181c' },
};

const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName);

const MoodChip = ({ mood }: { mood: Mood }) => {
  const { t } = useTranslation();
  const { bg, fg } = MOOD_CHIP[mood];
  return (
    <span className="chip" style={{ background: bg, color: fg }} data-mood={mood}>
      {t(`floor.mood.${mood}`)}
    </span>
  );
};

const Card = ({ worker, onClose }: { worker: WorkerView; onClose: () => void }) => {
  const { t } = useTranslation();
  return (
    <section className="panel card" aria-label={t('floor.worker.file')} data-testid="worker-card">
      <div className="row">
        <b className="pixel">{worker.name.toUpperCase()}</b>
        <button type="button" className="btn small" aria-label={t('floor.hud.close')} onClick={onClose}>
          ✕
        </button>
      </div>
      <dl>
        <dt>{t('floor.worker.state')}</dt>
        <dd>
          <MoodChip mood={worker.mood} />
        </dd>
        <dt>{t('floor.worker.task')}</dt>
        <dd>{worker.task ?? t('floor.worker.none')}</dd>
        <dt>{t('floor.worker.station')}</dt>
        <dd>{worker.station ?? t('floor.worker.none')}</dd>
      </dl>
      <p className="say">{t(`floor.worker.says.${worker.mood}`)}</p>
    </section>
  );
};

export const App = ({ lang, onLang }: { lang: Lang; onLang: (lang: Lang) => void }) => {
  const { t } = useTranslation();
  const hq = useHq();
  const view = useMemo(() => (hq.snapshot === null ? null : floorView(hq.snapshot)), [hq.snapshot]);
  const [drawer, setDrawer] = useState<'actions' | 'debug' | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const shippedBefore = useRef(0);

  const names = useMemo(() => view?.workers.map((worker) => worker.name) ?? [], [view]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (typing(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Escape') setDrawer(null);
      else if (event.key === 'd' || event.key === 'D') setDrawer((open) => (open === 'debug' ? null : 'debug'));
      else if (/^[1-9]$/.test(event.key)) {
        const name = names[Number(event.key) - 1];
        if (name !== undefined) setSelected(name);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [names]);

  const shipped = view?.shipped ?? 0;
  useEffect(() => {
    if (shipped > shippedBefore.current) setToast(view?.boxes.find((box) => box.stamp === 'SHIPPED')?.id ?? '');
    shippedBefore.current = shipped;
  }, [shipped, view]);

  if (view === null || hq.snapshot === null) return <main className="boot">…</main>;
  const needing = view.workers.filter((worker) => worker.mood === 'needs').length;
  const card = view.workers.find((worker) => worker.name === selected) ?? null;
  const demo = hq.demo;

  return (
    <div className="floor" data-rev={view.rev}>
      <header className="hud top panel" inert={drawer !== null}>
        <svg width="26" height="26" viewBox="0 0 10 10" shapeRendering="crispEdges" aria-hidden="true">
          <rect x="0" y="4" width="10" height="6" fill="#ffca28" />
          <rect x="1" y="1" width="2" height="4" fill="#ffca28" />
          <rect x="4" y="2" width="2" height="3" fill="#ffca28" />
          <rect x="7" y="0" width="2" height="5" fill="#ffca28" />
          <rect x="1" y="6" width="2" height="2" fill="#15181c" />
          <rect x="4" y="6" width="2" height="2" fill="#15181c" />
          <rect x="7" y="6" width="2" height="2" fill="#15181c" />
        </svg>
        <b className="logo pixel">AGENT WORKS</b>
        {demo === null ? null : (
          <span className="chip demo" data-testid="demo-chip">
            {t('floor.hud.demo')}
          </span>
        )}
        <span className="status">
          {t('floor.debug.rev')} <span data-testid="rev">{view.rev}</span>
        </span>
        <span className="status" data-testid="conn">
          {hq.open ? t('floor.hud.live') : t('floor.hud.offline')}
        </span>
        {demo === null ? null : (
          <span className="status">{t('floor.hud.demoProgress', { done: demo.replayed, total: demo.total })}</span>
        )}
        <span className="grow" />
        <nav aria-label={t('floor.hud.menu')}>
          <button
            type="button"
            className="btn gold"
            aria-haspopup="dialog"
            data-testid="open-actions"
            onClick={() => setDrawer('actions')}
          >
            {t('floor.hud.actionItemsCount', { count: view.actions.length })}
          </button>
          <button
            type="button"
            className="btn"
            aria-haspopup="dialog"
            aria-keyshortcuts="D"
            data-testid="open-debug"
            onClick={() => setDrawer('debug')}
          >
            {t('floor.hud.debug')}
          </button>
        </nav>
      </header>

      <main inert={drawer !== null}>
        <h1 className="sr-only">{t('floor.title')}</h1>
        <Scene view={view} selected={selected} onSelect={setSelected} onAction={() => setDrawer('actions')} />
      </main>

      <aside className="hud left" aria-label={t('floor.hud.crew')} inert={drawer !== null}>
        <section className="panel" aria-label={t('floor.hud.crew')}>
          <h2 className="pixel small-title">
            {t('floor.hud.crewCount', { count: view.workers.length })}{' '}
            <span className="warn">{t('floor.hud.needYou', { count: needing })}</span>
          </h2>
          {view.workers.length === 0 ? <p>{t('floor.hud.noCrew')}</p> : null}
          <ul className="crew">
            {view.workers.map((worker, index) => (
              <li key={worker.name}>
                <button
                  type="button"
                  className={`btn crew-row${worker.name === selected ? ' on' : ''}`}
                  aria-keyshortcuts={String(index + 1)}
                  onClick={() => setSelected(worker.name)}
                >
                  <span className="key">{index + 1}</span>
                  <b className="pixel">{worker.name.toUpperCase()}</b>
                  <MoodChip mood={worker.mood} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      </aside>

      <aside className="hud right" aria-label={t('floor.hud.productionOrder')} inert={drawer !== null}>
        <section className="panel" aria-label={t('floor.hud.productionOrder')}>
          <h2 className="pixel small-title">{t('floor.hud.productionOrder')}</h2>
          <ul className="counts">
            {STATIONS.map((station) => (
              <li key={station} data-station={station}>
                <span className="pixel big" data-testid={`count-${station}`}>
                  {view.counts[station]}
                </span>
                <span>{t(`floor.station.${station}`)}</span>
              </li>
            ))}
          </ul>
          <p className="muted">
            {t('floor.hud.boxesTotal', { count: view.boxes.length })} ·{' '}
            {t('floor.hud.shippedTotal', { count: view.shipped })}
          </p>
        </section>
        {card === null ? null : <Card worker={card} onClose={() => setSelected(null)} />}
      </aside>

      {toast === null ? null : (
        <div className="toast panel pop" role="status">
          <svg width="34" height="26" viewBox="0 0 13 10" shapeRendering="crispEdges" aria-hidden="true">
            <rect x="0" y="2" width="8" height="6" fill="#eceff1" />
            <rect x="8" y="4" width="4" height="4" fill="#1565c0" />
            <rect x="9" y="5" width="2" height="1" fill="#90caf9" />
            <rect x="1" y="8" width="2" height="2" fill="#15181c" />
            <rect x="9" y="8" width="2" height="2" fill="#15181c" />
            <rect x="1" y="3" width="3" height="2" fill="#c49a6c" />
            <rect x="4" y="3" width="3" height="2" fill="#c49a6c" />
          </svg>
          <b className="pixel">{t('floor.hud.delivered')}</b>
          <span>{t('floor.hud.deliveredDetail', { task: toast })}</span>
          <button type="button" className="btn small" aria-label={t('floor.hud.close')} onClick={() => setToast(null)}>
            ✕
          </button>
        </div>
      )}

      {drawer === null ? null : (
        <Drawer
          kind={drawer}
          view={view}
          hq={hq}
          lang={lang}
          langs={LANGS}
          onLang={onLang}
          onClose={() => setDrawer(null)}
        />
      )}
    </div>
  );
};
