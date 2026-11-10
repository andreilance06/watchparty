import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cpSync, mkdirSync } from 'node:fs';

export default defineConfig({
  plugins: [{
    name: 'watchparty-external-player', enforce: 'pre', apply: 'build',
    resolveId(source) {
      const vendor = source.match(/(?:^|\/)vendor\/(movi-player\.js|jassub\/jassub\.js)$/);
      if (vendor) return { id: `/vendor/${vendor[1]}`, external: true };
    },
  }, react(), tailwindcss(), {
    name: 'watchparty-static-assets',
    closeBundle() {
      mkdirSync('dist', { recursive: true });
      for (const directory of ['vendor', 'assets']) cpSync(directory, `dist/${directory}`, { recursive: true });
    },
  }],
  publicDir: false,
  // Only React needs prebundling. Preserve the pinned, already bundled media modules.
  optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime'] },
  server: {
    host: '0.0.0.0',
    proxy: Object.fromEntries(['/api', '/rooms', '/hls', '/ws', '/media'].map(path => [path, {
      target: 'http://127.0.0.1:3000', ws: path === '/ws' || path === '/rooms', changeOrigin: false,
    }])),
  },
  // Player modules intentionally remain external, beside their WASM and workers.
  build: { rollupOptions: { external: [/^\/vendor\//] } },
  test: { environment: 'jsdom', include: ['src/**/*.test.{js,jsx}'], setupFiles: ['./src/test-setup.js'] },
});
