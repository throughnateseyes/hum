import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { directorDevPlugin } from './server/vitePlugin'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), directorDevPlugin()],
})
