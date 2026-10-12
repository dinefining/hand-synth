import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
    // Relative paths in the build, so the built site works from any folder or repo name on GitHub Pages
    base: command === 'build' ? './' : '/',
    server: {
        port: 3001,
        host: '0.0.0.0',
    },
    plugins: [react()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, '.'),
        },
    },
}));
