-- 독립 검토에서 확인된 문제 수정
-- 1) app_patch: 칸별 "나중에 고친 것이 이김"(클라이언트 수정 시각 p_ts) → 오프라인이었던 기기가 늦게 접속해도
--    그 사이 다른 기기에서 고친 최신 값을 덮어쓰지 않아요. 시각은 data._ts 에 칸별로 보관해요.
--    p_ts 가 없으면(예전 클라이언트) 이전처럼 그대로 병합해요.
-- 2) assign_device: 전자기기 보관번호를 서버에서 하나씩 배정 (접수 담당 여럿이 동시에 눌러도 번호가 겹치지 않음)
-- 3) 활동 로그 작성자(who)는 서버가 로그인한 계정 이름으로 기록 (다른 사람 이름으로 남길 수 없음)

-- ---------------------------------------------------------------- 1) app_patch with per-field LWW
drop function if exists public.app_patch(text, text, jsonb);

create or replace function public.app_patch(p_ev text, p_no text, p_patch jsonb, p_ts jsonb default null)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cur   jsonb;
  ts    jsonb;
  newts jsonb;
  keep  jsonb := '{}'::jsonb;
  k     text;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    return;
  end if;
  select a.data into cur from public.apps a where a.event_code = p_ev and a.no = p_no for update;
  cur   := coalesce(cur, '{}'::jsonb);
  ts    := case when jsonb_typeof(cur->'_ts') = 'object' then cur->'_ts' else '{}'::jsonb end;
  newts := ts;
  for k in select jsonb_object_keys(p_patch) loop
    continue when k = '_ts';
    if p_ts is null or jsonb_typeof(p_ts->k) <> 'number'
       or coalesce((ts->>k)::numeric, 0) <= (p_ts->>k)::numeric then
      keep := keep || jsonb_build_object(k, p_patch->k);
      if p_ts is not null and jsonb_typeof(p_ts->k) = 'number' then
        newts := newts || jsonb_build_object(k, p_ts->k);
      end if;
    end if;
  end loop;
  if keep = '{}'::jsonb then
    return;
  end if;
  insert into public.apps as a (event_code, no, data, updated_at, updated_by)
  values (p_ev, p_no,
          jsonb_strip_nulls(keep) || case when newts = '{}'::jsonb then '{}'::jsonb else jsonb_build_object('_ts', newts) end,
          now(), auth.uid())
  on conflict (event_code, no) do update
    set data       = jsonb_strip_nulls(a.data || keep)
                     || case when newts = '{}'::jsonb then '{}'::jsonb else jsonb_build_object('_ts', newts) end,
        updated_at = now(),
        updated_by = auth.uid();
end;
$$;
revoke all on function public.app_patch(text, text, jsonb, jsonb) from public, anon;
grant execute on function public.app_patch(text, text, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------- 2) assign_device
create or replace function public.assign_device(p_ev text, p_no text)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cur text;
  nxt int;
begin
  -- 같은 행사 안에서는 한 번에 한 명씩 배정 (트랜잭션 동안만 잠금)
  perform pg_advisory_xact_lock(hashtextextended('onsite-device:' || p_ev, 0));
  select a.data->>'device' into cur from public.apps a where a.event_code = p_ev and a.no = p_no;
  if cur is not null and cur <> '' then
    return cur;              -- 이미 번호가 있으면 그대로
  end if;
  select coalesce(max((a.data->>'device')::int), 0) + 1 into nxt
    from public.apps a
   where a.event_code = p_ev and (a.data->>'device') ~ '^[0-9]{1,6}$';
  perform public.app_patch(p_ev, p_no, jsonb_build_object('device', nxt::text),
                           jsonb_build_object('device', floor(extract(epoch from clock_timestamp()) * 1000)));
  return nxt::text;
end;
$$;
revoke all on function public.assign_device(text, text) from public, anon;
grant execute on function public.assign_device(text, text) to authenticated;

-- ---------------------------------------------------------------- 3) server-stamped log author
create or replace function private.log_stamp_who()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  m record;
begin
  if new.actor is not null then
    select mm.name, mm.kind into m from public.members mm where mm.user_id = new.actor;
    if found then
      new.who := m.name || ' · ' || case when m.kind = 'master' then '마스터' else '운영관리자' end;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.log_stamp_who() from public, anon, authenticated;

drop trigger if exists log_stamp_who on public.log;
create trigger log_stamp_who
  before insert on public.log
  for each row execute function private.log_stamp_who();
