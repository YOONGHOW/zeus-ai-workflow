import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  publicDir: 'src/public',
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        app: resolve(__dirname, 'src/public/html/main.html'),
        setting: resolve(__dirname, 'src/public/html/setting.html'),
        error: resolve(__dirname, 'src/public/html/error.html'),
      },
    },
  },
})
