import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'

// Out directory depends on the target:
//   - desktop build (--mode desktop, invoked by wails): emits into
//     ../backend/frontend/dist so Go `//go:embed all:frontend/dist`
//     (in backend/main.go) can embed it (Go embed cannot reference '..').
//   - web / default build (npm run build, used by Cloudflare Pages):
//     emits into ./dist inside the frontend publish root.
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
    outDir: mode === 'desktop' ? '../backend/frontend/dist' : 'dist',
    emptyOutDir: true
  }
}))