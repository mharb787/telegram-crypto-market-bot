import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DATA_DIR = path.resolve("data");
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 120_000;

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function readJson(fileName, fallback) {
  await ensureDataDir();
  const filePath = path.join(DATA_DIR, fileName);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === "ENOENT") return fallback;
      if (!(error instanceof SyntaxError) || attempt === 2) throw error;
      await delay(LOCK_RETRY_MS * (attempt + 1));
    }
  }
  return fallback;
}

export async function writeJson(fileName, value) {
  await ensureDataDir();
  const filePath = path.join(DATA_DIR, fileName);
  const releaseLock = await acquireFileLock(filePath);
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(tempPath, "wx");
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, filePath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
    await releaseLock();
  }
}

async function acquireFileLock(filePath) {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return async () => {
        await handle.close().catch(() => {});
        await fs.rm(lockPath, { force: true }).catch(() => {});
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stale = await isStaleLock(lockPath);
      if (stale) {
        await fs.rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for data lock: ${path.basename(filePath)}`);
      }
      await delay(LOCK_RETRY_MS);
    }
  }
}

async function isStaleLock(lockPath) {
  try {
    const stat = await fs.stat(lockPath);
    return Date.now() - stat.mtimeMs > LOCK_STALE_MS;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function appendJsonLog(fileName, value) {
  const current = await readJson(fileName, []);
  current.push(value);
  await writeJson(fileName, current.slice(-500));
}

export async function loadStrategy() {
  const defaultRaw = await fs.readFile(path.resolve("config/default-strategy.json"), "utf8");
  const defaults = JSON.parse(defaultRaw);
  const current = await readJson("strategy.json", null);
  if (!current) {
    await writeJson("strategy.json", defaults);
    return defaults;
  }
  return { ...defaults, ...current, weights: { ...defaults.weights, ...current.weights } };
}
