import type { FileEdit } from '../githost/host.ts';
import type { RunResult } from '../sandbox/engine.ts';
import { AgentFailed, type AgentJob, type AgentResult, type AgentRuntime, parseReview, type Usage } from './runtime.ts';

export interface CageShell {
  exec(
    argv: readonly string[],
    options?: { input?: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<RunResult>;
}

export interface ClaudeOptions {
  readonly shell: (worker: string, task: string) => CageShell;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  readonly bin?: string;
}

interface StreamLine {
  readonly type?: string;
  readonly subtype?: string;
  readonly is_error?: boolean;
  readonly result?: string;
  readonly usage?: Record<string, unknown> & { readonly server_tool_use?: Record<string, unknown> };
  readonly message?: { readonly content?: unknown };
}

const TOOLS = 'Bash,Read,Edit,Write,Grep,Glob';
const WITHOUT_WEB = 'WebSearch,WebFetch';
const GIT = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external='];

const tokens = (usage: Record<string, unknown>, key: string): number => {
  const value = usage[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

export const parseStream = (raw: string): { text: string; usage: Usage } => {
  const lines: StreamLine[] = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      lines.push(JSON.parse(line) as StreamLine);
    } catch {}
  }
  const result = lines.findLast((line) => line.type === 'result');
  if (result === undefined) throw new AgentFailed('claude printed no result line');
  if (result.is_error === true || result.subtype !== 'success')
    throw new AgentFailed(`claude ended with ${result.subtype ?? 'an error'}`);
  const usage = result.usage ?? {};
  const served = lines
    .flatMap((line) => (Array.isArray(line.message?.content) ? (line.message.content as { type?: unknown }[]) : []))
    .filter((block) => block?.type === 'server_tool_use').length;
  const reported =
    tokens(usage.server_tool_use ?? {}, 'web_search_requests') +
    tokens(usage.server_tool_use ?? {}, 'web_fetch_requests');
  return {
    text: result.result ?? '',
    usage: {
      inputTokens: tokens(usage, 'input_tokens'),
      outputTokens: tokens(usage, 'output_tokens'),
      cacheReadTokens: tokens(usage, 'cache_read_input_tokens'),
      cacheCreationTokens: tokens(usage, 'cache_creation_input_tokens'),
      webRequests: Math.max(reported, served),
    },
  };
};

const promptFor = (job: AgentJob): string => {
  const order = `Work order ${job.ticket.id}: ${job.ticket.title}\n\n${job.ticket.body}`;
  if (job.role === 'author') {
    if (job.comments.length === 0)
      return `${order}\n\nMake the change in this repository and commit it. Do not push and do not open a PR; HQ does both.`;
    const asked = job.comments.map((c) => `- ${c.path ?? '(general)'}:${c.line ?? '-'} ${c.body}`).join('\n');
    return `${order}\n\nA peer reviewer asked for these changes (round ${job.round}):\n${asked}\n\nFix them and commit.`;
  }
  const files = job.files
    .map((f) => (f.content === null ? `--- ${f.path} (binary file, content not shown)` : `--- ${f.path}\n${f.content}`))
    .join('\n');
  return `${order}\n\nReview change #${job.change.number} at ${job.change.headSha}. Files at the head:\n${files}\n\nEnd your answer with a \`\`\`json block: {"verdict": "approve" | "changes", "body": "...", "comments": [{"path": "...", "line": 1, "body": "..."}]}.`;
};

const claudeArgv = (bin: string, model: string, maxTurns: number): string[] => [
  bin,
  '-p',
  '--model',
  model,
  '--output-format',
  'stream-json',
  '--verbose',
  '--allowedTools',
  TOOLS,
  '--disallowedTools',
  WITHOUT_WEB,
  '--no-session-persistence',
  '--max-turns',
  String(maxTurns),
];

const head = async (shell: CageShell): Promise<string> => {
  const ran = await shell.exec([...GIT, 'rev-parse', 'HEAD']);
  if (ran.code !== 0) throw new AgentFailed(`the cage repo has no HEAD: ${ran.err.trim()}`);
  return ran.out.trim();
};

const changedFiles = async (shell: CageShell, since: string): Promise<FileEdit[]> => {
  const listed = await shell.exec([
    ...GIT,
    'diff',
    '--numstat',
    '--no-renames',
    '--diff-filter=AM',
    '-z',
    since,
    'HEAD',
  ]);
  const entries = listed.out
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.split('\t'));
  const binary = entries.find(([added]) => added === '-');
  if (binary !== undefined)
    throw new AgentFailed(`claude committed the binary file ${binary[2]}; HQ pushes text files only`);
  const files: FileEdit[] = [];
  for (const [, , path = ''] of entries) {
    const shown = await shell.exec([...GIT, 'show', `HEAD:${path}`]);
    if (shown.code === 0) files.push({ path, content: shown.out });
  }
  return files;
};

export const claudeCode = (options: ClaudeOptions): AgentRuntime => ({
  id: 'claude-code',
  async run(job): Promise<AgentResult> {
    job.signal.throwIfAborted();
    const shell = options.shell(job.worker, job.task);
    const before = job.role === 'author' ? await head(shell) : '';
    const argv = claudeArgv(options.bin ?? 'claude', options.model ?? 'sonnet', options.maxTurns ?? 40);
    const ran = await shell.exec(argv, {
      input: promptFor(job),
      timeoutMs: options.timeoutMs ?? 30 * 60_000,
      signal: job.signal,
    });
    if (job.signal.aborted) throw new AgentFailed('the run was aborted');
    if (ran.timedOut) throw new AgentFailed('claude ran past its time limit');
    const { text, usage } = parseStream(ran.out);
    if (job.role === 'reviewer') return { role: 'reviewer', ...parseReview(text), usage };
    const files = await changedFiles(shell, before);
    if (files.length === 0) throw new AgentFailed('claude finished without committing a change');
    return { role: 'author', files, message: `${job.ticket.id}: ${job.ticket.title}`, usage };
  },
});
