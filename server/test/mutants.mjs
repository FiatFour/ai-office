// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are source text being mutated
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DRIVER = 'server/test/sandbox/driver.test.ts';
const EXPORT = 'server/test/sandbox/export.test.ts';
const REGISTRY = 'server/test/registry.test.ts';
const ATOMIC = 'server/test/atomic.test.ts';
const STORE = 'server/test/store.test.ts';
const HQ = 'server/test/hq.test.ts';
const CLI = 'server/test/cli.test.ts';
const CONFIG = 'server/test/config.test.ts';
const LOCKRACE = 'server/test/lockrace.test.ts';

/** @type {Array<{ name: string, claim: string, edits: Array<[file: string, find: string, replace: string]>, tests: string[], survives?: boolean, env?: Record<string, string | undefined> }>} */
const MUTANTS = [
  {
    name: 'prune-live-head',
    claim: 'the head a change has now is never pruned',
    edits: [['server/store/prune.ts', 'return !superseded.has(sha) || live.has(sha);', 'return !superseded.has(sha);']],
    tests: ['server/test/store.test.ts'],
  },
  {
    name: 'prune-never',
    claim: 'facts of a replaced head are pruned',
    edits: [['server/store/prune.ts', 'if (superseded.size === 0) return state;', 'return state;']],
    tests: ['server/test/store.test.ts'],
  },
  {
    name: 'hq-any-host',
    claim: 'a foreign Host header is refused',
    edits: [['server/hq.ts', "if (!allowedHosts().has(req.headers.host ?? '')) return false;", '']],
    tests: ['server/test/hq.test.ts'],
  },
  {
    name: 'hq-any-origin',
    claim: 'a foreign Origin header is refused',
    edits: [
      ['server/hq.ts', 'return origin === undefined || origin === `http://${req.headers.host}`;', 'return true;'],
    ],
    tests: ['server/test/hq.test.ts'],
  },
  {
    name: 'event-no-host-time',
    claim: 'a change fact without host time is refused',
    edits: [
      [
        'server/events.ts',
        "headSha: str(o, 'headSha'),\n  at: num(o, 'at'),\n});",
        "headSha: str(o, 'headSha'),\n  at: 0,\n});",
      ],
    ],
    tests: ['server/test/hq.test.ts'],
  },
  {
    name: 'hq-no-rev-on-registry',
    claim: 'each registry change raises the pushed revision',
    edits: [['server/hq.ts', 'if (created) ledger.bump();', '']],
    tests: ['server/test/hq.test.ts'],
  },
  {
    name: 'registry-repo-per-factory',
    claim: 'one repo shared by two factories keeps one entry',
    edits: [['server/registry.ts', ': repoIdFrom(remote, real);', ': repoIdFrom(remote, real) + factory.id;']],
    tests: ['server/test/registry.test.ts'],
  },
  {
    name: 'doctor-exit-zero',
    claim: 'doctor exits 1 on a FAIL',
    edits: [['server/preflight/checks.ts', 'canStart(checks) ? 0 : 1', 'canStart(checks) ? 0 : 0']],
    tests: ['server/test/preflight.test.ts'],
  },
  {
    name: 'doctor-rootful-passes',
    claim: 'rootful podman fails the doctor',
    edits: [['server/preflight/checks.ts', "usable.name === 'podman' && usable.info?.rootless !== true", 'false']],
    tests: ['server/test/preflight.test.ts'],
  },
  {
    name: 'cage-not-hardened',
    claim: 'the cage runs with all caps dropped, no-new-privileges and a read-only root',
    edits: [['server/sandbox/container.ts', 'firewall.internal,\n        ...hardenedArgs(),', 'firewall.internal,']],
    tests: [DRIVER],
  },
  {
    name: 'cage-root-user',
    claim: 'the cage runs as the host user',
    edits: [['server/sandbox/container.ts', "'4g',\n        ...(await this.user()),", "'4g',"]],
    tests: [DRIVER],
  },
  {
    name: 'network-not-internal',
    claim: 'the cage network has no route out',
    edits: [['server/sandbox/firewall.ts', "'--internal', ...harden,", '...harden,']],
    tests: [DRIVER],
  },
  {
    name: 'network-keeps-host-gateway',
    claim: 'a cage cannot reach a host service through the bridge gateway',
    edits: [
      [
        'server/sandbox/firewall.ts',
        "const harden = engine.name === 'docker' ? ['-o', 'com.docker.network.bridge.inhibit_ipv4=true'] : [];",
        'const harden: string[] = [];',
      ],
    ],
    tests: [DRIVER],
  },
  {
    name: 'proxy-allows-all',
    claim: 'the proxy denies a host that is not on the allowlist',
    edits: [
      [
        'server/sandbox/proxy/node-proxy.mjs',
        'if (target === null || !isAllowed(rules, target.host, target.port)) {',
        'if (target === null) {',
      ],
    ],
    tests: [DRIVER],
  },
  {
    name: 'export-keeps-secrets',
    claim: 'a tracked .env never reaches the cage (the contained scan refuses it)',
    edits: [
      ['server/sandbox/export.ts', 'for (const path of removed) rmSync(path, { recursive: true, force: true });', ''],
    ],
    tests: [DRIVER],
  },
  {
    name: 'export-keeps-secrets-and-scan-off',
    claim: 'a tracked .env never reaches the cage (the canary grep sees it)',
    edits: [
      ['server/sandbox/export.ts', 'for (const path of removed) rmSync(path, { recursive: true, force: true });', ''],
      ['server/sandbox/container.ts', 'if (!scan.clean) throw new CageError', 'if (false) throw new CageError'],
    ],
    tests: [DRIVER],
  },
  {
    name: 'scan-off-alone',
    claim: 'the contained scan is a second layer, invisible while sanitising works',
    edits: [['server/sandbox/container.ts', 'if (!scan.clean) throw new CageError', 'if (false) throw new CageError']],
    tests: [DRIVER],
    survives: true,
  },
  {
    name: 'throwaway-has-network',
    claim: 'the throwaway container has no network',
    edits: [['server/sandbox/container.ts', "'--network',\n        'none',", "'--network',\n        'bridge',"]],
    tests: [DRIVER],
  },
  {
    name: 'mask-first-only',
    claim: 'every protected file is removed from the export, not the first one found',
    edits: [
      [
        'server/sandbox/export.ts',
        "findProtected(dest, { home: '/nonexistent', cwd: dest })",
        "findProtected(dest, { home: '/nonexistent', cwd: dest }, 1)",
      ],
    ],
    tests: [DRIVER],
  },
  {
    name: 'scan-unparseable-is-clean',
    claim: 'a scan that cannot be read fails closed',
    edits: [
      [
        'server/sandbox/export.ts',
        '      clean: false,\n      issues: [`the contained scan failed',
        '      clean: true,\n      issues: [`the contained scan failed',
      ],
    ],
    tests: [EXPORT],
  },
  {
    name: 'export-on-host',
    claim: 'the source is never read by host git, so a smudge filter in it cannot run on the host',
    edits: [
      [
        'server/sandbox/export.ts',
        '  const archived = await throwaway(',
        "  await new Promise<void>((done) => { execFile('git', ['-C', source, 'archive', '--format=tar', '-o', `${dest}.tar`, 'HEAD'], () => done()); });\n  const archived = await throwaway(",
      ],
      [
        'server/sandbox/export.ts',
        'import { mkdirSync,',
        "import { execFile } from 'node:child_process';\nimport { mkdirSync,",
      ],
    ],
    tests: [DRIVER],
  },
  {
    name: 'cage-source-not-refused',
    claim: 'a cage workdir is never an export source',
    edits: [['server/sandbox/container.ts', 'if (insideCage(this.home, spec.source))', 'if (false)']],
    tests: [DRIVER],
  },
  {
    name: 'cage-cwd-not-refused',
    claim: 'the CLI does not run from inside a cage',
    edits: [['server/cli.ts', 'if (insideCage(home, path))', 'if (false)']],
    tests: [CLI],
  },
  {
    name: 'home-slug-only',
    claim: 'two worker names that slug alike get different homes',
    edits: [
      [
        'server/sandbox/container.ts',
        "return `${slug(worker) || 'worker'}-${createHash('sha256').update(worker).digest('hex').slice(0, 24)}`;",
        'return slug(worker);',
      ],
    ],
    tests: [EXPORT],
  },
  {
    name: 'registry-no-realpath',
    claim: 'a symlinked path is the same factory and the same clone',
    edits: [['server/registry.ts', 'caseKey(realpathSync.native(resolve(path)))', 'caseKey(resolve(path))']],
    tests: [REGISTRY],
  },
  {
    name: 'registry-new-path-overwrites-shared',
    claim: 'a second clone of a shared repo does not replace the first clone path',
    edits: [['server/registry.ts', 'const repo = existing ?? {', 'const repo = {']],
    tests: [REGISTRY],
  },
  {
    name: 'registry-same-clone-two-ids',
    claim: 'one clone keeps one id with and without a remote',
    edits: [
      [
        'server/registry.ts',
        'const known = Object.values(this.repos).find(',
        'const known = undefined as RepoEntry | undefined; void Object.values(this.repos).find(',
      ],
    ],
    tests: [REGISTRY],
  },
  {
    name: 'atomic-no-rename',
    claim: 'a state file is replaced by rename, never rewritten in place',
    edits: [['server/store/atomic.ts', 'const temp = `${path}.${process.pid}.tmp`;', 'const temp = path;']],
    tests: [ATOMIC],
  },
  {
    name: 'atomic-no-fsync',
    claim: 'the new file is synced before the rename',
    edits: [['server/store/atomic.ts', '    writeSync(fd, data);\n    fsyncSync(fd);', '    writeSync(fd, data);']],
    tests: [ATOMIC],
  },
  {
    name: 'atomic-no-dirsync',
    claim: 'the directory is synced after the rename',
    edits: [['server/store/atomic.ts', '      syncDirectory(dirname(path));\n', '']],
    tests: [ATOMIC],
  },
  {
    name: 'store-sync-off',
    claim: 'every SQLite commit is synced to disk',
    edits: [['server/store/store.ts', "'PRAGMA synchronous = FULL'", "'PRAGMA synchronous = OFF'"]],
    tests: [STORE],
  },
  {
    name: 'store-journal-delete',
    claim: 'SQLite commits through the write-ahead log',
    edits: [['server/store/store.ts', "'PRAGMA journal_mode = WAL'", "'PRAGMA journal_mode = DELETE'"]],
    tests: [STORE],
  },
  {
    name: 'store-no-checksum',
    claim: 'a changed event body is detected',
    edits: [['server/store/store.ts', 'if (sumOf(seq, body) !== row.sum) throw', 'if (false) throw']],
    tests: [STORE],
  },
  {
    name: 'store-no-gap-check',
    claim: 'a missing event is detected',
    edits: [
      ['server/store/store.ts', 'if (n > 0 && (Number(span?.low) !== 1 || Number(span?.high) !== n))', 'if (false)'],
    ],
    tests: [STORE],
  },
  {
    name: 'store-no-transaction',
    claim: 'an event and the state it produced are written together or not at all',
    edits: [
      ['server/store/store.ts', "this.db.exec('BEGIN IMMEDIATE');", ''],
      ['server/store/store.ts', "this.db.exec('COMMIT');", ''],
      ['server/store/store.ts', "this.db.exec('ROLLBACK');", ''],
    ],
    tests: [STORE],
  },
  {
    name: 'prune-keeps-none-closed',
    claim: 'closed commands are trimmed to the newest 200',
    edits: [['server/ledger.ts', 'const DONE_KEPT = 200;', 'const DONE_KEPT = 0;']],
    tests: [STORE],
  },
  {
    name: 'ws-no-push-on-repo',
    claim: 'a registered repo is pushed to the dashboard',
    edits: [['server/hq.ts', 'if (changed) ledger.bump();\n      push();', 'if (changed) ledger.bump();']],
    tests: [HQ],
  },
  {
    name: 'hq-bind-all',
    claim: 'HQ listens on loopback only',
    edits: [['server/hq.ts', "options.host ?? '127.0.0.1'", "options.host ?? '0.0.0.0'"]],
    tests: [HQ],
  },
  {
    name: 'hq-host-any-port',
    claim: 'a Host header must name the port HQ is bound to',
    edits: [
      [
        'server/hq.ts',
        "if (!allowedHosts().has(req.headers.host ?? '')) return false;",
        "if (!/^(127\\.0\\.0\\.1|localhost|\\[::1\\])(:\\d+)?$/.test(req.headers.host ?? '')) return false;",
      ],
    ],
    tests: [HQ],
  },
  {
    name: 'cli-other-hq-unnamed',
    claim: 'a port held by another HQ is named as such',
    edits: [['server/cli.ts', "if (state.state === 'hq') {", 'if (false as boolean) {']],
    tests: [CLI],
  },

  {
    name: 'exp-src-mount-writable',
    claim: 'the source is mounted read-only in the export container',
    edits: [['server/sandbox/export.ts', "...mount(source, '/src', true)", "...mount(source, '/src')"]],
    tests: [EXPORT],
  },
  {
    name: 'exp-archive-failure-ignored',
    claim: 'a failed contained git archive fails the export',
    edits: [['server/sandbox/export.ts', '; test ! -e /tmp/archive-failed', '']],
    tests: [DRIVER],
  },
  {
    name: 'exp-throwaway-not-hardened',
    claim: 'the throwaway drops caps, is read-only and has no-new-privileges',
    edits: [['server/sandbox/container.ts', "'none',\n        ...hardenedArgs(),", "'none',"]],
    tests: [DRIVER],
  },
  {
    name: 'exp-throwaway-runs-as-root',
    claim: 'the throwaway runs as the host uid, not root',
    edits: [['server/sandbox/container.ts', "'2g',\n        ...(await this.user()),", "'2g',"]],
    tests: [DRIVER],
  },
  {
    name: 'refuse-no-homes',
    claim: 'a source under homes/ is refused',
    edits: [['server/config.ts', "['cages', 'homes'].map", "['cages'].map"]],
    tests: [CONFIG],
  },
  {
    name: 'refuse-root-itself-allowed',
    claim: 'the cages dir itself is refused (the identity check also refuses it, so the name check is a second layer)',
    edits: [
      [
        'server/config.ts',
        "return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));",
        "return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);",
      ],
    ],
    tests: [CONFIG],
    survives: true,
  },
  {
    name: 'refuse-no-realpath',
    claim: 'a link into a cage is refused',
    edits: [['server/config.ts', '    real = nativeReal(path);', '    real = path;']],
    tests: [CONFIG],
  },
  {
    name: 'refuse-case-sensitive',
    claim: 'another spelling of a cage path is refused on a case-insensitive disk',
    edits: [['server/config.ts', 'if (rootIds.size === 0) return false;', 'return false;']],
    tests: [CONFIG],
    env: { TMPDIR: process.env.AW_CASE_TMPDIR },
  },
  {
    name: 'cli-addrepo-path-unchecked',
    claim: 'add-repo refuses a path inside a cage',
    edits: [
      [
        'server/cli.ts',
        'const path = notCage(realpathSync(resolve(cwd, target)));',
        'const path = realpathSync(resolve(cwd, target));',
      ],
    ],
    tests: [CLI],
  },
  {
    name: 'reg-addrepo-no-realpath',
    claim: 'a repo added through a link is the same repo, named by its real path',
    edits: [
      ['server/registry.ts', 'const real = realpathSync(resolve(spec.path));', 'const real = resolve(spec.path);'],
    ],
    tests: [REGISTRY],
  },
  {
    name: 'reg-id-default-port-kept',
    claim: 'a default port does not change the repo id',
    edits: [['server/registry.ts', "'ssh:': '22',", "'ssh:': '0',"]],
    tests: [REGISTRY],
  },
  {
    name: 'reg-id-local-origin-fails',
    claim: 'a local-path origin does not make the add fail',
    edits: [
      [
        'server/registry.ts',
        'return localRemoteId(text, path);',
        'throw new RegistryError(`cannot read the remote ${remote}`);',
      ],
    ],
    tests: [REGISTRY],
  },
  {
    name: 'home-hash-1-hex',
    claim: 'home names are injective in practice (hash 24 hex)',
    edits: [['server/sandbox/container.ts', ".digest('hex').slice(0, 24)", ".digest('hex').slice(0, 1)"]],
    tests: [EXPORT],
  },
  {
    name: 'store-no-missing-state-check',
    claim: 'a log without a state row is refused, never reset',
    edits: [['server/store/store.ts', 'if (saved === null && n > 0) throw', 'if (false) throw']],
    tests: [STORE],
  },
  {
    name: 'store-begin-deferred',
    claim: 'writes take the write lock up front (BEGIN IMMEDIATE)',
    edits: [['server/store/store.ts', "this.db.exec('BEGIN IMMEDIATE');", "this.db.exec('BEGIN');"]],
    tests: [STORE],
  },
  {
    name: 'store-sum-ignores-seq',
    claim: 'the checksum covers the seq, so renumbering is caught',
    edits: [['server/store/store.ts', 'update(`${seq}\\n${body}`)', 'update(body)']],
    tests: [STORE],
  },
  {
    name: 'store-state-sum-unchecked',
    claim: 'an edited state row is refused',
    edits: [
      ['server/store/store.ts', 'if (saved !== null && saved.sum !==', 'if (false && saved !== null && saved.sum !=='],
    ],
    tests: [STORE],
  },
  {
    name: 'store-state-sum-ignores-log',
    claim: 'the state checksum is bound to the last event of the log',
    edits: [['server/store/store.ts', 'update(`${eventSeq}\\n${lastEventSum}\\n${body}`)', 'update(body)']],
    tests: [STORE],
  },
  {
    name: 'lock-no-exclusive',
    claim: 'the state directory is locked through SQLite, so two processes cannot both open it',
    edits: [['server/store/store.ts', "'PRAGMA locking_mode = EXCLUSIVE'", "'PRAGMA locking_mode = NORMAL'"]],
    tests: [LOCKRACE, STORE],
  },
  {
    name: 'lock-pidfile-sequence',
    claim: 'the old read-pid, unlink, create lock lets two processes open over one stale lock',
    edits: [
      [
        'server/store/store.ts',
        "db.exec('PRAGMA locking_mode = EXCLUSIVE');",
        `db.exec('PRAGMA locking_mode = NORMAL');
        for (;;) {
          try {
            writeFileSync(this.lockPath, String(process.pid), { flag: 'wx' });
            break;
          } catch {
            const owner = Number(readFileSync(this.lockPath, 'utf8'));
            let alive = false;
            try {
              process.kill(owner, 0);
              alive = owner !== process.pid;
            } catch {}
            if (alive) throw new StoreLockedError(owner);
            unlinkSync(this.lockPath);
          }
        }`,
      ],
    ],
    tests: [LOCKRACE],
  },
  {
    name: 'ledger-mark-not-durable',
    claim: 'an outbox ack is persisted',
    edits: [['server/ledger.ts', '    this.store.commit(next);\n', '']],
    tests: [STORE],
  },
  {
    name: 'outbox-failed-never-retried',
    claim: 'a failed command is offered again until it has used its attempts',
    edits: [
      [
        'server/ledger.ts',
        "(entry.status === 'pending' || entry.status === 'failed') && entry.attempts < MAX_ATTEMPTS;",
        "entry.status === 'pending' && entry.attempts < MAX_ATTEMPTS;",
      ],
    ],
    tests: [STORE, HQ],
  },
  {
    name: 'outbox-retry-unbounded',
    claim: 'a failed command stops being retried after its attempts and is then pruned',
    edits: [
      [
        'server/ledger.ts',
        "(entry.status === 'pending' || entry.status === 'failed') && entry.attempts < MAX_ATTEMPTS;",
        "entry.status === 'pending' || entry.status === 'failed';",
      ],
    ],
    tests: [STORE, HQ],
  },
  {
    name: 'store-no-state-seq-check',
    claim:
      'a state row behind or ahead of the log is refused (the state checksum also refuses it, this check gives the clearer message)',
    edits: [['server/store/store.ts', 'if (saved !== null && saved.persisted.eventSeq !== n)', 'if (false)']],
    tests: [STORE],
    survives: true,
  },
  {
    name: 'lock-stale-file-blocks',
    claim: 'a lock file left by a dead or reused pid blocks no one',
    edits: [
      [
        'server/store/store.ts',
        'this.held = true;\n        writeFileSync',
        'if (this.owner() !== null && this.owner() !== process.pid) throw new StoreLockedError(this.owner());\n        this.held = true;\n        writeFileSync',
      ],
    ],
    tests: [STORE],
  },
  {
    name: 'hq-no-drain-on-boot',
    claim: 'pending commands left by a crash run after restart',
    edits: [['server/hq.ts', '  void drain();\n  return { url', '  return { url']],
    tests: [HQ],
  },
  {
    name: 'ws-push-first-socket-only',
    claim: 'every open socket gets each push',
    edits: [
      [
        'server/hq.ts',
        'for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(message);',
        'for (const socket of sockets) { if (socket.readyState === WebSocket.OPEN) socket.send(message); break; }',
      ],
    ],
    tests: [HQ],
  },
  {
    name: 'ws-no-push-on-event',
    claim: 'an ingested event is pushed',
    edits: [
      [
        'server/hq.ts',
        'const { rev, commands } = ledger.ingest(parseEvent(await readBody(req)));\n      push();',
        'const { rev, commands } = ledger.ingest(parseEvent(await readBody(req)));',
      ],
    ],
    tests: [HQ],
  },
  {
    name: 'ws-upgrade-any-path',
    claim: 'only /api/ws upgrades',
    edits: [['server/hq.ts', "pathname !== '/api/ws'", "pathname === '/never'"]],
    tests: [HQ],
  },
  {
    name: 'cli-start-failure-shows-old-log',
    claim: 'a failed start shows this run, not the lines an earlier run left',
    edits: [['server/cli.ts', '.subarray(logStart)', '']],
    tests: [CLI],
  },
  {
    name: 'cli-lock-reason-hidden',
    claim: 'a start that finds another HQ prints the reason, not a stack trace',
    edits: [
      [
        'server/cli.ts',
        'if (error instanceof StoreLockedError || error instanceof StoreCorruptError)',
        'if (false as boolean)',
      ],
    ],
    tests: [CLI],
  },
  {
    name: 'preflight-fail-does-not-block',
    claim: 'a FAIL blocks start',
    edits: [['server/preflight/checks.ts', "!checks.some((c) => c.status === 'FAIL')", 'true']],
    tests: ['server/test/preflight.test.ts'],
  },
  {
    name: 'preflight-warn-blocks',
    claim: 'a WARN does not block start',
    edits: [
      [
        'server/preflight/checks.ts',
        "!checks.some((c) => c.status === 'FAIL')",
        "!checks.some((c) => c.status === 'FAIL' || c.status === 'WARN')",
      ],
    ],
    tests: ['server/test/preflight.test.ts'],
  },
  {
    name: 'preflight-report-always-startable',
    claim: 'the report the screen reads carries the rule',
    edits: [['server/preflight/report.ts', 'canStart: canStart(checks),', 'canStart: true,']],
    tests: ['server/test/preflight.test.ts'],
  },
  {
    name: 'preflight-engine-asked-twice',
    claim: 'one run asks each engine each question once',
    edits: [['server/preflight/report.ts', 'return () => (asked ??= ask());', 'return () => ask();']],
    tests: ['server/test/preflight.test.ts'],
  },
  {
    name: 'preflight-stopped-engine-running',
    claim: 'an engine that does not answer info is not running',
    edits: [['server/preflight/report.ts', 'info.ok\n', 'true\n']],
    tests: ['server/test/preflight.test.ts'],
  },
  {
    name: 'preflight-missing-engine-listed',
    claim: 'an engine that is not installed is not listed',
    edits: [['server/preflight/report.ts', 'if ((await engines[name].version()) === null) return [];', '']],
    tests: ['server/test/preflight.test.ts'],
  },
  {
    name: 'preflight-no-single-flight',
    claim: 'callers that arrive together share one run',
    edits: [['server/preflight/report.ts', 'running ??= inspect', 'running = inspect']],
    tests: ['server/test/preflight.test.ts'],
  },
  {
    name: 'preflight-run-never-again',
    claim: 'a later call runs the checks again',
    edits: [['server/preflight/report.ts', 'running = null;', '']],
    tests: ['server/test/preflight.test.ts'],
  },
  {
    name: 'preflight-host-not-kept',
    claim: 'the snapshot host is the one the last run saw',
    edits: [['server/preflight/report.ts', 'host = report.host;', '']],
    tests: ['server/test/preflight.test.ts'],
  },
  {
    name: 'preflight-no-image-fix',
    claim: 'a WARN row carries a fix',
    edits: [
      [
        'server/preflight/checks.ts',
        '`${usable.name} build -t ${ctx.image} -f server/sandbox/Containerfile server/sandbox`,',
        'null,',
      ],
    ],
    tests: ['server/test/preflight.test.ts'],
  },
  {
    name: 'preflight-group-wrong',
    claim: 'every row carries the group of its id',
    edits: [['server/preflight/checks.ts', 'group: GROUPS[id],', "group: 'computer',"]],
    tests: ['server/test/preflight.test.ts'],
  },
  {
    name: 'preflight-kvm-any-os',
    claim: 'only Linux and WSL2 can have kvm',
    edits: [['server/preflight/host.ts', "(kind === 'linux' || kind === 'wsl2') && exists", 'exists']],
    tests: ['server/test/preflight.test.ts'],
  },
  {
    name: 'preflight-shell-env-ignored',
    claim: 'SHELL names the shell',
    edits: [['server/preflight/host.ts', "if (named !== '') return named;", '']],
    tests: ['server/test/preflight.test.ts'],
  },
  {
    name: 'preflight-shell-no-pwsh',
    claim: 'PowerShell 7 is named pwsh',
    edits: [['server/preflight/host.ts', "? 'pwsh'", "? 'cmd'"]],
    tests: ['server/test/preflight.test.ts'],
  },
  {
    name: 'preflight-fake-host-ignored',
    claim: 'AGENT_WORKS_HOST names the reported computer',
    edits: [
      ['server/preflight/host.ts', "FAKE_HOSTS[env.AGENT_WORKS_HOST ?? ''] ?? realHostProbe()", 'realHostProbe()'],
    ],
    tests: ['server/test/preflight.test.ts'],
  },
  {
    name: 'hq-snapshot-no-host',
    claim: 'the snapshot carries the host',
    edits: [['server/hq.ts', 'host: options.preflight?.host() ?? null,', 'host: null,']],
    tests: ['server/test/hq.test.ts'],
  },
  {
    name: 'hq-preflight-no-push',
    claim: 'a preflight run pushes the host it saw',
    edits: [
      [
        'server/hq.ts',
        'const report = await options.preflight.run(boundPort);\n      push();',
        'const report = await options.preflight.run(boundPort);',
      ],
    ],
    tests: ['server/test/hq.test.ts'],
  },
  {
    name: 'cage-not-registered',
    claim: 'the proxy learns each cage by its address',
    edits: [
      [
        'server/sandbox/container.ts',
        '      writeCages(firewall.cagesPath, this.identities);\n      const view',
        '      const view',
      ],
    ],
    tests: [DRIVER],
  },
  {
    name: 'cage-stays-registered',
    claim: 'a released cage leaves the registry',
    edits: [['server/sandbox/container.ts', "    this.identities.delete(this.addresses.get(id) ?? '');\n", '']],
    tests: [DRIVER],
  },
  {
    name: 'worker-rules-not-registered',
    claim: "a worker's own rules reach the proxy",
    edits: [
      [
        'server/sandbox/container.ts',
        'allow: Object.hasOwn(this.workerAllow, spec.worker) ? (this.workerAllow[spec.worker] ?? []) : [],',
        'allow: [],',
      ],
    ],
    tests: [DRIVER],
  },
  {
    name: 'allow-not-in-rules',
    claim: 'an allowed site is counted as part of the allowlist',
    edits: [['server/sandbox/container.ts', '    this.allowlist = [...current, rule];\n', '']],
    tests: [DRIVER],
  },
  {
    name: 'cage-sends-telemetry',
    claim: 'a cage turns off nonessential traffic',
    edits: [
      ['server/sandbox/container.ts', "        '-e',\n        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',\n", ''],
    ],
    tests: [DRIVER],
  },
  {
    name: 'cli-ignores-firewall-policy',
    claim: 'serve gives HQ and the driver the configured policy',
    edits: [['server/cli.ts', '      firewall: firewallFromConfig(raw),\n', '      firewall: firewallPolicy(),\n']],
    tests: [CLI],
  },
];

