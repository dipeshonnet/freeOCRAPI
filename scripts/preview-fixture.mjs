// Disposable local UI verification. Never uses the normal installation account.
import path from "node:path";
import { Store } from "../server/dist/store.js";
import { passwordHash } from "../server/dist/auth.js";
import { createApp } from "../server/dist/app.js";
const store = new Store(path.resolve("data/preview-fixture"));
if (!store.hasUser())
  store.db
    .prepare("INSERT INTO users VALUES(1,?,?)")
    .run("preview@example.test", passwordHash("preview-local-only-2026"));
const app = createApp(store);
const server = app.listen(3003, "127.0.0.1", () =>
  console.log(
    "Disposable UI preview: http://127.0.0.1:3003 (preview@example.test / preview-local-only-2026)",
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(
      () =>
        void app.locals.queue.close().then(() => {
          store.close();
          process.exit(0);
        }),
    ),
  );
