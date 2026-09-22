import { readState, isProcessAlive } from '../../../cli/commands/proxy/daemon-manager.js';
import { logger } from '../../../utils/logger.js';

/**
 * Fire-and-forget forward of a raw Claude Code hook event to the local proxy
 * daemon's analytics spool endpoint.
 *
 * - Calls readState() to get daemon URL and gateway key
 * - If no daemon or process is dead, logs at debug and returns (no error)
 * - POSTs { agentName, timestamp, raw: rawInput } to /v1/analytics/claude-code/hooks
 * - Uses 1500ms timeout and swallows all errors
 * - Never throws, never blocks Claude Code's exit, never affects hook's exit code
 */
export async function forwardHookEventToSpool(rawInput: string, agentName: string): Promise<void> {
  try {
    const state = await readState();
    if (!state) {
      logger.debug('forwardHookEventToSpool: no daemon state found');
      return;
    }

    if (!isProcessAlive(state.pid)) {
      logger.debug(`forwardHookEventToSpool: daemon pid ${state.pid} not alive`);
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1_500);

    try {
      await fetch(`${state.url}/v1/analytics/claude-code/hooks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${state.gatewayKey}`,
        },
        body: JSON.stringify({ agentName, timestamp: Date.now(), raw: rawInput }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    logger.debug(`forwardHookEventToSpool: ${err instanceof Error ? err.message : String(err)}`);
  }
}
