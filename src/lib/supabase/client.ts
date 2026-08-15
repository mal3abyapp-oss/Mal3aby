import { createClient } from '@supabase/supabase-js'
import type { Database } from './types'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  // Fails loudly and early rather than silently making unauthenticated
  // requests to an undefined host — see docs/PROJECT_RULES.md rule on
  // never trusting an unset config value.
  throw new Error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.local and fill in the project values.',
  )
}

// Only the anon/publishable key is ever used client-side — the service_role
// key must never appear in frontend code. See docs/RLS_SECURITY.md and
// docs/SECURITY_ANTI_FRAUD.md#platform-owner-security.
export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey)
