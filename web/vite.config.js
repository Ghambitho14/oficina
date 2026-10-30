import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // En desarrollo, las llamadas a /api van al servidor Node.
  server: { proxy: { '/api': 'http://localhost:3000' } },
  // three.js + drei pesan ~260 KB gzip; van en su propio archivo y solo se cargan tras el login.
  build: { chunkSizeWarningLimit: 1100 },
});
