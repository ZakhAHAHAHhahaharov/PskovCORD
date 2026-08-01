import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import pkg from './package.json'

// Версия сборки, вшиваемая в бандл. Едет с каждым отчётом об ошибке
// (см. errorTransport.ts): без неё нельзя ответить на главный вопрос при
// разборе — «это старая вкладка или уже после выкатки?». В CI берём короткий
// хеш коммита, локально — метку dev.
const commit = (process.env.GITHUB_SHA || '').slice(0, 7)
const appVersion = `${pkg.version}+${commit || 'dev'}`

// base: './' — чтобы собранный билд грузился и из Electron (file://).
export default defineConfig({
  plugins: [react()],
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    host: true,
    port: 5173,
  },
})
