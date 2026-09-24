-- The join screen shows the competition title before anyone has a session, so
-- it needs a token-free way to read it. This returns the title and status of
-- the one open or running competition and nothing else: no ids, no counts, no
-- timings. There is nothing here a competitor could not read off the screen.
create or replace function public.get_open_event()
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_event app.events;
begin
  select * into v_event
    from app.events
   where status in ('open', 'running')
   limit 1;

  if not found then
    return json_build_object('name', null, 'status', 'none');
  end if;

  return json_build_object(
    'name',   v_event.name,
    'status', app.effective_status(v_event.status, v_event.ends_at)
  );
end;
$$;

-- The title is the one thing an administrator may want to correct after
-- creating the competition, including while it is running, since it only
-- affects what competitors see rather than the outcome.
create or replace function public.admin_set_event_title(p_event_id uuid, p_title text)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_title text;
begin
  perform app.require_admin();

  v_title := trim(regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g'));
  if char_length(v_title) < 1 or char_length(v_title) > 120 then
    raise exception 'The title must be between 1 and 120 characters.';
  end if;

  update app.events set name = v_title where id = p_event_id;
  if not found then
    raise exception 'Unknown competition.';
  end if;

  return json_build_object('name', v_title);
end;
$$;

revoke execute on function public.get_open_event()                     from public;
revoke execute on function public.admin_set_event_title(uuid, text)    from public, anon;

grant execute on function public.get_open_event()                  to anon, authenticated;
grant execute on function public.admin_set_event_title(uuid, text) to authenticated;
