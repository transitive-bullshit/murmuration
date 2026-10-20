import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { SiteAnalytics } from './analytics'
import { App } from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    {/* Only on the deployed site: `pnpm dev` stays local. */}
    {import.meta.env.PROD && <SiteAnalytics />}
  </StrictMode>
)
