import { text } from 'node:stream/consumers';

const [url, token] = process.argv.slice(2);
try {
  await fetch(String(url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-guard-token': token } : {}) },
    body: await text(process.stdin),
    signal: AbortSignal.timeout(4000),
  });
} catch {}
