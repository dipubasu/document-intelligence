import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Requests to /api are forwarded to the backend, so the browser never needs CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
});