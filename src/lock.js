import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 单实例锁：同一个机器人同时只能有一条长连接，新连接会踢掉旧的。
 *
 * 前台调试与 launchd 各跑一份时，两份进程会互相踢线，表现为「刚问就断」。
 * 这里用 pid 文件挡住第二份：锁里记录的进程还活着就拒绝启动。
 *
 * 进程被杀不会清锁，所以每次启动都要用 pid 探活判断是否遗留；
 * 但 pid 会被系统复用，因此锁里同时记启动时刻，仅作人工排查信息。
 *
 * @param {{lockPath: string, pid?: number, isAlive?: (pid: number) => boolean}} options
 * @returns {Promise<{acquired: boolean, holder?: number, reason?: string}>}
 */
export async function acquireLock({ lockPath, pid = process.pid, isAlive = defaultIsAlive }) {
  const existing = await readLock(lockPath);
  if (existing && existing.pid !== pid && isAlive(existing.pid)) {
    return { acquired: false, holder: existing.pid, reason: "已有实例在运行" };
  }

  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`, "utf8");
  return { acquired: true };
}

/**
 * @param {string} lockPath
 * @returns {Promise<{pid: number} | null>}
 */
async function readLock(lockPath) {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8"));
    return typeof parsed?.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

/** @param {number} pid */
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

/**
 * 释放锁。只删自己写的锁，避免误删别的实例的。
 *
 * @param {{lockPath: string, pid?: number}} options
 */
export async function releaseLock({ lockPath, pid = process.pid }) {
  const existing = await readLock(lockPath);
  if (existing && existing.pid !== pid) return;
  try {
    await unlink(lockPath);
  } catch {
    // 已经不在了
  }
}
