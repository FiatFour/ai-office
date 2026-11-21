import { relative } from 'node:path';

/** @param {AsyncIterable<{ type: string, data: Record<string, any> }>} source */
export default async function* nodeJson(source) {
  const files = new Map();
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { file, name, nesting, details, skip, todo } = event.data;
    if (typeof file !== 'string' || details?.type === 'suite') continue;
    const count = files.get(file) ?? { file, passed: 0, failed: 0 };
    const standIn = nesting === 0 && name === relative(process.cwd(), file).replace(/\\/g, '/');
    if (event.type === 'test:fail' || standIn) count.failed += 1;
    else if (skip === undefined && todo === undefined) count.passed += 1;
    files.set(file, count);
  }
  yield JSON.stringify({ files: [...files.values()] });
}
