import { OkxClient } from "../src/okx.js";
import fs from "node:fs";

if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

try {
  const okx = new OkxClient();
  const data = await okx.request("GET", "/api/v5/account/config", null, { auth: true });
  console.log(`OKX auth ok: ${Array.isArray(data)}`);
} catch (error) {
  console.error(`OKX auth failed: ${error.message}`);
  process.exit(1);
}
