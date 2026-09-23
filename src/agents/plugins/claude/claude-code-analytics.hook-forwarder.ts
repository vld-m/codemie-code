import { readState, isProcessAlive, spawnDaemon, DaemonState } from '../../../cli/commands/proxy/daemon-manager.js';
import { logger } from '../../../utils/logger.js';


async function restartDaemonFromState(state: DaemonState): Promise<DaemonState | null> {
  if (!state.targetUrl) {
    return null;
  }

  try {
    return await spawnDaemon({
      targetUrl: state.targetUrl,
      provider: state.provider ?? 'ai-run-sso',
      profile: state.profile,
      port: state.port,
      gatewayKey: state.gatewayKey,
      ...(state.model ? { model: state.model } : {}),
      ...(state.project ? { project: state.project } : {}),
      ...(state.clientType ? { clientType: state.clientType } : {}),
      ...(state.telemetryMode ? { telemetryMode: state.telemetryMode } : {}),
      ...(state.syncApiUrl ? { syncApiUrl: state.syncApiUrl } : {}),
      ...(state.syncCodeMieUrl ? { syncCodeMieUrl: state.syncCodeMieUrl } : {}),
    });
  } catch {
    return null;
  }
}

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
    let state = await readState();

    if (!state) {
      logger.debug('forwardHookEventToSpool: no daemon state found');
      return;
    }

    if (!isProcessAlive(state.pid)) {
      logger.debug(`forwardHookEventToSpool: daemon pid ${state.pid} not alive, attempting restart`);

      const restarted = await restartDaemonFromState(state);

      if (!restarted) {
        logger.info(`forwardHookEventToSpool: daemon restart failed`);
        return;
      }

      state = restarted;

      logger.debug(`forwardHookEventToSpool: daemon restarted (pid ${state.pid}) on port ${state.port}`);
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
