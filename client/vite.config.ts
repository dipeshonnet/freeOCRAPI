import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  const serverPort = environment.PORT || process.env.PORT || "3002";
  return {
    root: path.resolve("client"),
    plugins: [react()],
    define: { __SERVER_PORT__: JSON.stringify(String(serverPort)) },
    server: {
      host: "127.0.0.1",
      port: 5174,
      strictPort: true,
      proxy: Object.fromEntries(
        ["/api", "/v1", "/mcp", "/health"].map((p) => [
          p,
          `http://127.0.0.1:${serverPort}`,
        ]),
      ),
    },
    build: { outDir: "dist" },
  };
});
