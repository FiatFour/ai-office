import { PROTECTED_GLOBS } from './protected-paths.mjs';

/**
 * @typedef {'deny' | 'hook'} Layer
 * @typedef {{ type: 'http', url: string, timeout: number, onFailure?: 'block' }} HttpHook
 * @typedef {{ type: 'command', command: string }} CommandHook
 * @typedef {{ matcher?: string, hooks: (HttpHook | CommandHook)[] }} HookGroup
 * @typedef {{
 *   permissions?: { deny?: string[], disableBypassPermissionsMode: 'disable' },
 *   allowManagedHooksOnly?: boolean,
 *   hooks?: Record<string, HookGroup[]>,
 * }} ManagedSettings
 */

const ENV_NAMES = ['.env', '.env.local', '.env.development', '.env.production', '.env.test', '.env.staging'];
const EVENTS = ['PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop'];
const HOOK_TIMEOUT_SECONDS = 5;

export const FORWARDER_PATH = '/etc/claude-code/forward-event.mjs';

/** @param {string} text */
export const shellQuote = (text) => `'${text.replace(/'/g, "'\\''")}'`;

export const denyRules = () => {
  const names = [...ENV_NAMES, ...PROTECTED_GLOBS.names.filter((glob) => glob !== '.env' && glob !== '.env.*')];
  const specifiers = [
    ...names.map((name) => `**/${name}`),
    ...PROTECTED_GLOBS.homeDirs.map((dir) => `~/${dir}/**`),
    ...PROTECTED_GLOBS.homeFiles.map((file) => `~/${file}`),
  ];
  return ['Read', 'Edit'].flatMap((tool) => specifiers.map((specifier) => `${tool}(${specifier})`));
};

/**
 * @param {{ hookUrl: string, layers: Layer[], failClosed?: boolean }} options
 * @returns {ManagedSettings}
 */
export const managedSettings = ({ hookUrl, layers, failClosed = true }) => {
  /** @type {ManagedSettings} */
  const settings = {};
  if (layers.includes('deny')) {
    settings.permissions = { deny: denyRules(), disableBypassPermissionsMode: 'disable' };
  }
  if (layers.includes('hook')) {
    settings.allowManagedHooksOnly = true;
    settings.permissions ??= { disableBypassPermissionsMode: 'disable' };
    /** @type {HttpHook} */
    const guard = { type: 'http', url: hookUrl, timeout: HOOK_TIMEOUT_SECONDS };
    if (failClosed) guard.onFailure = 'block';
    settings.hooks = { PreToolUse: [{ matcher: '*', hooks: [guard] }] };
    settings.hooks.SessionStart = [
      { hooks: [{ type: 'command', command: `node ${FORWARDER_PATH} ${shellQuote(hookUrl)}` }] },
    ];
    for (const event of EVENTS) {
      settings.hooks[event] = [{ hooks: [{ type: 'http', url: hookUrl, timeout: HOOK_TIMEOUT_SECONDS }] }];
    }
  }
  return settings;
};
