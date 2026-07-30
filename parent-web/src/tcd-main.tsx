import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthProvider } from './AuthContext'
import { TcdStandalonePage } from './pages/TcdStandalonePage'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <TcdStandalonePage />
    </AuthProvider>
  </StrictMode>,
)
