import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config()

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

export async function loadSession() {
  const { data, error } = await supabase
    .from('sessions')
    .select('data')
    .eq('id', 'whatsapp')
    .single()

  if (error) {
    console.log('No session found:', error.message)
    return null
  }

  return data?.data || null
}

export async function saveSession(authData) {
  const { error } = await supabase
    .from('sessions')
    .upsert({
      id: 'whatsapp',
      data: authData,
      updated_at: new Date()
    })

  if (error) console.error('Error saving session:', error.message)
}
