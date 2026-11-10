-- onsitebeta: membership helpers, RLS policies, grants, RPC, realtime publication.

-- ---------------------------------------------------------------- helpers (private schema, not exposed)
-- Active member of event ev: has a members row, not disabled, password already changed.
create or replace function private.is_member(ev text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.members m
    where m.user_id = (select auth.uid())
      and m.event_code = ev
      and not m.disabled
      and not m.must_change
  );
$$;

-- Active master of event ev.
create or replace function private.is_master(ev text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.members m
    where m.user_id = (select auth.uid())
      and m.event_code = ev
      and m.kind = 'master'
      and not m.disabled
      and not m.must_change
  );
$$;

revoke all on function private.is_member(text) from public, anon;
revoke all on function private.is_master(text) from public, anon;
grant execute on function private.is_member(text) to authenticated, service_role;
grant execute on function private.is_master(text) to authenticated, service_role;

-- ---------------------------------------------------------------- RLS on
alter table public.events     enable row level security;
alter table public.members    enable row level security;
alter table public.op_secrets enable row level security;
alter table public.roster     enable row level security;
alter table public.apps       enable row level security;
alter table public.conduct    enable row level security;
alter table public.extra      enable row level security;
alter table public.log        enable row level security;

-- ---------------------------------------------------------------- grants: deny by default
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select                  on public.events     to authenticated;
grant select                  on public.members    to authenticated;
grant update (last_login)     on public.members    to authenticated;
grant select                  on public.op_secrets to authenticated;
grant select, insert, update  on public.roster     to authenticated;
grant select, insert, update  on public.apps       to authenticated;
grant select, insert, update  on public.conduct    to authenticated;
grant select, insert, update  on public.extra      to authenticated;
grant select, insert          on public.log        to authenticated;

-- ---------------------------------------------------------------- policies
-- events
create policy events_select on public.events
  for select to authenticated
  using ((select private.is_member(code)));

-- members: own row always (so a must_change / disabled user can see its state),
-- whole event for an active master. Clients may only touch last_login of their own row.
create policy members_select on public.members
  for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_master(event_code)));

create policy members_update_self on public.members
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- op_secrets: masters read; no client writes (edge function only)
create policy op_secrets_select on public.op_secrets
  for select to authenticated
  using ((select private.is_master(event_code)));

-- roster: members read, masters write
create policy roster_select on public.roster
  for select to authenticated
  using ((select private.is_member(event_code)));

create policy roster_insert on public.roster
  for insert to authenticated
  with check ((select private.is_master(event_code)));

create policy roster_update on public.roster
  for update to authenticated
  using ((select private.is_master(event_code)))
  with check ((select private.is_master(event_code)));

-- apps / conduct / extra: members read+write, no delete
create policy apps_select on public.apps
  for select to authenticated
  using ((select private.is_member(event_code)));
create policy apps_insert on public.apps
  for insert to authenticated
  with check ((select private.is_member(event_code)));
create policy apps_update on public.apps
  for update to authenticated
  using ((select private.is_member(event_code)))
  with check ((select private.is_member(event_code)));

create policy conduct_select on public.conduct
  for select to authenticated
  using ((select private.is_member(event_code)));
create policy conduct_insert on public.conduct
  for insert to authenticated
  with check ((select private.is_member(event_code)));
create policy conduct_update on public.conduct
  for update to authenticated
  using ((select private.is_member(event_code)))
  with check ((select private.is_member(event_code)));

create policy extra_select on public.extra
  for select to authenticated
  using ((select private.is_member(event_code)));
create policy extra_insert on public.extra
  for insert to authenticated
  with check ((select private.is_member(event_code)));
create policy extra_update on public.extra
  for update to authenticated
  using ((select private.is_member(event_code)))
  with check ((select private.is_member(event_code)));

-- log: append-only
create policy log_select on public.log
  for select to authenticated
  using ((select private.is_member(event_code)));
create policy log_insert on public.log
  for insert to authenticated
  with check ((select private.is_member(event_code)) and actor = (select auth.uid()));

-- ---------------------------------------------------------------- RPC: merge-patch one applicant
-- null in p_patch deletes that key. SECURITY INVOKER: RLS on apps applies.
create or replace function public.app_patch(p_ev text, p_no text, p_patch jsonb)
returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.apps as a (event_code, no, data, updated_at, updated_by)
  values (p_ev, p_no, jsonb_strip_nulls(coalesce(p_patch, '{}'::jsonb)), now(), auth.uid())
  on conflict (event_code, no) do update
    set data       = jsonb_strip_nulls(a.data || coalesce(p_patch, '{}'::jsonb)),
        updated_at = now(),
        updated_by = auth.uid();
$$;
revoke all on function public.app_patch(text, text, jsonb) from public, anon;
grant execute on function public.app_patch(text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------- realtime
alter publication supabase_realtime add table
  public.events, public.members, public.roster, public.apps, public.conduct, public.extra, public.log;
