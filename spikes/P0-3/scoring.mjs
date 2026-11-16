/** @typedef {'blocked-by-hook' | 'blocked-by-deny-rule' | 'errored' | 'executed'} State */

const HOOK_BLOCK = /PreToolUse:\w+ hook error: .*Blocked by layer 4/;
const DENY_RULE = /denied by your permission settings|^Permission to use .+ has been denied\.?$/m;

/**
 * Names the cause of a tool result. An OS "Permission denied" or a read-only error is `errored`, never a block.
 * @param {string} text
 * @param {boolean} isError
 * @returns {State}
 */
export const classifyResult = (text, isError) => {
  if (isError && HOOK_BLOCK.test(text)) return 'blocked-by-hook';
  if (isError && DENY_RULE.test(text)) return 'blocked-by-deny-rule';
  return isError ? 'errored' : 'executed';
};

const HOOK_DOWN = /PreToolUse:Bash hook error: .*blocking because onFailure is "block"/;

/**
 * @param {string} resultText the Bash tool result when the hook URL is dead and onFailure is block
 * @param {string} marker the string the command would print if it ran
 */
export const hookDownBlocked = (resultText, marker) =>
  HOOK_DOWN.test(resultText) && !resultText.replace(HOOK_DOWN, '').includes(marker);
