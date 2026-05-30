import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import devServer from "@hono/vite-dev-server";

export default defineConfig({
  plugins: [
    react(),
    devServer({
      entry: "src/server/index.ts",
      exclude: [
        // Routes NOT in this list reach Hono.
        // Pass-through to Vite: anything that's not /api/* and not /auth/*
        /^\/(?!api\/|auth\/).*/,
        /\/@.+$/,
        /\.(ts|tsx|css|js|svg|png|jpg|jpeg|webp)(\?.*)?$/,
        /^\/node_modules\/.*/,
        /^\/src\/.*/,
      ],
      injectClientScript: false,
    }),
  ],
  server: {
    port: 3015,
    host: "127.0.0.1",
  },
  resolve: {
    alias: {
      "~": "/src",
    },
  },
});
