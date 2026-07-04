import { createConfig } from "./config.js";
import { loadEnvFiles } from "./env.js";
import { createServer } from "./server.js";

loadEnvFiles();
const config = createConfig();
const app = await createServer(config);

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`cluo-server listening on http://${config.host}:${config.port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
