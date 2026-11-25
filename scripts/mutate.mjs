import { inShard } from './shard.mjs';

/** Apply one edit. The find text must occur exactly once, unless `all` is set, in which case every occurrence is replaced.
 * A missing or ambiguous match throws, so a mutant can never silently test the wrong code or nothing.
 * @param {string} file @param {string} current @param {string} find @param {string} replace @param {boolean} [all] */
export const applyEdit = (file, current, find, replace, all = false) => {
  const count = current.split(find).length - 1;
  if (count === 0) throw new Error(`pattern not found in ${file}: ${find}`);
  if (count > 1 && !all) throw new Error(`pattern matches ${count} times in ${file}, so it is ambiguous: ${find}`);
  return current.split(find).join(replace);
};

/** Filter by name and shard. Unknown names and an empty result are errors.
 * @template {{ name: string }} T @param {T[]} mutants @param {string[]} only @param {{ index: number, total: number } | null} shard */
export const selectMutants = (mutants, only, shard) => {
  for (const name of only)
    if (!mutants.some((mutant) => mutant.name === name)) throw new Error(`no mutant is named ${name}`);
  const selected = inShard(
    mutants.filter((mutant) => only.length === 0 || only.includes(mutant.name)),
    shard,
  );
  if (selected.length === 0) throw new Error('the selection is empty: no mutant matches the names and shard given');
  return selected;
};
