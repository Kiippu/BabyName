import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// host:true so the dev server is reachable from a phone on the same LAN;
// /api is proxied to the Express process so cookies stay same-origin in prod
// but dev still works without CORS gymnastics.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
