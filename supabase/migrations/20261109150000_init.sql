-- onsitebeta: initial schema (events, members, op_secrets, roster, apps, conduct, extra, log)
-- Project ref: pptxgvkbgzasygdryxkw
-- The client (js/onsite-sb.js) is written against exactly these names.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------- tables
create table public.events (
  code        text primary key,
  title       text not null,
  org         text,
  event_date  text,
  reset_at    timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_at  timestamptz default now()
);

create table public.members (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  event_code    text not null references public.events(code) on delete cascade,
  login_id      text not null unique,
  kind          text not null check (kind in ('master','operator')),
  name          text not null,
  role          text check (role is null or role in ('접수','인솔','상주')),
  phone         text,
  must_change   boolean not null default true,
  disabled      boolean not null default false,
  last_login    timestamptz,
  pw_changed_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Temporary password, visible to masters until the operator's first password change.
create table public.op_secrets (
  user_id    uuid primary key references public.members(user_id) on delete cascade,
  event_code text not null,
  temp_pw    text not null,
  issued_at  timestamptz not null default now()
);

-- One timetable per event; the client upserts the whole row.
-- "Delete timetable" = update rows = '[]'.
create table public.roster (
  event_code text primary key references public.events(code) on delete cascade,
  v          bigint not null default 0,
  file       text,
  "at"       text,
  "by"       text,
  labels     jsonb not null default '{}'::jsonb,
  "rows"     jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- Per-applicant state. Tombstone = data '{}' (never hard-delete during normal ops:
-- realtime DELETE events are not RLS-filtered).
create table public.apps (
  event_code text not null references public.events(code) on delete cascade,
  no         text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (event_code, no)
);

-- data null = tombstone
create table public.conduct (
  event_code text not null references public.events(code) on delete cascade,
  id         text not null,
  data       jsonb,
  updated_at timestamptz not null default now(),
  primary key (event_code, id)
);

create table public.extra (
  event_code text not null references public.events(code) on delete cascade,
  id         text not null,
  data       jsonb,
  updated_at timestamptz not null default now(),
  primary key (event_code, id)
);

-- Append-only activity log.
create table public.log (
  id         bigint generated always as identity primary key,
  event_code text not null references public.events(code) on delete cascade,
  k          text not null,
  "at"       text,
  who        text,
  txt        text,
  actor      uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (event_code, k)
);

-- ---------------------------------------------------------------- indexes
create index apps_event_updated_idx    on public.apps    (event_code, updated_at);
create index conduct_event_updated_idx on public.conduct (event_code, updated_at);
create index extra_event_updated_idx   on public.extra   (event_code, updated_at);
create index members_event_updated_idx on public.members (event_code, updated_at);
create index log_event_id_idx          on public.log     (event_code, id);
create index op_secrets_event_idx      on public.op_secrets (event_code);

-- ---------------------------------------------------------------- updated_at trigger
create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function private.touch_updated_at() from public;

create trigger events_touch  before update on public.events  for each row execute function private.touch_updated_at();
create trigger members_touch before update on public.members for each row execute function private.touch_updated_at();
create trigger roster_touch  before update on public.roster  for each row execute function private.touch_updated_at();
create trigger apps_touch    before update on public.apps    for each row execute function private.touch_updated_at();
create trigger conduct_touch before update on public.conduct for each row execute function private.touch_updated_at();
create trigger extra_touch   before update on public.extra   for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------- private tables
create table private.bootstrap_tokens (
  token_sha256 text primary key,
  used_at      timestamptz,
  created_at   timestamptz default now()
);
revoke all on private.bootstrap_tokens from public, anon, authenticated;

-- ---------------------------------------------------------------- seed
insert into public.events (code, title, org, event_date) values
  ('KFI26', '2026년 한국소방산업기술원 채용 1차면접(실기) 전형', '한국소방산업기술원', '2026.11.11'),
  ('TEST',  '테스트 행사', '테스트', '2026.11.11')
on conflict (code) do nothing;
