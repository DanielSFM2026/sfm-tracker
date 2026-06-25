import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !key) {
  console.error(
    'Missing Supabase env vars. Copy .env.example to .env and fill in your project values.'
  )
}

export const supabase = createClient(url, key)
