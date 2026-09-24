/**
 * Thin wrapper over the Supabase RPC endpoints.
 *
 * Deliberately dependency-free: no supabase-js, no CDN. On a conference-centre
 * phone signal the difference between one small script and a bundle is real,
 * and it removes a third party from the critical path on event day.
 */

import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export class ApiError extends Error {
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  /** True when the server says this session is no longer valid. */
  get isSessionExpired() {
    return this.status === 403 || this.status === 401;
  }
}

/**
 * Call a Postgres function. `accessToken` is a Supabase Auth JWT for admin
 * calls; competitors pass nothing and travel as the anon role.
 */
export async function rpc(name, body = {}, { accessToken = null, signal } = {}) {
  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${accessToken ?? SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause;
    throw new ApiError('Cannot reach the server. Check your connection.', { status: 0 });
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    // Postgres RAISE EXCEPTION messages are written for competitors to read,
    // so show them rather than a generic failure.
    const message = payload?.message || payload?.error_description || payload?.error
      || `Request failed (${response.status}).`;
    throw new ApiError(message, { status: response.status, code: payload?.code ?? null });
  }

  return payload;
}

/** Sign in an administrator against Supabase Auth. */
export async function signIn(email, password) {
  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection.', { status: 0 });
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      payload?.error_description || payload?.msg || 'Sign in failed.',
      { status: response.status },
    );
  }
  return payload; // { access_token, refresh_token, expires_at, user }
}

export const competitor = {
  join:      (employeeId, name)      => rpc('join_event', { p_employee_id: employeeId, p_display_name: name }),
  state:     (token, opts)           => rpc('get_event_state', { p_token: token }, opts),
  puzzle:    (token)                 => rpc('get_puzzle', { p_token: token }),
  check:     (token, entryId, guess) => rpc('check_answer', { p_token: token, p_entry_id: entryId, p_guess: guess }),
  save:      (token, gridState)      => rpc('save_progress', { p_token: token, p_grid_state: gridState }),
  /** Title of the open competition, readable before anyone has joined. */
  openEvent: ()                      => rpc('get_open_event', {}),
};

export const admin = {
  whoami:    (t)                 => rpc('admin_whoami', {}, { accessToken: t }),
  events:    (t)                 => rpc('admin_list_events', {}, { accessToken: t }),
  create:    (t, name, seconds)  => rpc('admin_create_event', { p_name: name, p_duration_seconds: seconds }, { accessToken: t }),
  setPuzzle: (t, id, puzzle)     => rpc('admin_set_puzzle', { p_event_id: id, p_puzzle: puzzle }, { accessToken: t }),
  open:      (t, id)             => rpc('admin_open_event', { p_event_id: id }, { accessToken: t }),
  start:     (t, id)             => rpc('admin_start_event', { p_event_id: id }, { accessToken: t }),
  end:       (t, id)             => rpc('admin_end_event', { p_event_id: id }, { accessToken: t }),
  board:     (t, id)             => rpc('admin_leaderboard', { p_event_id: id }, { accessToken: t }),
  release:   (t, pid)            => rpc('admin_release_participant', { p_participant_id: pid }, { accessToken: t }),
  reset:     (t, id)             => rpc('admin_reset_event', { p_event_id: id, p_confirm: 'RESET' }, { accessToken: t }),
  setTitle:  (t, id, title)      => rpc('admin_set_event_title', { p_event_id: id, p_title: title }, { accessToken: t }),
  saveDraft: (t, id, rows)       => rpc('admin_save_draft', { p_event_id: id, p_rows: rows }, { accessToken: t }),
  getDraft:  (t, id)             => rpc('admin_get_draft', { p_event_id: id }, { accessToken: t }),
};
