import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FEDORA = 'docker.io/library/fedora:45';
const NAME = 'aw-p0-2-fedora';
const PROJECT_LABEL = 'agent-works.project=p0-2-spike';
const SCOPE_LABEL = 'agent-works.scope=krun-nested';
const SETUP = [
  'dnf install -y -q podman crun-krun nodejs util-linux >/dev/null 2>&1',
  'mkdir -p /etc/containers/containers.conf.d /sys/fs/cgroup/init',
  `printf '[containers]\\nlog_driver = "k8s-file"\\n' > /etc/containers/containers.conf.d/50-agent-works.conf`,
  'for p in $(cat /sys/fs/cgroup/cgroup.procs); do echo $p > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true; done',
  'for c in $(cat /sys/fs/cgroup/cgroup.controllers); do echo +$c > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true; done',
  'useradd -m agent',
  'chmod u+s /usr/sbin/newuidmap /usr/sbin/newgidmap',
  'chmod 666 /dev/kvm',
  'chmod 777 /out',
].join(' && ');
/** @param {string} command @param {boolean} rootful */
const as = (command, rootful) =>
  rootful ? ['bash', '-c', command] : ['runuser', '-u', 'agent', '--', 'bash', '-c', `cd ~ && ${command}`];
const FACTS = [
  'echo "$(cat /etc/fedora-release), $(podman --version), rootless $(podman info --format {{.Host.Security.Rootless}})"',
  'echo "outer kernel $(uname -r), $(nproc) CPUs"',
  `podman --runtime=krun run --rm docker.io/library/alpine:latest sh -c 'echo "krun guest kernel $(uname -r), $(nproc) vCPUs"'`,
].join(' && ');

/** @param {string[]} args */
function docker(args) {
  const result = spawnSync('docker', args, { stdio: 'inherit' });
  return result.status ?? 1;
}

/** Removes this driver's own containers by label, never by name and never the lane's. */
function removeNested() {
  const ids = spawnSync(
    'docker',
    ['ps', '-aq', '--filter', `label=${PROJECT_LABEL}`, '--filter', `label=${SCOPE_LABEL}`],
    {
      encoding: 'utf8',
    },
  )
    .stdout.split('\n')
    .filter(Boolean);
  if (ids.length > 0) docker(['rm', '-f', '-v', ...ids]);
}

const { values, positionals } = parseArgs({
  options: {
    out: { type: 'string', default: '/tmp/swarm-p0-2/krun-nested' },
    rootful: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});
mkdirSync(values.out, { recursive: true });
removeNested();
const started = docker([
  'run',
  '-d',
  '--name',
  NAME,
  '--label',
  PROJECT_LABEL,
  '--label',
  SCOPE_LABEL,
  '--privileged',
  '--device',
  '/dev/kvm',
  '-v',
  '/var/lib/containers',
  '-v',
  `${REPO}:/work:ro`,
  '-v',
  `${values.out}:/out`,
  FEDORA,
  'sleep',
  'infinity',
]);
let code = started;
if (started === 0) {
  code = docker(['exec', NAME, 'bash', '-c', SETUP]);
  if (code === 0) code = docker(['exec', NAME, ...as(FACTS, values.rootful)]);
  if (code === 0) {
    const run = ['node', '/work/spikes/P0-2/firewall.mjs', '--engine', 'krun', '--out', '/out', ...positionals];
    code = docker(['exec', NAME, ...as(run.join(' '), values.rootful)]);
  }
}
if (started === 0) docker(['exec', NAME, 'chmod', '-R', 'a+rX', '/out']);
removeNested();
process.exitCode = code;
