import { OkxClient } from "../src/okx.js";

try {
  const okx = new OkxClient();
  const data = await okx.request("GET", "/api/v5/account/config", null, { auth: true });
  console.log(`OKX auth ok: ${Array.isArray(data)}`);
} catch (error) {
  console.error(`OKX auth failed: ${error.message}`);
  process.exit(1);
}
