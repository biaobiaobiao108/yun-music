import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PlayerApp } from './shell'

createRoot(document.getElementById('root')!).render(<StrictMode><PlayerApp /></StrictMode>)
