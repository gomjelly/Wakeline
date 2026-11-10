import { defineConfig } from 'vite';

export default defineConfig({
  // 상대 경로로 빌드해야 Electron의 app:// 프로토콜에서 그대로 열린다.
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
