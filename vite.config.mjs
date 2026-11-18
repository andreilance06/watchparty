import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { copyFileSync, cpSync, mkdirSync } from 'node:fs';

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
      cpSync('vendor', 'dist/vendor', { recursive: true });
      const logo = 'assets/images/logo';
      mkdirSync(`dist/${logo}`, { recursive: true });
      copyFileSync(`${logo}/logo_watchparty.png`, `dist/${logo}/logo_watchparty.png`);
    },
  }],
  publicDir: false,
  // Only React needs prebundling. Preserve the pinned, already bundled media modules.
  optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime'] },
  server: {
    host: '0.0.0.0',
    proxy: Object.fromEntries(['/api', '/rooms', '/hls', '/ws', '/source', '/media'].map(path => [path, {
      target: 'http://127.0.0.1:3000', ws: ['/ws', '/source', '/rooms'].includes(path), changeOrigin: false,
    }])),
  },
  // Player modules intentionally remain external, beside their WASM and workers.
  build: { rollupOptions: { external: [/^\/vendor\//] } },
  test: { environment: 'jsdom', include: ['src/**/*.test.{js,jsx}'], setupFiles: ['./src/test-setup.js'] },
});
