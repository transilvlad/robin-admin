import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { federation } from '@module-federation/vite';
import { fileURLToPath } from 'node:url';
import { normalizeBasePath } from './src/utils/basePath.ts';

const buildId = process.env.VITE_BUILD_ID ?? Date.now().toString(36);

export default defineConfig({
  base: normalizeBasePath(process.env.VITE_BASE_PATH),
  plugins: [
    tailwindcss(),
    react(),
    federation({
      name: 'robin_admin_host',
      shared: {
        react: {
          singleton: true,
        },
        'react-dom': {
          singleton: true,
        },
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-${buildId}-[hash].js`,
        chunkFileNames: `assets/[name]-${buildId}-[hash].js`,
        assetFileNames: `assets/[name]-${buildId}-[hash][extname]`,
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    pool: 'vmThreads',
    setupFiles: './src/test/setup.ts',
    css: true,
    // Page tests render whole screens in jsdom with every file in parallel;
    // on a loaded CI runner some take longer than the 5 s default.
    testTimeout: 20_000,
  },
});
