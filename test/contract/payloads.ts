import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Payload } from './githost.contract.ts';

const ROOT = join(import.meta.dirname, '../../spikes/P0-4/fixtures');

export const recorded = (host: 'github' | 'gitlab'): Payload[] =>
  readdirSync(join(ROOT, host))
    .sort()
    .map((file) => {
      const fixture = JSON.parse(readFileSync(join(ROOT, host, file), 'utf8')) as Pick<Payload, 'event' | 'body'>;
      return { name: `${host}/${file}`, host, event: fixture.event, body: fixture.body };
    });
