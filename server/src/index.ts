import "dotenv/config";
import { createApp } from "./app.js";
import path from "node:path";
import {
  applyPendingRestore,
  runRetention,
  checkCredential,
} from "./operations.js";
applyPendingRestore(path.resolve(process.env.DATA_DIR || "data"));
const port = Number(process.env.PORT || 3002);
const host = process.env.HOST || "127.0.0.1";
const app = createApp();
runRetention(app.locals.store);
const retentionTimer = setInterval(
  () => runRetention(app.locals.store),
  3600000,
);
retentionTimer.unref();
const healthTimer = setInterval(() => {
  void (async () => {
    for (const row of app.locals.store.db
      .prepare("SELECT id FROM credentials WHERE enabled=1")
      .all())
      await checkCredential(app.locals.store, String(row.id)).catch(() => {});
  })();
}, 5 * 60000);
healthTimer.unref();
const server = app.listen(port, host, () =>
  console.log(`FreeOCRapi: http://${host}:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () =>
    server.close(() => {
      clearInterval(retentionTimer);
      clearInterval(healthTimer);
      void app.locals.queue.close().then(() => {
        app.locals.store.close();
        process.exit(0);
      });
    }),
  );
