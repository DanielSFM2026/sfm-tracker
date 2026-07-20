import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Light mode preview: visit with ?light to turn on, ?light=0 to turn off.
// Choice persists per device via localStorage.
{
  const lightParam = new URLSearchParams(location.search).get('light')
  if (lightParam !== null) localStorage.setItem('theme', lightParam === '0' ? 'dark' : 'light')
  if (localStorage.getItem('theme') === 'light') document.documentElement.classList.add('light')
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
)
