const CLAUDE_VERSION = '2.1.325';

/** @param {{ maskedCode: number, maskedOut: string, controlLeaks: number }} o */
export const maskRead = (o) => o.maskedCode === 0 && o.maskedOut === '' && o.controlLeaks === 1;

/** @param {{ maskedOut: string, controlHits: number }} o */
export const maskGrep = (o) => o.maskedOut.trim() === 'exit=1' && o.controlHits >= 5;

/** @param {{ leaks: number, controlOut: string, trackedProtected: number }} o */
export const gitReaders = (o) => o.leaks === 0 && o.controlOut.includes('hello') && o.trackedProtected === 0;

/** @param {{ started: boolean, controlCode: number, writeCode: number, writeErr: string }} o */
export const maskWrite = (o) =>
  o.started && o.controlCode === 0 && o.writeCode !== 0 && /Read-only file system/.test(o.writeErr);

/** @param {{ code: number, names: string, leaks: number }} o */
export const commitA = (o) => o.code === 0 && o.names === 'README.md' && o.leaks === 0;

/** @param {{ maskedCode: number, maskedOut: string, controlLeaks: number, hookBlocked: boolean }} o */
export const scriptBypass = (o) =>
  o.maskedCode === 0 && o.maskedOut.trim() === '' && o.controlLeaks === 1 && !o.hookBlocked;

/** @param {{ protectedHome: number, sweepHits: string }} o */
export const noHome = (o) => o.protectedHome === 0 && o.sweepHits.trim() === '0';

/** @param {{ wroteCode: number, onFailure: string | undefined, version: string, headerSet: boolean }} o */
export const settings = (o) =>
  o.wroteCode === 0 && o.onFailure === 'block' && o.version.startsWith(CLAUDE_VERSION) && o.headerSet;

/** @param {string} decision @param {string} expected */
export const hookDecision = (decision, expected) => decision === expected;

/** @param {{ anonymousStatus: string, wrongStatus: string }} o */
export const hookAuth = (o) => o.anonymousStatus.trim() === '401' && o.wrongStatus.trim() === '401';

/** @param {string[]} order */
export const eventsOrdered = (order) => order.join(',') === 'SessionStart,PreToolUse,PostToolUse,Stop';

/** @param {string[]} leaked */
export const noLeak = (leaked) => leaked.length === 0;

/** @param {{ error: string | undefined, status: number | undefined }} o */
export const hookDown = (o) => o.error !== undefined && o.status === undefined;

/**
 * @param {{ hardenedProof: boolean, controlProof: boolean, cleanScan: boolean, dirtyScan: boolean }} o
 */
export const preflightContained = (o) => !o.hardenedProof && o.controlProof && o.cleanScan && !o.dirtyScan;

/**
 * A tool probe counts only when the model called the tool and the tool printed something.
 * @param {{ attempted: boolean, output: string }[]} probes
 * @returns {'PASS' | 'FAIL' | 'NOT-RUN'}
 */
export const toolProbe = (probes) => {
  if (probes.every((probe) => !probe.attempted)) return 'NOT-RUN';
  return probes.every((probe) => probe.attempted && probe.output.trim() !== '') ? 'PASS' : 'FAIL';
};

/** @param {{ dirtyVariants: number, variants: number, missingClean: boolean, missingCreated: boolean, cloneClean: boolean }} o */
export const preflightComplete = (o) =>
  o.variants > 0 && o.dirtyVariants === o.variants && !o.missingClean && !o.missingCreated && o.cloneClean;
