import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, '');
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
    // The Firebase SDK is its own chunk: every page needs it to know who is
    // signed in, and it changes on a different schedule from the app.
    build: {
      rolldownOptions: {
        output: { codeSplitting: { groups: [{ name: 'firebase', test: /node_modules[\\/](@firebase|firebase)[\\/]/ }] } },
      },
    },
    server: {
      port: 5180,
      strictPort: true,
      host: '127.0.0.1',
      // In development the API is the Functions emulator (or `npm run api`),
      // served on the app's origin as Hosting serves it in production.
      proxy: {
        '/api': {
          target: env.VITE_API_PROXY || 'http://127.0.0.1:5011/insat-hyber/us-central1/api',
          changeOrigin: true,
        },
      },
    },
  };
});
