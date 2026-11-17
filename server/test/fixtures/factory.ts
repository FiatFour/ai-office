import type { Ticket } from '../../agents/runtime.ts';
import type { Script } from '../../agents/scripted.ts';

const ticket = (id: string, title: string, body: string, risk: Ticket['risk'] = null): Ticket => ({
  id,
  kind: 'feature',
  title,
  body,
  url: `https://example.invalid/work-orders/${id.replace('/', '-')}`,
  risk,
});

const lines = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word} ${i + 1}`).join('\n');
const approve = { verdict: 'approve', body: 'Looks right.', comments: [] } as const;
const changes = (path: string, line: number, body: string) =>
  ({ verdict: 'changes', body: 'Please fix the comments.', comments: [{ path, line, body }] }) as const;

export const TICKETS: Record<string, Ticket> = {
  'alpha/t1': ticket('alpha/t1', 'Add a greeting file', 'Write src/greet.txt with three lines.', {
    level: 'LOW',
    reason: 'one new text file',
  }),
  'alpha/t2': ticket('alpha/t2', 'Add a two-file note', 'Write docs/note.md and src/note.txt.'),
  'alpha/t3': ticket('alpha/t3', 'Add a long list', 'Write src/list.txt with forty lines.'),
  'alpha/stubborn': ticket('alpha/stubborn', 'Rename a word everywhere', 'The reviewer never agrees.'),
  'alpha/web': ticket('alpha/web', 'Fetch a price list', 'Needs api.stripe.com to read a price list.'),
};

export const SCRIPTS: Record<string, Script> = {
  'alpha/t1': {
    author: [{ files: [{ path: 'src/greet.txt', content: `${lines(3, 'hello')}\n` }] }],
    reviews: [approve],
  },
  'alpha/t2': {
    author: [
      {
        files: [
          { path: 'docs/note.md', content: '# Note\n\nfirst draft\n' },
          { path: 'src/note.txt', content: `${lines(5, 'note')}\n` },
        ],
      },
      {
        files: [
          { path: 'docs/note.md', content: '# Note\n\nsecond draft\n' },
          { path: 'src/note.txt', content: `${lines(5, 'note')}\n` },
        ],
      },
    ],
    reviews: [changes('docs/note.md', 3, 'Say "second draft".'), approve],
  },
  'alpha/t3': {
    author: [{ files: [{ path: 'src/list.txt', content: `${lines(40, 'item')}\n` }] }],
    reviews: [approve],
  },
  'alpha/stubborn': {
    author: [0, 1, 2, 3, 4].map((round) => ({
      files: [{ path: 'src/word.txt', content: `word version ${round}\n` }],
    })),
    reviews: [changes('src/word.txt', 1, 'Still the wrong word.')],
  },
  'alpha/web': {
    author: [{ files: [{ path: 'src/prices.txt', content: 'basic 5\n' }], needs: 'api.stripe.com' }],
    reviews: [approve],
  },
};
