import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SigmaClientProvider, client } from '@sigmacomputing/plugin'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SigmaClientProvider client={client}>
      <App />
    </SigmaClientProvider>
  </StrictMode>,
)
