import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { type Brief, checklistOf, checksUrl, HOSTS, type Page, type TimelineEntry } from './model.ts';

/** HQ never merges, so nothing here merges: the checkboxes stay in the page, and every action is a link. */

type Section = Brief['beforeMerge'];

const Missing = ({ reason }: { reason: string }) => {
  const { t } = useTranslation();
  return (
    <p className="mb-missing">
      <b>{t('merge-brief.notCollected')}</b> <span lang="en">{reason}</span>
    </p>
  );
};

const Lines = ({ section }: { section: Section }) =>
  section.state === 'collected' ? (
    <ul>
      {section.lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  ) : (
    <Missing reason={section.reason} />
  );

const Paper = ({ title, name, children }: { title: string; name: string; children: ReactNode }) => (
  <section className="mb-paper" data-section={name}>
    <h3 className="pixel">{title}</h3>
    {children}
  </section>
);

const Stats = ({ brief }: { brief: Brief }) => {
  const { t } = useTranslation();
  const { files, approvals } = brief;
  const lines =
    files.state === 'collected' && files.added !== null && files.deleted !== null
      ? `+${files.added} −${files.deleted}`
      : t('merge-brief.notCollected');
  const stats = [
    {
      id: 'files',
      label: t('merge-brief.stat.files'),
      value: files.state === 'collected' ? String(files.count) : '–',
      sub: lines,
    },
    {
      id: 'checks',
      label: t('merge-brief.stat.checks'),
      value: `${brief.checks.length} ✓`,
      sub: t('merge-brief.stat.checksSub'),
    },
    {
      id: 'approvals',
      label: t('merge-brief.stat.approvals'),
      value: `${approvals.by.length} / ${approvals.required}`,
      sub: approvals.by.join(' · '),
    },
    {
      id: 'rounds',
      label: t('merge-brief.stat.rounds'),
      value: String(brief.rounds),
      sub: t('merge-brief.stat.changesAsked', { count: brief.changesAsked }),
    },
    {
      id: 'comments',
      label: t('merge-brief.stat.comments'),
      value: String(brief.headComments),
      sub: t('merge-brief.stat.commentsSub'),
    },
  ];
  return (
    <ul className="mb-stats">
      {stats.map((stat) => (
        <li key={stat.id} data-stat={stat.id}>
          <span>{stat.label}</span>
          <b className="pixel">{stat.value}</b>
          <span>{stat.sub}</span>
        </li>
      ))}
    </ul>
  );
};

const Files = ({ brief }: { brief: Brief }) => {
  const { t } = useTranslation();
  const { files } = brief;
  if (files.state !== 'collected') return <Missing reason={files.reason} />;
  return (
    <>
      <ul>
        {files.list.map((file) => (
          <li key={file.path} className="mb-line" data-file={file.path}>
            <code className="mb-grow">{file.path}</code>
            {file.added === null || file.deleted === null ? (
              <span className="mb-mute">{t('merge-brief.notCollected')}</span>
            ) : (
              <>
                <code className="mb-add">+{file.added}</code>
                <code className="mb-del">−{file.deleted}</code>
              </>
            )}
          </li>
        ))}
      </ul>
      {files.count > files.list.length ? (
        <p>{t('merge-brief.moreFiles', { count: files.count - files.list.length })}</p>
      ) : null}
    </>
  );
};

const Checks = ({ brief }: { brief: Brief }) => {
  const { t } = useTranslation();
  return (
    <ul>
      {brief.checks.map((check, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a status and a check run can share a name
        <li key={i} className="mb-line" data-check={check.name}>
          <span className="mb-add" aria-hidden="true">
            ✓
          </span>
          <span className="mb-grow">{check.name}</span>
          <span className="mb-mute">{t('merge-brief.passed')}</span>
        </li>
      ))}
    </ul>
  );
};

const KINDS = ['ci_runs', 'test_output', 'screenshots', 'logs'] as const;

const Evidence = ({ brief }: { brief: Brief }) => {
  const { t } = useTranslation();
  const href = checksUrl(brief);
  return (
    <div className="mb-cards">
      {KINDS.map((kind) => {
        const section = brief.evidence[kind];
        return (
          <article key={kind} className="mb-card" data-evidence={kind} data-state={section.state}>
            {/* i18n-keys: merge-brief.evidence.ci_runs merge-brief.evidence.test_output merge-brief.evidence.screenshots merge-brief.evidence.logs */}
            <h4>{t(`merge-brief.evidence.${kind}`)}</h4>
            {section.state !== 'collected' ? (
              <Missing reason={section.reason} />
            ) : kind === 'ci_runs' ? (
              <p>
                {t('merge-brief.ciPassed', { count: brief.checks.length })} <code>{brief.head.slice(0, 7)}</code>
                {href === null ? null : (
                  <>
                    {' '}
                    <a href={href} target="_blank" rel="noreferrer">
                      {t('merge-brief.openChecks', { host: HOSTS[brief.host].name })}
                    </a>
                  </>
                )}
              </p>
            ) : (
              <Lines section={section} />
            )}
          </article>
        );
      })}
    </div>
  );
};

const Timeline = ({ entries }: { entries: readonly TimelineEntry[] }) => {
  const { t, i18n } = useTranslation();
  const when = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle: 'short' });
  return (
    <ol className="mb-timeline">
      {entries.map((entry, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: posted reviews never move
        <li key={i} data-verdict={entry.verdict}>
          <time dateTime={new Date(entry.at).toISOString()}>{when.format(entry.at)}</time>
          <div>
            {/* i18n-keys: merge-brief.verdict.approve merge-brief.verdict.changes merge-brief.verdict.comment */}
            <b>{entry.reviewer}</b> {t(`merge-brief.verdict.${entry.verdict}`, { round: entry.round })}{' '}
            <code>{entry.head.slice(0, 7)}</code>
            {entry.notes.map((note, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: notes of a posted review never move
              <p key={j} className="mb-note">
                {note}
              </p>
            ))}
          </div>
        </li>
      ))}
    </ol>
  );
};

