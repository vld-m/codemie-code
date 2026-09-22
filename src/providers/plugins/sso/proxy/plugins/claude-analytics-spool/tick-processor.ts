import { readFile, writeFile } from 'node:fs/promises';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import type { SSOCredentials, JWTCredentials } from '../../../../../core/types.js';
import { sessionFile, spoolRoot } from './spool-paths.js';
import { withSessionLock } from './session-lock.js';
import { gateDecision } from './completeness-gate.js';
import type { SessionStatus } from './completeness-gate.js';
import { forwardSession } from './forwarder.js';

async function readStatusFile(sessionId: string): Promise<SessionStatus | null> {
  try {
    const raw = await readFile(sessionFile(sessionId, 'status'), 'utf-8');
    return JSON.parse(raw) as SessionStatus;
  } catch {
    return null;
  }
}

async function writeStatusFile(sessionId: string, status: SessionStatus): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(spoolRoot(), { recursive: true });
  await writeFile(sessionFile(sessionId, 'status'), JSON.stringify(status), 'utf-8');
}

/**
 * Process one tick for a single session.
 * Reads status, evaluates the completeness gate, and dispatches forward or wait.
 */
export async function processSessionTick(
  sessionId: string,
  credentials: SSOCredentials | JWTCredentials
): Promise<void> {
  await withSessionLock(sessionId, async () => {
    const status = await readStatusFile(sessionId);
    if (!status) return;

    if (status.forwarded) return;
    if (status.authExpired) return;

    const decision = gateDecision(status);
    logger.debug(
      '[claude-analytics-tick] gate decision',
      ...sanitizeLogArgs({ sessionId, decision, waitTicks: status.waitTicks })
    );

    if (decision === 'send' || decision === 'hooks-only-force') {
      await forwardSession(sessionId, decision === 'hooks-only-force', credentials);
    } else if (decision === 'wait') {
      status.waitTicks = (status.waitTicks ?? 0) + 1;
      await writeStatusFile(sessionId, status);
    }
    // 'noop': nothing to do
  });
}
