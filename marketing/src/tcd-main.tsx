import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './tcd/tcd.css'
import { AuthProvider } from './tcd/authContext'
import { TcdApp } from './tcd/TcdApp'

document.body.classList.add('tcd-body')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <TcdApp />
    </AuthProvider>
  </StrictMode>,
)
