import { text } from 'node:stream/consumers';

const [url] = process.argv.slice(2);
try {
  await fetch(String(url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: await text(process.stdin),
    signal: AbortSignal.timeout(4000),
  });
} catch {}
