import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import devServer from "@hono/vite-dev-server";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * SW versioning plugin: at the end of `vite build`, read the public/sw.js
 * source, inject a build-hash token, and write the result into the dist
 * output. The hash is derived from the names of the emitted assets — Vite
 * already content-hashes them, so any change to the bundle yields a new
 * digest, which mutates the SW source byte-for-byte and triggers a real
 * SW update on the next page load.
 *
 * Also writes `__SW_BUILD_HASH__` into index.html for the in-page
 * `UpdateBanner` to display the running version.
 */
function swVersion(): Plugin {
  let outDir = "dist";
  let buildHash = "";
  return {
    name: "hermes-van:sw-version",
    apply: "build",
    configResolved(cfg) {
      outDir = cfg.build.outDir ?? "dist";
    },
    async writeBundle() {
      // Hash the asset filenames (already content-hashed by Vite).
      // Reading file contents would be redundant work.
      const assetsDir = resolve(outDir, "assets");
      const names = await readdir(assetsDir).catch(() => [] as string[]);
      buildHash = createHash("sha256")
        .update(names.sort().join("\n"))
        .digest("hex")
        .slice(0, 12);
      // Rewrite sw.js — Vite already copies it to dist as-is from public/,
      // we replace the marker in place.
      const swPath = resolve(outDir, "sw.js");
      try {
        const src = await readFile(swPath, "utf8");
        const out = src.replace(/__SW_BUILD_HASH__/g, buildHash);
        await writeFile(swPath, out, "utf8");
      } catch {
        // sw.js missing — non-fatal
      }
      // Inject into index.html as a meta so the client can read it.
      const htmlPath = resolve(outDir, "index.html");
      try {
        const html = await readFile(htmlPath, "utf8");
        const meta = `<meta name="sw-build" content="${buildHash}">`;
        const out = html.includes('name="sw-build"')
          ? html.replace(
              /<meta name="sw-build" content="[^"]*">/,
              meta,
            )
          : html.replace("</head>", `  ${meta}\n  </head>`);
        await writeFile(htmlPath, out, "utf8");
      } catch {
        // ignore — banner will fall back to "unknown"
      }
    },
  };
}

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
    swVersion(),
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
  build: {
    rollupOptions: {
      output: {
        // Split heavy third-party deps into their own chunks so the
        // initial app shell stays small. React/wouter ship together
        // (always needed); markdown + sanitizer is its own chunk
        // (only needed once a chat opens); webauthn lazy-splits with
        // SetupPage/LoginPage automatically.
        manualChunks: {
          "vendor-react": ["react", "react-dom", "wouter"],
          "vendor-markdown": ["marked", "dompurify"],
        },
      },
    },
  },
});
