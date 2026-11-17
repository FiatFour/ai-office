import { readFileSync, realpathSync } from 'node:fs';
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
  try {
    const relative = normalize(pathname === '/' ? '/index.html' : decodeURIComponent(pathname));
    const base = realpathSync(root);
    const wanted = join(base, relative);
    if (!wanted.startsWith(base + sep) || realpathSync(wanted) !== wanted) return null;
    return { body: readFileSync(wanted), type: TYPES[extname(relative)] ?? 'application/octet-stream' };
  } catch {
    return null;
  }
};
