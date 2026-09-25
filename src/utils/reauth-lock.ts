import { readFile, writeFile, unlink } from "node:fs/promises";
import { logger } from "@/utils/logger.js";
import { getCodemiePath } from "@/utils/paths.js"; // adjust if analytics-auth-status.ts imports from elsewhere

export interface ReauthLockState {
  pid: number;
  spawnedAt: number;
}

function getLockPath(): string {
  return getCodemiePath("reauth-lock.json");
}

export async function getReauthLock(): Promise<ReauthLockState | null> {
  try {
    const raw = await readFile(getLockPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<ReauthLockState>;
    if (typeof parsed.pid === "number" && typeof parsed.spawnedAt === "number") {
      return { pid: parsed.pid, spawnedAt: parsed.spawnedAt };
    }
    return null;
  } catch (error) {
    logger.debug(`[reauth-lock] failed to read lock: ${(error as Error).message}`);
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function setReauthLock(pid: number): Promise<void> {
  try {
    const state: ReauthLockState = { pid, spawnedAt: Date.now() };
    await writeFile(getLockPath(), JSON.stringify(state), "utf-8");
  } catch (error) {
    logger.debug(`[reauth-lock] failed to write lock: ${(error as Error).message}`);
  }
}

export async function clearReauthLock(): Promise<void> {
  try {
    await unlink(getLockPath());
  } catch (error) {
    logger.debug(`[reauth-lock] failed to clear lock: ${(error as Error).message}`);
  }
}
