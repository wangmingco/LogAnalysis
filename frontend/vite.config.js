import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'

// The production bundle is emitted into ../backend/frontend/dist so the
// Go `//go:embed all:frontend/dist` in backend/main.go can embed it
// (Go embed patterns cannot reference parent directories with '..').
export default defineConfig({
  plugins: [react()],
  server: {
    // Bind to IPv4 explicitly: Vite 7 binds 'localhost' to ::1 (IPv6) only,
    // which WebView2 cannot reach, causing a blank window in dev mode.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: '../backend/frontend/dist',
    emptyOutDir: true
  }
})