interface Ticks {
  readonly ticked: ReadonlySet<string>;
  readonly onTick: (id: string) => void;
}

const Checklist = ({ brief, ticked, onTick }: { brief: Brief } & Ticks) => {
  const { t } = useTranslation();
  return (
    <ul>
      {checklistOf(brief).map(({ id, step }) => (
        <li key={id}>
          <label className="mb-tick">
            <input type="checkbox" data-tick={id} checked={ticked.has(id)} onChange={() => onTick(id)} />
            {/* i18n-keys: merge-brief.tick.read merge-brief.tick.setup merge-brief.tick.diff */}
            <span>{step ?? t(`merge-brief.tick.${id}`, { host: HOSTS[brief.host].name })}</span>
          </label>
        </li>
      ))}
    </ul>
  );
};

const Ready = ({ brief, ticked, onTick }: { brief: Brief } & Ticks) => {
  const { t, i18n } = useTranslation();
  const { name, kind, sign } = HOSTS[brief.host];
  const items = checklistOf(brief);
  const done = items.filter((item) => ticked.has(item.id)).length;
  const label =
    brief.phase === 'merged'
      ? t('merge-brief.open', { host: name })
      : done === items.length
        ? t('merge-brief.openToMergeDone', { host: name })
        : t('merge-brief.openToMerge', { host: name, done, total: items.length });
  return (
    <article className="mb-brief" data-brief={brief.phase} data-head={brief.head}>
      <div className="mb-banner">
        {/* i18n-keys: merge-brief.banner.ready merge-brief.banner.merged */}
        <b className="pixel">{t(`merge-brief.banner.${brief.phase}`)}</b>
        <span>
          <b>
            {kind} {sign}
            {brief.number} · {brief.title}
          </b>{' '}
          · {brief.repo} · {name} · {brief.branch} → {brief.base}
        </span>
        <span className="mb-grow" />
        <span className="mb-risk" data-risk={brief.risk?.level ?? 'none'}>
          {brief.risk === null ? t('merge-brief.riskUnset') : t('merge-brief.risk', { level: brief.risk.level })}
        </span>
      </div>
      <p className="mb-mute">
        {t('merge-brief.readAt', { host: name, time: new Date(brief.readAt).toLocaleTimeString(i18n.language) })}
      </p>
      <Stats brief={brief} />
      <div className="mb-columns">
        <div className="mb-wide">
          <Paper name="summary" title={t('merge-brief.summary')}>
            <p className="mb-text">{brief.summary}</p>
            <p className="mb-mute">{t('merge-brief.summaryFrom')}</p>
          </Paper>
          <Paper name="files" title={t('merge-brief.changed')}>
            <Files brief={brief} />
          </Paper>
          <Paper name="tests" title={t('merge-brief.tests')}>
            <Checks brief={brief} />
          </Paper>
          {brief.rootCause === null ? null : (
            <Paper name="root-cause" title={t('merge-brief.rootCause')}>
              <Lines section={brief.rootCause} />
            </Paper>
          )}
          <Paper name="evidence" title={t('merge-brief.evidence.title')}>
            <Evidence brief={brief} />
          </Paper>
          <Paper name="review" title={t('merge-brief.review', { count: brief.rounds })}>
            <Timeline entries={brief.timeline} />
            {brief.reviewGap === null ? null : <p lang="en">{brief.reviewGap}</p>}
          </Paper>
        </div>
        <div className="mb-side">
          <Paper
            name="risk"
            title={
              brief.risk === null ? t('merge-brief.riskTitle') : t('merge-brief.risk', { level: brief.risk.level })
            }
          >
            {brief.risk === null ? (
              <p className="mb-missing">
                <b>{t('merge-brief.notCollected')}</b> {t('merge-brief.noRisk')}
              </p>
            ) : (
              <p>{brief.risk.reason}</p>
            )}
          </Paper>
          <Paper name="before" title={t('merge-brief.before')}>
            {brief.beforeMerge.state === 'collected' ? null : <Missing reason={brief.beforeMerge.reason} />}
            <Checklist brief={brief} ticked={ticked} onTick={onTick} />
          </Paper>
          <Paper name="how" title={t('merge-brief.howToCheck')}>
            <Lines section={brief.howToCheck} />
          </Paper>
          <Paper name="rollback" title={t('merge-brief.rollBack')}>
            <p>{t('merge-brief.revert', { kind, sign, number: brief.number })}</p>
          </Paper>
          <Paper name="based" title={t('merge-brief.basedOn')}>
            <p>
              <code>{brief.task}</code>
              {brief.workOrderUrl === null ? null : (
                <>
                  {' '}
                  <a href={brief.workOrderUrl} target="_blank" rel="noreferrer">
                    {t('merge-brief.workOrder')}
                  </a>
                </>
              )}
            </p>
          </Paper>
        </div>
      </div>
      {brief.url === null ? null : (
        <p>
          <a className="btn gold mb-open" href={brief.url} target="_blank" rel="noreferrer" data-testid="mb-open">
            {label}
          </a>
        </p>
      )}
      <p className="mb-never">{t('merge-brief.never')}</p>
    </article>
  );
};

