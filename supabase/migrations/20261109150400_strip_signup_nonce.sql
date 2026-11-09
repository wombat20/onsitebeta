-- onsitebeta: GoTrue rewrites raw_user_meta_data in a later UPDATE of the same createUser
-- transaction (it adds "email_verified"), which re-introduced the already-consumed onsite_nonce
-- that private.block_signup() strips on INSERT. Strip it on UPDATE as well.
-- (The nonce is single-use and its ticket is deleted on INSERT, so a leftover value is harmless;
-- this only keeps user_metadata / JWT claims clean.)

create or replace function private.strip_signup_nonce()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.raw_user_meta_data := new.raw_user_meta_data - 'onsite_nonce';
  return new;
end;
$$;
revoke all on function private.strip_signup_nonce() from public, anon, authenticated;

create trigger onsite_strip_signup_nonce
  before update on auth.users
  for each row
  when (new.raw_user_meta_data ? 'onsite_nonce')
  execute function private.strip_signup_nonce();

-- clean users created before this trigger existed
update auth.users
   set raw_user_meta_data = raw_user_meta_data - 'onsite_nonce'
 where raw_user_meta_data ? 'onsite_nonce';
