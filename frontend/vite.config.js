import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// /api/* is proxied to the backend with the prefix stripped (same as nginx in Docker).
const proxy = { '/api': { target: process.env.API_URL || 'http://localhost:4000', rewrite: (p) => p.replace(/^\/api/, '') } };

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
});
