import { useTranslation } from 'react-i18next';
import {
  type Approval,
  briefHref,
  type ChangeDetail,
  type ChangeRow,
  type ChangeStamp,
  type Detail,
  HOSTS,
  type HostRead,
  type List,
  type ReviewRoundView,
} from './model.ts';

/** HQ never merges, so nothing here merges: the buttons only pick a PR, and every action is a link to another page. */

const Stamp = ({ stamp, big }: { stamp: ChangeStamp; big?: boolean }) => (
  <span className={`pixel prs-stamp${big ? ' prs-big' : ''}`} data-stamp={stamp}>
    {stamp}
  </span>
);

const Rows = ({
  rows,
  selected,
  onSelect,
}: {
  rows: readonly ChangeRow[];
  selected: number | null;
  onSelect: (number: number) => void;
}) => (
  <ul className="prs-list">
    {rows.map((row) => (
      <li key={row.number}>
        <button
          type="button"
          className="prs-row"
          data-pr={row.number}
          aria-pressed={row.number === selected}
          onClick={() => onSelect(row.number)}
        >
          <span className="prs-row-text">
            <span className="prs-ref">
              {HOSTS[row.host].sign}
              {row.number}
              {row.worker === null ? '' : ` · ${row.worker}`} · {HOSTS[row.host].name}
            </span>
            <b>{row.title}</b>
          </span>
          <Stamp stamp={row.stamp} />
        </button>
      </li>
    ))}
  </ul>
);

const MARK = { success: '✓', failure: '✗', pending: '…', skipped: '–' } as const;

