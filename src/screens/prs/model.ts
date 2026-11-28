import type {
  Approval,
  ChangeDetail,
  ChangeRow,
  ChangeStamp,
  ChangesView,
  HostRead,
  ReviewRoundView,
} from '../../../server/snapshot/changes.ts';

export type { Approval, ChangeDetail, ChangeRow, ChangeStamp, HostRead, ReviewRoundView };

/** `none` is an HQ that runs no factory, so it has no PRs to show and no route for them. */
export type List =
  | { readonly phase: 'loading' }
  | { readonly phase: 'none' }
  | { readonly phase: 'error'; readonly message: string }
  | { readonly phase: 'rows'; readonly rows: readonly ChangeRow[] };

export type Detail =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error'; readonly message: string }
  | { readonly phase: 'read'; readonly detail: ChangeDetail };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const fetchList = async (ask: typeof fetch = fetch): Promise<List> => {
  try {
    const res = await ask('/api/changes', { cache: 'no-store' });
    if (res.status === 404) return { phase: 'none' };
    if (!res.ok) return { phase: 'error', message: `HTTP ${res.status}` };
    return { phase: 'rows', rows: ((await res.json()) as ChangesView).rows };
  } catch (error) {
    return { phase: 'error', message: messageOf(error) };
  }
};

export const fetchDetail = async (number: number, ask: typeof fetch = fetch): Promise<Detail> => {
  try {
    const res = await ask(`/api/changes/${number}`, { cache: 'no-store' });
    if (!res.ok) return { phase: 'error', message: `HTTP ${res.status}` };
    return { phase: 'read', detail: (await res.json()) as ChangeDetail };
  } catch (error) {
    return { phase: 'error', message: messageOf(error) };
  }
};

export const HOSTS = {
  github: { name: 'GitHub', kind: 'PR', sign: '#' },
  gitlab: { name: 'GitLab', kind: 'MR', sign: '!' },
} as const;

/** The merge brief page is another screen. This link is all this screen knows about it. */
export const briefHref = (search: string, task: string): string => {
  const query = new URLSearchParams(search);
  query.set('task', task);
  return `?${query}#/merge-brief`;
};
