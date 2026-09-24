-- join_event selected on the stored status, so a competition whose clock had
-- run out but which nobody had pressed End on was still joinable. The
-- competitor was admitted and then shown "Time's up" immediately.
--
-- Everywhere else already treats an elapsed competition as ended; this brings
-- joining into line.
create or replace function public.join_event(p_employee_id text, p_display_name text)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare
  v_event          app.events;
  v_name           text;
  v_existing       app.participants;
  v_token          text;
  v_participant_id uuid;
begin
  v_name := trim(regexp_replace(coalesce(p_display_name, ''), '\s+', ' ', 'g'));

  if p_employee_id is null or p_employee_id !~ '^[0-9]{8}$' then
    raise exception 'Your employee ID must be exactly 8 digits.';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 60 then
    raise exception 'Please enter your name (2 to 60 characters).';
  end if;

  -- The clock is authoritative: an elapsed competition is closed, whether or
  -- not an administrator has pressed End Game.
  select * into v_event
    from app.events
   where status in ('open', 'running')
     and app.effective_status(status, ends_at) in ('open', 'running')
   limit 1;

  if not found then
    raise exception 'No competition is open at the moment. Please wait for the administrator.';
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  select * into v_existing from app.participants
   where event_id = v_event.id and employee_id = p_employee_id;

  if found then
    if v_existing.released_at is null then
      raise exception 'Employee ID % is already in this competition on another device. Ask the administrator to release it.', p_employee_id;
    end if;
    update app.participants
       set token_hash = app.hash_token(v_token), display_name = v_name,
           released_at = null, last_seen_at = now()
     where id = v_existing.id;
    v_participant_id := v_existing.id;
  else
    begin
      insert into app.participants (event_id, employee_id, display_name, token_hash)
      values (v_event.id, p_employee_id, v_name, app.hash_token(v_token))
      returning id into v_participant_id;
    exception when unique_violation then
      raise exception 'Employee ID % is already in this competition on another device. Ask the administrator to release it.', p_employee_id;
    end;
  end if;

  return json_build_object(
    'token', v_token,
    'participant_id', v_participant_id,
    'display_name', v_name,
    'event', json_build_object('id', v_event.id, 'name', v_event.name,
                               'status', app.effective_status(v_event.status, v_event.ends_at))
  );
end;
$$;

-- Same reasoning for the public title lookup: an elapsed competition is not
-- an open one, so the join screen falls back to its default heading.
create or replace function public.get_open_event()
returns json language plpgsql stable security definer set search_path = '' as $$
declare
  v_event app.events;
begin
  select * into v_event
    from app.events
   where status in ('open', 'running')
     and app.effective_status(status, ends_at) in ('open', 'running')
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
