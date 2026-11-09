-- onsitebeta: no self sign-up. Only the admin-ops edge function can create auth users.
--
-- Why not "raise unless raw_app_meta_data->>'onsite' <> ''" (the first design):
-- verified on this project (GoTrue, 2026-11-09) that admin.createUser INSERTs auth.users with
-- raw_app_meta_data = {"provider":"email","providers":["email"]} only; the custom app_metadata
-- (and email_confirmed_at) are written by a later UPDATE in the same transaction. A BEFORE INSERT
-- check on app_metadata would therefore block the edge function too.
--
-- Design used instead (one-time allow ticket):
--   1. admin-ops (service_role) calls public.admin_allow_signup(email, nonce)  -> private.signup_allow
--   2. admin-ops calls admin.createUser({... user_metadata: {name, onsite_nonce: nonce}})
--   3. this BEFORE INSERT trigger consumes the matching unexpired ticket (email + nonce) and strips
--      onsite_nonce from raw_user_meta_data; any insert without a valid ticket raises -> GoTrue
--      answers "Database error saving new user". Public /signup, anonymous sign-in, OAuth/SSO
--      first logins, Studio "Add user" and invites are all rejected.
-- The nonce is a 32-byte random value known only to the edge function, so even a racing public
-- sign-up for a predictable operator e-mail cannot use the ticket.

create table private.signup_allow (
  email      text primary key,
  nonce      text not null,
  expires_at timestamptz not null default (now() + interval '2 minutes')
);
revoke all on private.signup_allow from public, anon, authenticated;

create or replace function public.admin_allow_signup(p_email text, p_nonce text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.signup_allow (email, nonce, expires_at)
  values (lower(p_email), p_nonce, now() + interval '2 minutes')
  on conflict (email) do update
    set nonce = excluded.nonce, expires_at = excluded.expires_at;
$$;
revoke all on function public.admin_allow_signup(text, text) from public, anon, authenticated;
grant execute on function public.admin_allow_signup(text, text) to service_role;

create or replace function private.block_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_nonce text := new.raw_user_meta_data ->> 'onsite_nonce';
begin
  delete from private.signup_allow where expires_at < now() - interval '1 day';  -- housekeeping
  if v_nonce is null or v_nonce = '' or new.email is null then
    raise exception 'onsite: sign-up is disabled' using errcode = '42501';
  end if;
  delete from private.signup_allow
   where email = lower(new.email)
     and nonce = v_nonce
     and expires_at > now();
  if not found then
    raise exception 'onsite: sign-up is disabled' using errcode = '42501';
  end if;
  new.raw_user_meta_data := new.raw_user_meta_data - 'onsite_nonce';
  return new;
end;
$$;
revoke all on function private.block_signup() from public, anon, authenticated;

create trigger onsite_block_signup
  before insert on auth.users
  for each row execute function private.block_signup();
