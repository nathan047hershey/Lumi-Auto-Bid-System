import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src')
        }
    },
    server: {
        host: true,
        port: 5173,
        allowedHosts: [
        "neptunemart.space",
        "www.neptunemart.space"
        ],
        proxy: {
            '/api': {
                target: 'http://127.0.0.1:9017',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api/, '')
            },
            '/resumes': {
                target: 'http://127.0.0.1:9017',
                changeOrigin: true
            }
        }
    }
})
