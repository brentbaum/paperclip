import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(async ({ command }) => ({
  plugins: [
    react(),
    tailwindcss(),
    (await import("vite-plugin-pwa")).VitePWA({
        registerType: "autoUpdate",
        manifest: false,
        devOptions: { enabled: false },
        workbox: {
          globPatterns: ["**/*.{js,css,html,png,svg,ico}"],
          navigateFallback: "/index.html",
          navigateFallbackDenylist: [/^\/api\//],
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        },
      }),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3100",
        ws: true,
      },
    },
  },
}));
