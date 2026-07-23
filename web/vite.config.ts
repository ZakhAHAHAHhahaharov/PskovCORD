import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: './' — чтобы собранный билд грузился и из Electron (file://).
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: true,
    port: 5173,
  },
})
