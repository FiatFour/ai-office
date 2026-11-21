import { checkToolCall } from './protected-paths.mjs';

const COMMANDS = [
  'git log -p',
  'A=1 git log -p',
  'git -C /workspace status',
  'GIT_DIR=/x git log',
  'cat .env',
  'cat README.md',
  'grep -r K .',
  'sh -c "git log -p"',
  'find . -name x',
  'tar cf - .',
];
for (const gitClean of [true, false]) {
  for (const command of COMMANDS) {
    for (const [tool_name, tool_input] of /** @type {[string, Record<string, unknown>][]} */ ([
      ['Bash', { command }],
      ['Read', { file_path: '/workspace/.env' }],
      ['Grep', { pattern: 'x', path: '/workspace' }],
    ])) {
      checkToolCall({ tool_name, tool_input }, { home: '/h', cwd: '/workspace', workspace: '/workspace', gitClean });
    }
  }
}
await new Promise((resolve) => setTimeout(resolve, 200));
console.log('ok');
