import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, '');
  const apiPort = Number(env.PORT || 5050);

  return {
    plugins: [react()],
    root: projectRoot,
    server: {
      port: 5173,
      proxy: { '/api': `http://127.0.0.1:${apiPort}` }
    },
    build: { outDir: 'dist', emptyOutDir: true }
  };
});
