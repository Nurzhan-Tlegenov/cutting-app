import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Версия приложения = дата и время сборки (по Алматы), например 261016.0921, и коммит (на Vercel).
// Видна внизу бокового меню и на экране входа — так понятно, какая версия открыта на телефоне.
const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Almaty', year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  .formatToParts(new Date()).map(x => [x.type, x.value]))
const APP_VERSION = `${p.year}${p.month}${p.day}.${p.hour}${p.minute}`
const APP_COMMIT = String(process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7)

// https://vite.dev/config/
// version.json — по нему открытое приложение узнаёт, что вышла новая версия (UpdateWatcher)
const versionFile = { name: 'version-file', apply: 'build', generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ v: APP_VERSION }) }) } }

export default defineConfig({
  plugins: [react(), versionFile],
  resolve: {
    alias: [
      // mdb-reader (импорт К3-Мебель): шифрование Access не нужно, а его зависимости тянут Node-потоки и process
      { find: /^browserify-aes(\/.*)?$/, replacement: '/src/lib/shims/mdbCrypto.js' },
      { find: /^create-hash(\/.*)?$/, replacement: '/src/lib/shims/mdbCrypto.js' },
    ],
  },
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __APP_COMMIT__: JSON.stringify(APP_COMMIT),
  },
})
