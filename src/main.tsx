import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'
import './lib/version' // logs the real build SHA/time once on load -- see item D of the 2026-08-27 auth/cache bugfix directive.

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
