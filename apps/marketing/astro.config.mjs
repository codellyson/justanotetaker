// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Tailwind 4 plugs in via Vite, not the legacy @astrojs/tailwind integration.
  vite: {
    plugins: [tailwindcss()],
  },
  server: {
    port: 4321,
  },
});
