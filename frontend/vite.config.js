import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'

// The production bundle is emitted into ../backend/frontend/dist so the
// Go `//go:embed all:frontend/dist` in backend/main.go can embed it
// (Go embed patterns cannot reference parent directories with '..').
export default defineConfig(({mode}) => ({
  plugins: [react()],
  server: {
    // Bind to IPv4 explicitly: Vite 7 binds 'localhost' to ::1 (IPv6) only,
    // which WebView2 cannot reach, causing a blank window in dev mode.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  },
  build: {
    // Web build (--mode web) emits to frontend/dist for Cloudflare Pages;
    // desktop build keeps emitting into ../backend/frontend/dist for Go embed.
    outDir: mode === 'web' ? 'dist' : '../backend/frontend/dist',
    emptyOutDir: true
  }
}))