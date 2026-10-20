import { Analytics } from '@vercel/analytics/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    {/* Vercel Web Analytics (cookieless page views), only on the deployed site:
        `pnpm dev` stays local. */}
    {import.meta.env.PROD && <Analytics mode='production' />}
  </StrictMode>
)
