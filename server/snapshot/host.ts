import { describeHost, type HostProbe, hasKvm, type OsKind, shellOf } from '../preflight/host.ts';
import type { EngineName } from '../sandbox/engine.ts';

export type HostEngine =
  | { readonly name: EngineName; readonly running: false }
  | { readonly name: EngineName; readonly running: true; readonly version: string; readonly rootless: boolean };

export interface HostInfo {
  /** `wsl2` is its own kind, so no separate flag can disagree with it. */
  readonly os: OsKind;
  readonly label: string;
  readonly shell: string;
  readonly arch: string;
  readonly kvm: boolean;
  /** The installed engines. `null` until the first preflight run has asked them. */
  readonly engines: readonly HostEngine[] | null;
}

export const hostInfo = (probe: HostProbe, exists: (path: string) => boolean): HostInfo => {
  const { kind, label } = describeHost(probe);
  return {
    os: kind,
    label,
    shell: shellOf(probe),
    arch: probe.arch,
    kvm: hasKvm(kind, exists),
    engines: null,
  };
};
