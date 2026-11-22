import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe } from 'vitest';
import { SandboxDriver } from '../../server/sandbox/container.ts';
import type { Denial } from '../../server/sandbox/firewall.ts';
import { tempDir } from '../../server/test/helpers.ts';
import { CONTEXT, IMAGE } from '../../server/test/sandbox/engines.ts';
import { find, kvmReason } from './engines.ts';
import { registerCases, registerNotRun } from './kit.ts';
import { type SandboxSubject, sandboxCases } from './sandbox.contract.ts';

for (const name of ['docker', 'podman'] as const) {
  const { engine, reason } = await find(name);
  if (engine === null) {
    registerNotRun(name, reason ?? 'unavailable');
    continue;
  }
  describe(`SandboxDriver contract on ${name}`, () => {
    const project = `agent-works-contract-${randomBytes(3).toString('hex')}`;
    const hq = randomBytes(3).toString('hex');
    const home = tempDir(`contract-${name}`);
    const denials: Denial[] = [];
    const make = (image: string) =>
      new SandboxDriver({ engine, home, hq, image, project, onDenial: (d) => denials.push(d) });
    const driver = make(IMAGE);
    const subject: SandboxSubject = {
      has: new Set(),
      driver,
      home,
      engine: name,
      settleMs: 15_000,
      missingImage: { image: 'aw-no-such-image:0', driver: make('aw-no-such-image:0') },
      denials: () => denials,
    };

    beforeAll(async () => {
      const have = await engine.run(['image', 'inspect', IMAGE]);
      if (have.code !== 0)
        await engine.ok(['build', '-t', IMAGE, '-f', join(CONTEXT, 'Containerfile.test'), CONTEXT], {
          timeoutMs: 600_000,
        });
    }, 700_000);

    afterAll(async () => {
      await driver.removeAll();
    }, 120_000);

    registerCases(name, sandboxCases, () => subject, 240_000);
  });
}

registerNotRun('krun', kvmReason());
