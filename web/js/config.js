/**
 * Deployment configuration.
 *
 * The key below is Supabase's *publishable* key. It is meant to be readable by
 * every visitor: it only grants the `anon` role, which can call the five
 * competitor functions and nothing else. It cannot read a table, and it cannot
 * reach an admin endpoint. See supabase/README.md.
 */

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** Empty string means "same origin", which is how the local dev server works. */
export const SUPABASE_URL = LOCAL_HOSTS.includes(location.hostname)
  ? ''
  : 'https://wtmzothubshasogrcbob.supabase.co';

export const SUPABASE_KEY = 'sb_publishable_ber-gmJFDSAxj0BNf5fntg_-bYC_obp';

// If the publishable key is ever rejected with a 401, this project's legacy
// anon key works too and can be swapped in above:
// 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind0bXpvdGh1YnNoYXNvZ3JjYm9iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxMjMxMzIsImV4cCI6MjEwNTY5OTEzMn0.A9AcwoaRiQbVsihvSyq5izr-mWPCdyDawL3yfrhfhto'

/** Poll intervals, in milliseconds. Sized in docs/DESIGN.md section 9. */
export const POLL_WAITING_MS = 5000;
export const POLL_PLAYING_MS = 15000;
export const AUTOSAVE_MS = 15000;
