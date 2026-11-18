/** @param {AsyncIterable<{ type: string, data: Record<string, any> }>} source */
export default async function* nodeJson(source) {
  const files = new Map();
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { file, details, skip, todo } = event.data;
    if (typeof file !== 'string' || details?.type === 'suite') continue;
    const count = files.get(file) ?? { file, passed: 0, failed: 0 };
    if (event.type === 'test:fail') count.failed += 1;
    else if (skip === undefined && todo === undefined) count.passed += 1;
    files.set(file, count);
  }
  yield JSON.stringify({ files: [...files.values()] });
}
