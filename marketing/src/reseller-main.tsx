import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './reseller/reseller.css'
import { AuthProvider } from './tcd/authContext'
import { ResellerApp } from './reseller/ResellerApp'

document.body.classList.add('reseller-body')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <ResellerApp />
    </AuthProvider>
  </StrictMode>,
)
