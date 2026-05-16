const { Client } = require("ssh2");

const required = ["SSH_PASSWORD", "OKX_API_KEY", "OKX_API_SECRET", "OKX_API_PASSPHRASE"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(", ")}`);
  process.exit(2);
}

const remoteEnvPath = process.env.REMOTE_ENV_PATH || "/opt/telegram-crypto-market-bot/.env";

function upsertEnv(raw, updates) {
  const seen = new Set();
  const lines = raw.split(/\r?\n/).filter((line) => line.length);
  const updated = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match || !(match[1] in updates)) return line;
    seen.add(match[1]);
    return `${match[1]}=${updates[match[1]]}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) updated.push(`${key}=${value}`);
  }
  return `${updated.join("\n")}\n`;
}

const conn = new Client();
conn
  .on("ready", () => {
    conn.sftp((sftpError, sftp) => {
      if (sftpError) throw sftpError;
      sftp.readFile(remoteEnvPath, "utf8", (readError, raw = "") => {
        if (readError && readError.code !== 2) throw readError;
        const next = upsertEnv(raw, {
          OKX_API_KEY: process.env.OKX_API_KEY,
          OKX_API_SECRET: process.env.OKX_API_SECRET,
          OKX_API_PASSPHRASE: process.env.OKX_API_PASSPHRASE,
          OKX_SIMULATED_TRADING: process.env.OKX_SIMULATED_TRADING || "false"
        });
        sftp.writeFile(remoteEnvPath, next, { mode: 0o600 }, (writeError) => {
          if (writeError) throw writeError;
          conn.exec("chmod 600 /opt/telegram-crypto-market-bot/.env && systemctl restart telegram-crypto-market-bot", (execError, stream) => {
            if (execError) throw execError;
            stream.on("close", (code) => {
              conn.end();
              process.exit(code ?? 0);
            });
          });
        });
      });
    });
  })
  .on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  })
  .connect({
    host: process.env.SSH_HOST || "187.77.96.158",
    username: process.env.SSH_USER || "root",
    password: process.env.SSH_PASSWORD,
    readyTimeout: 15000
  });
