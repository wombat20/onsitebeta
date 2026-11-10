-- 변경분을 한 번에 받아오는 함수 (클라이언트 폴링과 Realtime 변경 신호가 같은 경로를 써요)
-- SECURITY INVOKER: 호출한 사용자의 RLS가 그대로 적용돼요
--   · 멤버가 아니면(비활성·첫 비밀번호 변경 전 포함) 본인 members 행 말고는 아무것도 받지 못해요
--   · op_secrets(임시 비밀번호)는 마스터에게만 보여요
-- p_since     : 이 시각 이후 바뀐 apps/conduct/extra 만 돌려줘요 (클라이언트가 15초 겹쳐서 요청)
-- p_log_after : 이 id 이후의 활동 로그 (null 이면 로그를 보내지 않음 · 운영자 화면)
create or replace function public.sync_pull(p_ev text, p_since timestamptz, p_log_after bigint default null)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'now', now(),
    'event', (select jsonb_build_object('reset_at', e.reset_at) from public.events e where e.code = p_ev),
    'roster', (select jsonb_build_object('v', r.v, 'updated_at', r.updated_at) from public.roster r where r.event_code = p_ev),
    'apps', coalesce((select jsonb_agg(jsonb_build_object('no', a.no, 'data', a.data))
                        from public.apps a where a.event_code = p_ev and a.updated_at >= p_since), '[]'::jsonb),
    'conduct', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'data', c.data))
                        from public.conduct c where c.event_code = p_ev and c.updated_at >= p_since), '[]'::jsonb),
    'extra', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'data', x.data))
                        from public.extra x where x.event_code = p_ev and x.updated_at >= p_since), '[]'::jsonb),
    'members', coalesce((select jsonb_agg(to_jsonb(m)) from public.members m where m.event_code = p_ev), '[]'::jsonb),
    'secrets', coalesce((select jsonb_agg(jsonb_build_object('user_id', s.user_id, 'temp_pw', s.temp_pw))
                        from public.op_secrets s where s.event_code = p_ev), '[]'::jsonb),
    'log', case when p_log_after is null then '[]'::jsonb
                else coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'k', l.k, 'at', l.at, 'who', l.who, 'txt', l.txt) order by l.id)
                                 from public.log l where l.event_code = p_ev and l.id > p_log_after), '[]'::jsonb) end
  );
$$;

revoke all on function public.sync_pull(text, timestamptz, bigint) from public, anon;
grant execute on function public.sync_pull(text, timestamptz, bigint) to authenticated;
