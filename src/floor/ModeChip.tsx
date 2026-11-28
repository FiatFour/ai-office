import { useTranslation } from 'react-i18next';
import type { HostInfo } from '../../server/snapshot/host.ts';

const OS_SHORT: Record<HostInfo['os'], string> = {
  windows: 'WIN',
  macos: 'MAC',
  linux: 'LINUX',
  wsl2: 'WSL2',
  other: 'OS',
};

/** The run mode and the computer HQ runs on. Cages is the only run mode so far. It opens the preflight screen. */
export const ModeChip = ({ host, running }: { host: HostInfo; running: number }) => {
  const { t } = useTranslation();
  const computer = `${OS_SHORT[host.os]} · ${host.shell.toUpperCase()}`;
  return (
    <a
      className="mode-chip"
      href="#/preflight"
      title={t('preflight.chip.label', { host: host.label })}
      data-testid="mode-chip"
    >
      <span className="pixel mode-host">{computer}</span>
      <span className="pixel mode-word">{t('preflight.chip.mode')}</span>
      <b>{t('preflight.chip.cages')}</b>
      <span className="mode-sep">|</span>
      <span>
        {t('preflight.chip.sandbox')} <b>{running}</b> {t('preflight.chip.running')}
      </span>
      <span className="mode-dot" aria-hidden="true" />
    </a>
  );
};
