import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// Frontend lives in ./frontend but reads ABIs/addresses/accounts from the
// project root (../data, ../artifacts). Allow Vite to serve those paths.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    fs: {
      allow: [path.resolve(__dirname, "..")],
    },
  },
});
