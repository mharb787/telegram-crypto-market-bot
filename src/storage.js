import fs from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.resolve("data");

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function readJson(fileName, fallback) {
  await ensureDataDir();
  const filePath = path.join(DATA_DIR, fileName);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJson(fileName, value) {
  await ensureDataDir();
  const filePath = path.join(DATA_DIR, fileName);
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