const only = process.argv.slice(2);
/**
 * @param {string[]} tests
 * @param {Record<string, string | undefined>} [env]
 */
const vitest = (tests, env = {}) =>
  spawnSync('pnpm', ['vitest', 'run', ...tests], {
    cwd: ROOT,
    env: { ...process.env, ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) },
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 900_000,
  });

/** @type {string[]} */
const lines = [];
/** @param {string} line */
const log = (line) => {
  console.log(line);
  lines.push(line);
};

const baseline = vitest([...new Set(MUTANTS.flatMap((m) => m.tests))]);
log(`baseline ${baseline.status === 0 ? 'PASS' : 'FAIL'}`);
if (baseline.status !== 0) {
  console.error(baseline.stdout.slice(-2000));
  process.exit(1);
}

let bad = 0;
for (const mutant of MUTANTS) {
  if (only.length > 0 && !only.includes(mutant.name)) continue;
  const originals = new Map();
  try {
    for (const [file, find, replace] of mutant.edits) {
      const path = `${ROOT}/${file}`;
      const text = originals.get(path) ?? readFileSync(path, 'utf8');
      originals.set(path, text);
      const current = readFileSync(path, 'utf8');
      if (!current.includes(find)) throw new Error(`${mutant.name}: pattern not found in ${file}`);
      writeFileSync(path, current.replace(find, replace));
    }
    if (mutant.env !== undefined && Object.values(mutant.env).some((value) => value === undefined)) {
      log(`SKIP ${mutant.name}: needs AW_CASE_TMPDIR on a case-insensitive disk`);
      continue;
    }
    const result = vitest(mutant.tests, mutant.env);
    const caught = result.status !== 0;
    const expected = mutant.survives ? !caught : caught;
    if (!expected) bad += 1;
    log(
      `${expected ? 'OK  ' : 'BAD '} ${mutant.name}: ${caught ? 'caught' : 'survived'}${mutant.survives ? ' (expected to survive)' : ''}. Claim: ${mutant.claim}`,
    );
  } finally {
    for (const [path, text] of originals) writeFileSync(path, text);
  }
}
writeFileSync(process.env.MUTANT_OUT ?? '/tmp/mutants.txt', `${lines.join('\n')}\n`);
process.exit(bad === 0 ? 0 : 1);
