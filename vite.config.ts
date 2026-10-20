import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { murmurationData } from './src/server/plugin'

export default defineConfig({
  plugins: [react(), tailwindcss(), murmurationData()],
  // three.js and its helpers are one big chunk; fine for a local app.
  build: { chunkSizeWarningLimit: 2000 },
  server: {
    // The analytics cache is derived output; don't reload the page when it's written.
    watch: { ignored: ['**/.cache/**'] }
  }
})
