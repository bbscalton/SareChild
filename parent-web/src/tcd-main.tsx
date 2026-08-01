import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../marketing/src/index.css'
import '../../marketing/src/tcd/tcd.css'
import { AuthProvider } from '../../marketing/src/tcd/authContext'
import { TcdApp } from '../../marketing/src/tcd/TcdApp'

document.body.classList.add('tcd-body')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <TcdApp />
    </AuthProvider>
  </StrictMode>,
)
