import { type AgentRuntime, RuntimeUnavailable } from './runtime.ts';

export const codex = (): AgentRuntime => ({
  id: 'codex',
  async run() {
    throw new RuntimeUnavailable('the Codex runtime is deferred at gate G0, so no Codex worker can run yet');
  },
});
