import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // o build em dist/ funciona servido de qualquer pasta
  server: { port: 5173 },
  build: { chunkSizeWarningLimit: 900 }, // three.js ocupa a maior parte
});
