import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { RouterProvider } from 'react-router/dom'
import { createQueryClient } from './api/queryClient'
import { startAppearance } from './appearance/appearance'
import { ToastProvider } from './components/ui/Toast'
import { i18n } from './i18n'
import { applyBootIdentity, primeBootIdentity } from './identity/boot'
import './index.css'
import { registerServiceWorker } from './pwa/registerServiceWorker'
import { createAppRouter } from './router'

// Before the first render: the colour scheme of the device's appearance (public/appearance.js put it on
// the document before the first paint; from here on it follows a change), then the device's own copy
// of the page's identity (its colours, its tab icon).
startAppearance()
applyBootIdentity()

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root element in index.html')

const queryClient = createQueryClient()
const router = createAppRouter()

const root = createRoot(container)
// A company this device has never seen is asked for first, briefly: the page then opens in its colours.
void primeBootIdentity(queryClient).then(() => {
  root.render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </QueryClientProvider>
      </I18nextProvider>
    </StrictMode>,
  )
})

registerServiceWorker()
