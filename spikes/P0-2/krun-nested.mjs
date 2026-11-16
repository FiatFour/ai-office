import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FEDORA = 'docker.io/library/fedora:45';
const NAME = 'aw-p0-2-fedora';
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

const { values, positionals } = parseArgs({
  options: {
    out: { type: 'string', default: '/tmp/swarm-p0-2/krun-nested' },
    rootful: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});
mkdirSync(values.out, { recursive: true });
docker(['rm', '-f', '-v', NAME]);
const started = docker([
  'run',
  '-d',
  '--name',
  NAME,
  '--label',
  'agent-works.project=p0-2-spike',
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
docker(['rm', '-f', '-v', NAME]);
process.exitCode = code;
