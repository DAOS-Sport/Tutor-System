import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/liff/',
  build: { outDir: '../../server/public/liff' },
  server: { port: 3001, proxy: { '/api': 'http://localhost:3000' } }
});