export const Board = ({ page, ticked, onTick, search }: { page: Page; search: string } & Ticks) => {
  const { t } = useTranslation();
  const prs = `${search}#/prs`;
  const none = page.phase === 'read' && page.answer.state === 'none' ? page.answer : null;
  return (
    <div className="mb" data-phase={page.phase === 'loading' ? 'loading' : 'done'}>
      <header className="panel mb-head">
        <a className="pixel mb-logo" href="#/">
          AGENT WORKS
        </a>
        <a href={prs}>{t('merge-brief.toPrs')}</a>
      </header>
      <main className="panel">
        <div className="mb-title">
          <h1 className="pixel">{t('merge-brief.title')}</h1>
          <span className="mb-mute">{t('merge-brief.intro')}</span>
        </div>
        {page.phase === 'loading' ? <p role="status">{t('merge-brief.loading')}</p> : null}
        {page.phase === 'no-task' ? <p role="status">{t('merge-brief.noTask')}</p> : null}
        {page.phase === 'none' ? <p role="status">{t('merge-brief.noFactory')}</p> : null}
        {page.phase === 'error' ? (
          <p role="alert">
            {t('merge-brief.failed')} <code>{page.message}</code>
          </p>
        ) : null}
        {none === null ? null : (
          <div role="status" className="mb-none" data-why={none.why}>
            <b className="pixel">{t('merge-brief.noBrief', { task: none.task })}</b>
            {/* i18n-keys: merge-brief.why.no-pr merge-brief.why.test merge-brief.why.review merge-brief.why.changes merge-brief.why.closed merge-brief.why.head-moved merge-brief.why.no-checks merge-brief.why.checks merge-brief.why.approvals merge-brief.why.unread */}
            <p>{t(`merge-brief.why.${none.why}`)}</p>
            {none.names.length === 0 ? null : (
              <p>
                <code>{none.names.join(', ')}</code>
              </p>
            )}
          </div>
        )}
        {page.phase === 'read' && page.answer.state === 'brief' ? (
          <Ready brief={page.answer.brief} ticked={ticked} onTick={onTick} />
        ) : null}
      </main>
    </div>
  );
};
