import { loadConfig, redactConfig } from "./config.js";
import { startServer } from "./server.js";

function main(): void {
  const config = loadConfig();
  const safe = redactConfig(config);
  process.stdout.write(`config loaded: ${JSON.stringify(safe)}\n`);
  startServer();
  process.stdout.write("hn-pulse ready\n");
}

main();
