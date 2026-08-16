import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 6001 },
  cacheDir: path.resolve(__dirname, ".vite-temp"),
  resolve: {
    alias: {
      convex: path.resolve(__dirname, "node_modules/convex"),
    },
  },
});
