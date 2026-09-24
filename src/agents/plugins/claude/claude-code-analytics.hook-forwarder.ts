import { readState, isProcessAlive, spawnDaemon, DaemonState } from '../../../cli/commands/proxy/daemon-manager.js';
import { DEFAULT_DAEMON_PORT, normalizeDaemonModel } from '../../../cli/commands/proxy/connect-orchestrator.js';
import { logger } from '../../../utils/logger.js';
import { ensureApiBase } from '@/providers/core/codemie-auth-helpers.js';

/**
 * Fire-and-forget forward of a raw Claude Code hook event to the local proxy
 * daemon's analytics spool endpoint.
 *
 * - Calls readState() to get daemon URL and gateway key
 * - If no daemon or process is dead, attempts to restart/start the daemon
 * - POSTs { agentName, timestamp, raw: rawInput } to /v1/analytics/claude-code/hooks
 * - Uses 1500ms timeout and swallows all errors
 * - Never throws, never blocks Claude Code's exit, never affects hook's exit code
 */
export async function forwardHookEventToSpool(rawInput: string, agentName: string): Promise<void> {
  try {
    const state = await ensureRunningDaemon(await readState());

    if (!state) {
      logger.debug('forwardHookEventToSpool: daemon unavailable, skipping forward');
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

async function ensureRunningDaemon(state: DaemonState | null): Promise<DaemonState | null> {
  if (!state) {
    return startDaemon();
  }

  if (!isProcessAlive(state.pid)) {
    return restartDaemonFromState(state);
  }

  return state;
}

async function startDaemon(): Promise<DaemonState | null> {
  try {
    const { ConfigLoader } = await import('../../../utils/config.js');

    const cwd = process.cwd();

    const activeProfileName = await ConfigLoader.getActiveProfileName(cwd);

    const config = await ConfigLoader.load(
      cwd,
      activeProfileName ? { name: activeProfileName } : undefined
    );

    if (!config.baseUrl) {
      return null;
    }

    const model = normalizeDaemonModel(config.model);


    const args ={
      targetUrl: config.baseUrl,
      provider: config.provider ?? 'ai-run-sso',
      profile: config.name ?? 'default',
      port: DEFAULT_DAEMON_PORT,
      project: config.codeMieProject,
      syncCodeMieUrl: config.codeMieUrl,
      syncApiUrl: config.codeMieUrl ? ensureApiBase(config.codeMieUrl) : config.baseUrl,
      model
    }

    return await spawnDaemon(args);
  } catch {
    return null;
  }
}

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
