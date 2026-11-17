import { readFileSync } from 'node:fs';
import { arch, release } from 'node:os';

export type OsKind = 'linux' | 'wsl2' | 'macos' | 'windows' | 'other';

export interface HostInfo {
  readonly kind: OsKind;
  readonly label: string;
}

export interface HostProbe {
  readonly platform: NodeJS.Platform;
  readonly release: string;
  readonly arch: string;
  readonly env: NodeJS.ProcessEnv;
  readonly procVersion: string;
}

export const realHostProbe = (): HostProbe => {
  let procVersion = '';
  if (process.platform === 'linux') {
    try {
      procVersion = readFileSync('/proc/version', 'utf8');
    } catch {}
  }
  return { platform: process.platform, release: release(), arch: arch(), env: process.env, procVersion };
};

export const describeHost = (probe: HostProbe): HostInfo => {
  if (probe.platform === 'win32') return { kind: 'windows', label: `Windows (${probe.release}, ${probe.arch})` };
  if (probe.platform === 'darwin') return { kind: 'macos', label: `macOS (darwin ${probe.release}, ${probe.arch})` };
  if (probe.platform === 'linux') {
    const wsl = probe.env.WSL_DISTRO_NAME !== undefined || /microsoft/i.test(probe.procVersion);
    return wsl
      ? { kind: 'wsl2', label: 'Linux (WSL2 on Windows)' }
      : { kind: 'linux', label: `Linux (kernel ${probe.release}, ${probe.arch})` };
  }
  return { kind: 'other', label: `${probe.platform} (${probe.release})` };
};

const PER_OS = <T>(table: Record<OsKind, T>, kind: OsKind): T => table[kind];

export const FIXES = {
  engineMissing: (kind: OsKind): string =>
    PER_OS(
      {
        linux:
          'Install Docker Engine (https://docs.docker.com/engine/install/) or rootless podman (sudo apt install podman).',
        wsl2: 'Install Docker Desktop for Windows and turn on WSL integration, or run sudo apt install docker.io inside this distro.',
        macos: 'Run brew install --cask docker, or brew install podman && podman machine init && podman machine start.',
        windows:
          'Run winget install Docker.DockerDesktop, then start Docker Desktop and switch it to Linux containers.',
        other: 'Install Docker or podman for this platform.',
      },
      kind,
    ),
  engineDown: (kind: OsKind): string =>
    PER_OS(
      {
        linux: 'Start it with sudo systemctl start docker (podman: systemctl --user start podman.socket).',
        wsl2: 'Start Docker Desktop on Windows, or run sudo service docker start in this distro.',
        macos: 'Run open -a Docker, or podman machine start.',
        windows:
          'Start Docker Desktop and wait until it reports the engine is running, then switch to Linux containers.',
        other: 'Start the container engine.',
      },
      kind,
    ),
  nodeOld: (kind: OsKind): string =>
    PER_OS(
      {
        linux: 'Install Node 22.18 or newer (nvm install 24, or your distro package).',
        wsl2: 'Install Node 22.18 or newer inside WSL2 (nvm install 24), not the Windows copy.',
        macos: 'Run brew install node, or nvm install 24.',
        windows: 'Run winget install OpenJS.NodeJS.LTS.',
        other: 'Install Node 22.18 or newer.',
      },
      kind,
    ),
  gitMissing: (kind: OsKind): string =>
    PER_OS(
      {
        linux: 'Run sudo apt install git (or your distro equivalent).',
        wsl2: 'Run sudo apt install git inside this distro.',
        macos: 'Run xcode-select --install, or brew install git.',
        windows: 'Run winget install Git.Git.',
        other: 'Install git.',
      },
      kind,
    ),
  kvm: (kind: OsKind): string =>
    PER_OS(
      {
        linux: 'krun needs /dev/kvm: sudo modprobe kvm_intel (or kvm_amd) and add your user to the kvm group.',
        wsl2: 'krun needs nested virtualisation: enable nestedVirtualization in .wslconfig and restart WSL.',
        macos: 'krun is not available on macOS hosts.',
        windows: 'krun is not available on Windows hosts, use it from WSL2.',
        other: 'krun is not available.',
      },
      kind,
    ),
};
