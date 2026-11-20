import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { directorDevPlugin } from './server/vitePlugin'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), directorDevPlugin()],
  // 127.0.0.1, not "localhost": on macOS Node binds "localhost" to IPv6 only, which some browsers can't reach
  server: { host: '127.0.0.1', port: 5173 },
})
