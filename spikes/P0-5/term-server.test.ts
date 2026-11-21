import { get } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { serveTerminal } from './term-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const printSize =
  "process.stdout.write('size=' + process.stdout.columns + 'x' + process.stdout.rows + '\\n'); setTimeout(() => {}, 10000)";

let url: URL;
let close: () => void;

beforeAll(async () => {
  const served = await serveTerminal({
    port: 0,
    attach: { file: process.execPath, args: ['-e', printSize] },
    assets: { '/': [path.join(here, 'index.html'), 'text/html; charset=utf-8'] },
  });
  url = new URL(served.url);
  close = served.close;
});

afterAll(() => close());

type Outcome = { opened: true; output: string } | { opened: false; status: number | undefined };

function connect(query: string, options: WebSocket.ClientOptions): Promise<Outcome> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${url.host}/term${query}`, options);
    let output = '';
    ws.on('unexpected-response', (_req, res) => resolve({ opened: false, status: res.statusCode }));
    ws.on('error', () => resolve({ opened: false, status: undefined }));
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'output') output += stripVTControlCharacters(message.data).replace(/\s/g, '');
      if (/size=\d+x\d+/.test(output)) {
        ws.close();
        resolve({ opened: true, output });
      }
    });
  });
}

const sizeOf = (outcome: Outcome) => (outcome.opened ? /size=(\d+x\d+)/.exec(outcome.output)?.[1] : undefined);

function status(host: string) {
  return new Promise<number | undefined>((resolve) => {
    get({ host: url.hostname, port: url.port, path: '/', headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
  });
}

describe('serveTerminal', () => {
  it('opens a terminal for its own page', async () => {
    const outcome = await connect('?cols=90&rows=30', { origin: `http://${url.host}` });
    expect(sizeOf(outcome)).toBe('90x30');
  });

  it('accepts its own page served as localhost', async () => {
    const outcome = await connect('', {
      origin: `http://localhost:${url.port}`,
      headers: { host: `localhost:${url.port}` },
    });
    expect(outcome.opened).toBe(true);
  });

  it.each([
    ['a foreign origin', () => ({ origin: 'https://evil.example' })],
    ['its own host on another scheme', () => ({ origin: `https://${url.host}` })],
    ['its own hostname on another port', () => ({ origin: `http://${url.hostname}:1` })],
    ['no origin', () => ({})],
  ])('refuses a socket from %s', async (_name, options) => {
    expect((await connect('', options())).opened).toBe(false);
  });

  it('refuses a socket whose Host is not its own, as after DNS rebinding', async () => {
    const outcome = await connect('', {
      origin: `http://rebind.example:${url.port}`,
      headers: { host: `rebind.example:${url.port}` },
    });
    expect(outcome.opened).toBe(false);
  });

  it('serves the page to its own Host and refuses any other Host', async () => {
    expect(await status(url.host)).toBe(200);
    expect(await status(`localhost:${url.port}`)).toBe(200);
    expect(await status(`rebind.example:${url.port}`)).toBe(403);
  });

  it('clamps an oversized initial terminal size to 1000', async () => {
    expect(sizeOf(await connect('?cols=99999&rows=99999', { origin: `http://${url.host}` }))).toBe('1000x1000');
  });

  it('clamps a negative initial size to 1 and ignores a non-number', async () => {
    expect(sizeOf(await connect('?cols=-5&rows=abc', { origin: `http://${url.host}` }))).toBe('1x24');
  });
});
