import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

const mount = document.getElementById('root')
if (!mount) {
  throw new Error('Root element not found')
}

const root = createRoot(mount)

async function bootstrap() {
  try {
    const [{ AuthProvider }, { default: App }] = await Promise.all([
      import('./AuthContext'),
      import('./App'),
    ])
    root.render(
      <StrictMode>
        <AuthProvider>
          <App />
        </AuthProvider>
      </StrictMode>,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown startup error'
    root.render(
      <div className="auth-shell">
        <div className="auth-card">
          <h1>Startup error</h1>
          <p className="muted">
            The dashboard failed to load. Check Firebase and environment variables, then redeploy.
          </p>
          <p className="error">{message}</p>
        </div>
      </div>,
    )
  }
}

void bootstrap()
