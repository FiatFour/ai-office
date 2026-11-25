/** @param {string[]} args @returns {{ names: string[], shard: { index: number, total: number } | null }} */
export const parseArgs = (args) => {
  const names = [];
  let shard = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg !== '--shard') {
      names.push(arg);
      continue;
    }
    const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(args[i + 1] ?? '');
    if (match === null) throw new Error('--shard wants i/n with 1 <= i <= n, for example --shard 2/3');
    const index = Number(match[1]);
    const total = Number(match[2]);
    if (index > total) throw new Error(`--shard ${index}/${total}: i is above n`);
    shard = { index, total };
    i += 1;
  }
  return { names, shard };
};

/** Round robin, so neighbouring mutants on the same slow test file land in different shards.
 * @template T @param {T[]} items @param {{ index: number, total: number } | null} shard */
export const inShard = (items, shard) =>
  shard === null ? items : items.filter((_, position) => position % shard.total === shard.index - 1);
