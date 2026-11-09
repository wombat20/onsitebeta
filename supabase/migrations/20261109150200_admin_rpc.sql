-- onsitebeta: service-role-only RPCs used by the admin-ops edge function.
-- All are SECURITY DEFINER with an empty search_path and are NOT executable by
-- anon / authenticated (only service_role, i.e. the edge function).

-- Revoke every refresh token / session of a user (access tokens already issued stay
-- valid until expiry, which is why RLS also checks members.disabled / must_change).
create or replace function public.admin_kill_sessions(p_uid uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from auth.sessions where user_id = p_uid;
$$;

-- Atomically consume a bootstrap token (sha256 hex). true = consumed now, false = unknown/used.
create or replace function public.admin_use_bootstrap_token(p_sha256 text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  with u as (
    update private.bootstrap_tokens
       set used_at = now()
     where token_sha256 = lower(p_sha256)
       and used_at is null
    returning 1
  )
  select exists (select 1 from u);
$$;

-- reset_event: clear the operation data of one event, keep roster and accounts.
-- Tombstones (not deletes) for apps/conduct/extra so realtime clients converge.
create or replace function public.admin_reset_event(p_ev text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.apps    set data = '{}'::jsonb, updated_by = null where event_code = p_ev and data <> '{}'::jsonb;
  update public.conduct set data = null where event_code = p_ev and data is not null;
  update public.extra   set data = null where event_code = p_ev and data is not null;
  delete from public.log where event_code = p_ev;
  update public.events  set reset_at = now() where code = p_ev;
end;
$$;

-- purge_event (data part): hard-delete operation data and blank the roster.
-- Operator auth users are deleted by the edge function through the Admin API.
create or replace function public.admin_purge_event_data(p_ev text, p_v bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.apps    where event_code = p_ev;
  delete from public.conduct where event_code = p_ev;
  delete from public.extra   where event_code = p_ev;
  delete from public.log     where event_code = p_ev;
  update public.roster
     set "rows" = '[]'::jsonb, labels = '{}'::jsonb, file = null, "at" = null, "by" = null, v = p_v
   where event_code = p_ev;
  update public.events set reset_at = now() where code = p_ev;
end;
$$;

revoke all on function public.admin_kill_sessions(uuid)          from public, anon, authenticated;
revoke all on function public.admin_use_bootstrap_token(text)    from public, anon, authenticated;
revoke all on function public.admin_reset_event(text)            from public, anon, authenticated;
revoke all on function public.admin_purge_event_data(text, bigint) from public, anon, authenticated;
grant execute on function public.admin_kill_sessions(uuid)          to service_role;
grant execute on function public.admin_use_bootstrap_token(text)    to service_role;
grant execute on function public.admin_reset_event(text)            to service_role;
grant execute on function public.admin_purge_event_data(text, bigint) to service_role;
