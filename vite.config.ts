import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  if (
    env.VITE_SUPABASE_PUBLISHABLE_KEY &&
    !env.VITE_SUPABASE_PUBLISHABLE_KEY.startsWith("sb_publishable_")
  )
    throw new Error(
      "VITE_SUPABASE_PUBLISHABLE_KEY must be a public sb_publishable_ key; secret keys must never enter a frontend build.",
    );
  const base = env.VITE_BASE_PATH || "/";
  if (!base.startsWith("/") || !base.endsWith("/"))
    throw new Error("VITE_BASE_PATH must start and end with /");
  return {
    base,
    plugins: [
      react(),
      VitePWA({
        registerType: "prompt",
        includeAssets: ["icon.svg", "apple-touch-icon.png", "examples/*"],
        manifest: {
          name: "Flashcards — учить и помнить",
          short_name: "Flashcards",
          lang: "ru",
          description: "Ваши слова, маленькие шаги, надолго в памяти.",
          theme_color: "#285e4b",
          background_color: "#f7f8f4",
          display: "standalone",
          start_url: base,
          scope: base,
          id: base,
          icons: [192, 512].map((size) => ({
            src: `icon-${size}.png`,
            sizes: `${size}x${size}`,
            type: "image/png",
            purpose: "any maskable",
          })),
        },
        workbox: {
          globPatterns: ["**/*.{js,css,html,svg,png,ico,csv,xlsx}"],
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          navigateFallback: `${base}index.html`,
          navigateFallbackAllowlist: [
            new RegExp("^" + base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          ],
          cleanupOutdatedCaches: true,
        },
      }),
    ],
    build: {
      sourcemap: true,
    },
  };
});
