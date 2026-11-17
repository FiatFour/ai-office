import { readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

export interface Asset {
  readonly body: Buffer;
  readonly type: string;
}

export const readAsset = (root: string, pathname: string): Asset | null => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = normalize(decoded === '/' ? '/index.html' : decoded);
  if (relative.split(sep).includes('..') || relative.includes('\0')) return null;
  try {
    return { body: readFileSync(join(root, relative)), type: TYPES[extname(relative)] ?? 'application/octet-stream' };
  } catch {
    return null;
  }
};
