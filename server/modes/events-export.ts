import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { LoggedEvent } from '../store/store.ts';

export const exportEvents = async (hqUrl: string, out: string, after = 0): Promise<number> => {
  const res = await fetch(`${hqUrl}/api/events?after=${after}`);
  if (!res.ok) throw new Error(`GET /api/events answered ${res.status}`);
  const { events } = (await res.json()) as { events: LoggedEvent[] };
  writeFileSync(out, events.map((logged) => `${JSON.stringify(logged)}\n`).join(''));
  return events.length;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [url = 'http://127.0.0.1:7420', out = 'events.jsonl'] = process.argv.slice(2);
  console.log(`${await exportEvents(url, out)} events written to ${out}`);
}