const Checks = ({ read }: { read: Extract<HostRead, { state: 'read' }> }) => {
  const { t } = useTranslation();
  return (
    <section className="prs-block" aria-label={t('prs.checks.title')}>
      <h3 className="pixel prs-test">{t('prs.checks.station')}</h3>
      {read.checks.length === 0 ? (
        <p>{t('prs.checks.none')}</p>
      ) : (
        <ul>
          {read.checks.map((check) => (
            <li key={check.name} data-check={check.name} data-state={check.state}>
              <span className="prs-mark" aria-hidden="true">
                {MARK[check.state]}
              </span>
              <span className="prs-grow">{check.name}</span>
              {/* i18n-keys: prs.checks.state.success prs.checks.state.failure prs.checks.state.pending prs.checks.state.skipped */}
              <span className="prs-mute">{t(`prs.checks.state.${check.state}`)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

const APPROVAL_MARK = { approve: '✓', changes: '✗', wait: '…' } as const;

const Approvals = ({ approvals }: { approvals: readonly Approval[] }) => {
  const { t } = useTranslation();
  const label = (one: Approval): string => {
    if (one.by === 'you') return t('prs.approval.you');
    return one.who === null ? t('prs.approval.peerPending') : t('prs.approval.peer', { who: one.who });
  };
  return (
    <ul className="prs-approvals" aria-label={t('prs.approval.title')}>
      {approvals.map((one) => (
        <li key={`${one.by}:${one.by === 'peer' ? one.who : ''}`} data-by={one.by} data-approval={one.state}>
          <span aria-hidden="true">{APPROVAL_MARK[one.state]}</span> {label(one)}
          {/* i18n-keys: prs.approval.state.approve prs.approval.state.changes prs.approval.state.wait */}
          <span className="sr-only">: {t(`prs.approval.state.${one.state}`)}</span>
        </li>
      ))}
    </ul>
  );
};

const Rounds = ({ rounds, head }: { rounds: readonly ReviewRoundView[]; head: string }) => {
  const { t } = useTranslation();
  if (rounds.length === 0) return <p className="prs-mute">{t('prs.review.none')}</p>;
  return (
    <>
      {rounds.map((round) => (
        <div key={round.head} className="prs-round" data-round={round.round}>
          <h4>
            {t('prs.review.round', { round: round.round })} <code>{round.head.slice(0, 7)}</code>
            {round.head === head ? <span className="prs-mute"> {t('prs.review.current')}</span> : null}
          </h4>
          {round.reviews.map((review, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: reviews of a finished round never move
            <div key={i} className="prs-review" data-verdict={review.verdict}>
              <p className="prs-line">
                <b>{review.reviewer}</b>
                <span className="prs-grow" />
                {/* i18n-keys: prs.review.verdict.approve prs.review.verdict.changes prs.review.verdict.comment */}
                <span className="prs-tag">{t(`prs.review.verdict.${review.verdict}`)}</span>
              </p>
              {review.body === '' ? null : <p className="prs-text">{review.body}</p>}
              {review.comments.map((comment, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: comments of a posted review never move
                <div key={j} className="prs-comment">
                  <code>{[comment.path, comment.line].filter((part) => part !== null).join(':')}</code>
                  <p className="prs-text">{comment.body}</p>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </>
  );
};

/** Why there is no brief yet. `null` where one exists. */
const NO_BRIEF: Readonly<Record<ChangeStamp, string | null>> = {
  READY: null,
  SHIPPED: null,
  DRAFT: 'prs.brief.draft',
  CHANGES: 'prs.brief.changes',
  'AT QC': 'prs.brief.review',
  SCRAPPED: 'prs.brief.scrapped',
};

const Brief = ({ detail, search }: { detail: ChangeDetail; search: string }) => {
  const { t } = useTranslation();
  const { row, briefUrl } = detail;
  const why = NO_BRIEF[row.stamp];
  return (
    <section className="prs-paper prs-brief" aria-label={t('prs.brief.title')}>
      <h3 className="pixel">{t('prs.brief.title')}</h3>
      {why === null ? (
        <p className="prs-line">
          {briefUrl === null ? null : (
            <a href={briefUrl} target="_blank" rel="noreferrer">
              {t('prs.brief.posted', { kind: HOSTS[row.host].kind })}
            </a>
          )}
          <a href={briefHref(search, row.task)} data-testid="prs-brief-link">
            {t('prs.brief.open')}
          </a>
        </p>
      ) : (
        // i18n-keys: prs.brief.draft prs.brief.changes prs.brief.review prs.brief.scrapped
        <p>{t(why)}</p>
      )}
    </section>
  );
};

const Card = ({ detail, search }: { detail: ChangeDetail; search: string }) => {
  const { t } = useTranslation();
  const { row, fromHost } = detail;
  const { name, kind, sign } = HOSTS[row.host];
  return (
    <article className="prs-detail" data-pr={row.number}>
      <div className="prs-paper">
        <span className="prs-ref">
          {kind} {sign}
          {row.number} · {row.repo} · {name} · {row.branch} → {row.base}
        </span>
        <h2>{row.title}</h2>
        <span>{row.worker === null ? row.task : t('prs.by', { worker: row.worker, task: row.task })}</span>
        <Stamp stamp={row.stamp} big />
      </div>
      {fromHost.state === 'read' ? (
        <Checks read={fromHost} />
      ) : (
        <p className="prs-block" role="alert">
          {t('prs.unread', { host: name })} <code>{fromHost.reason}</code>
        </p>
      )}
      <section className="prs-block" aria-label={t('prs.review.title')}>
        <h3 className="pixel prs-qc">{t('prs.review.station')}</h3>
        <Approvals approvals={detail.approvals} />
        {fromHost.state === 'read' ? <Rounds rounds={fromHost.rounds} head={row.head} /> : null}
      </section>
      <Brief detail={detail} search={search} />
      {fromHost.state === 'read' && fromHost.url !== null ? (
        <p>
          <a className="btn gold prs-open" href={fromHost.url} target="_blank" rel="noreferrer" data-testid="prs-open">
            {row.stamp === 'READY' ? t('prs.openToMerge', { host: name }) : t('prs.open', { host: name })}
          </a>
        </p>
      ) : null}
      <p className="prs-never">{t('prs.never')}</p>
    </article>
  );
};

export const Board = ({
  list,
  detail,
  selected,
  onSelect,
  search,
}: {
  list: List;
  detail: Detail;
  selected: number | null;
  onSelect: (number: number) => void;
  search: string;
}) => {
  const { t } = useTranslation();
  const done =
    list.phase !== 'loading' && (list.phase !== 'rows' || list.rows.length === 0 || detail.phase !== 'loading');
  return (
    <div className="prs" data-phase={done ? 'done' : 'loading'}>
      <header className="panel prs-head">
        <a className="pixel prs-logo" href="#/">
          AGENT WORKS
        </a>
        <span className="prs-mute">{t('prs.back')}</span>
      </header>
      <main className="panel">
        <div className="prs-title">
          <h1 className="pixel">{t('prs.title')}</h1>
          <span className="prs-mute">{t('prs.intro')}</span>
        </div>
        {list.phase === 'loading' ? <p role="status">{t('prs.loading')}</p> : null}
        {list.phase === 'none' ? <p role="status">{t('prs.noFactory')}</p> : null}
        {list.phase === 'error' ? (
          <p role="alert">
            {t('prs.listFailed')} <code>{list.message}</code>
          </p>
        ) : null}
        {list.phase === 'rows' && list.rows.length === 0 ? <p role="status">{t('prs.empty')}</p> : null}
        {list.phase === 'rows' && list.rows.length > 0 ? (
          <div className="prs-columns">
            <Rows rows={list.rows} selected={selected} onSelect={onSelect} />
            {detail.phase === 'read' ? <Card detail={detail.detail} search={search} /> : null}
            {detail.phase === 'loading' ? <p role="status">{t('prs.loading')}</p> : null}
            {detail.phase === 'error' ? (
              <p role="alert">
                {t('prs.detailFailed')} <code>{detail.message}</code>
              </p>
            ) : null}
          </div>
        ) : null}
      </main>
    </div>
  );
};
