import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Lang } from './i18n.ts';
import type { FloorView } from './model.ts';
import type { Hq } from './useHq.ts';

export const Drawer = ({
  kind,
  view,
  hq,
  lang,
  langs,
  onLang,
  onClose,
}: {
  kind: 'actions' | 'debug' | 'settings';
  view: FloorView;
  hq: Hq;
  lang: Lang;
  langs: readonly Lang[];
  onLang: (lang: Lang) => void;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement;
    close.current?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);
  // i18n-keys: floor.actions.title floor.debug.title floor.settings.title
  const title = t(`floor.${kind}.title`);
  return (
    <div className="dim">
      <section
        className="drawer panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={`drawer-${kind}`}
      >
        <div className="row">
          <h2 className="pixel">{title}</h2>
          <button ref={close} type="button" className="btn small" aria-label={t('floor.hud.close')} onClick={onClose}>
            ✕
          </button>
        </div>
        {kind === 'settings' ? (
          <section aria-labelledby="settings-project">
            <h3 id="settings-project" className="pixel small-title">
              {t('floor.settings.project')}
            </h3>
            <dl className="debug">
              <dt>{t('floor.settings.language')}</dt>
              <dd>
                <fieldset className="seg">
                  <legend className="sr-only">{t('floor.settings.language')}</legend>
                  {langs.map((code) => (
                    <button
                      key={code}
                      type="button"
                      className={`btn small${code === lang ? ' on' : ''}`}
                      aria-pressed={code === lang}
                      data-testid={`lang-${code}`}
                      onClick={() => onLang(code)}
                    >
                      {code.toUpperCase()}
                    </button>
                  ))}
                </fieldset>
              </dd>
            </dl>
          </section>
        ) : kind === 'actions' ? (
          view.actions.length === 0 ? (
            <p>{t('floor.actions.empty')}</p>
          ) : (
            <ul className="tickets">
              {view.actions.map((action) => (
                <li key={action.key} className="ticket">
                  {action.worker === null ? null : (
                    <b className="pixel">{t('floor.actions.for', { name: action.worker })}</b>
                  )}
                  <span>
                    {/* i18n-keys: floor.actions.kind.ready_to_merge floor.actions.kind.closed_unmerged floor.actions.kind.round_limit floor.actions.kind.checks_failed floor.actions.kind.website floor.actions.kind.alert floor.actions.kind.job_failed */}
                    {t(`floor.actions.kind.${action.kind}`, { task: action.task ?? '', detail: action.detail ?? '' })}
                  </span>
                  {action.url === null ? null : (
                    <a href={action.url} rel="noreferrer" target="_blank">
                      {t('floor.actions.open')}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )
        ) : (
          <dl className="debug">
            <dt>{t('floor.debug.socket')}</dt>
            <dd>{hq.open ? t('floor.debug.socketOpen') : t('floor.debug.socketClosed')}</dd>
            <dt>{t('floor.debug.rev')}</dt>
            <dd data-testid="debug-rev">{view.rev}</dd>
            <dt>{t('floor.debug.mode')}</dt>
            <dd>{hq.demo === null ? t('floor.debug.modeLive') : t('floor.debug.modeDemo')}</dd>
            {hq.demo === null ? null : (
              <>
                <dt>{t('floor.debug.source')}</dt>
                <dd>{hq.demo.source}</dd>
                <dt>{t('floor.debug.events')}</dt>
                <dd>
                  {hq.demo.replayed} / {hq.demo.total}
                </dd>
              </>
            )}
            <dt>{t('floor.debug.boxes')}</dt>
            <dd>{view.boxes.length}</dd>
          </dl>
        )}
      </section>
    </div>
  );
};
