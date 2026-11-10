-- onsitebeta: RLS / grant matrix test.
--
-- Run it as ONE query string (Supabase MCP execute_sql, the SQL editor, or `psql -1 -f`).
-- Everything runs in a single transaction that is ALWAYS rolled back: the last DO block raises an
-- exception that carries the report, e.g.
--     ERROR: RLS_MATRIX PASS 263/263 checks ... || <matrix>      (all assertions held)
--     ERROR: RLS_MATRIX FAIL 3/263 failed: ... || <matrix>        (lists every mismatch)
-- so nothing this script inserts (fixture events RLS_A / RLS_B, six fixture auth users, data rows)
-- ever persists. There is intentionally no explicit BEGIN/COMMIT: a multi-statement query string is
-- one implicit transaction and the closing exception rolls it back (BEGIN ... ROLLBACK semantics,
-- enforced by the server even if a statement in the middle fails).
--
-- Personas (impersonated with set_config('role', ...) + request.jwt.claims, exactly what PostgREST does):
--   master      active master of RLS_A
--   operator    active operator of RLS_A
--   must_change operator of RLS_A that has not changed the temporary password yet
--   disabled    operator of RLS_A with disabled = true
--   master_mc   master of RLS_A with must_change = true
--   other       active master of ANOTHER event (RLS_B)
--   anon        no user (publishable key only)
-- Outcome notation: a number = rows visible to SELECT; ok:N = statement succeeded affecting N rows;
-- denied = SQLSTATE 42501 (missing grant or RLS WITH CHECK violation).

-- ---------------------------------------------------------------- helpers (temp, rolled back)
create function pg_temp.rls_as(p_role text, p_uid uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_uid is null then json_build_object('role', p_role)::text
         else json_build_object('sub', p_uid, 'role', p_role)::text end, true);
  perform set_config('role', p_role, true);
end $$;

-- Runs q inside a sub-transaction that is always rolled back, returns the outcome.
create function pg_temp.rls_try(q text) returns text
language plpgsql as $$
declare
  n   bigint;
  res text;
begin
  begin
    if q ~* '^\s*select' then
      execute 'select count(*) from (' || q || ') s' into n;
      res := n::text;
    else
      execute q;
      get diagnostics n = row_count;
      res := 'ok:' || n;
    end if;
    raise exception using errcode = 'P0001', message = 'rls_rollback', detail = res;
  exception
    when insufficient_privilege then
      return 'denied';
    when raise_exception then
      if sqlerrm = 'rls_rollback' then
        get stacked diagnostics res = pg_exception_detail;
        return res;
      end if;
      return 'err:P0001 ' || sqlerrm;
    when others then
      return 'err:' || sqlstate || ' ' || sqlerrm;
  end;
end $$;

-- ---------------------------------------------------------------- fixtures (as postgres)
insert into public.events (code, title) values ('RLS_A', 'rls a'), ('RLS_B', 'rls b');

-- auth.users rows need a one-time ticket because of private.block_signup()
insert into private.signup_allow (email, nonce)
select 'rls-' || k || '@rls.onsitebeta.test', 'nonce-' || k
from unnest(array['m_a','o_a','mc_a','d_a','mmc_a','m_b']) k;

insert into auth.users (id, email, raw_user_meta_data, aud, role) values
  ('00000000-0000-4000-8000-0000000000a1', 'rls-m_a@rls.onsitebeta.test',   '{"onsite_nonce":"nonce-m_a"}',   'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000a2', 'rls-o_a@rls.onsitebeta.test',   '{"onsite_nonce":"nonce-o_a"}',   'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000a3', 'rls-mc_a@rls.onsitebeta.test',  '{"onsite_nonce":"nonce-mc_a"}',  'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000a4', 'rls-d_a@rls.onsitebeta.test',   '{"onsite_nonce":"nonce-d_a"}',   'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000a5', 'rls-mmc_a@rls.onsitebeta.test', '{"onsite_nonce":"nonce-mmc_a"}', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000b1', 'rls-m_b@rls.onsitebeta.test',   '{"onsite_nonce":"nonce-m_b"}',   'authenticated', 'authenticated');

insert into public.members (user_id, event_code, login_id, kind, name, role, must_change, disabled) values
  ('00000000-0000-4000-8000-0000000000a1', 'RLS_A', 'rls-m_a',   'master',   'm_a',   null,  false, false),
  ('00000000-0000-4000-8000-0000000000a2', 'RLS_A', 'RLS_A-S01', 'operator', 'o_a',   '접수', false, false),
  ('00000000-0000-4000-8000-0000000000a3', 'RLS_A', 'RLS_A-S02', 'operator', 'mc_a',  '인솔', true,  false),
  ('00000000-0000-4000-8000-0000000000a4', 'RLS_A', 'RLS_A-S03', 'operator', 'd_a',   '상주', false, true),
  ('00000000-0000-4000-8000-0000000000a5', 'RLS_A', 'rls-mmc_a', 'master',   'mmc_a', null,  true,  false),
  ('00000000-0000-4000-8000-0000000000b1', 'RLS_B', 'rls-m_b',   'master',   'm_b',   null,  false, false);

insert into public.op_secrets (user_id, event_code, temp_pw) values
  ('00000000-0000-4000-8000-0000000000a3', 'RLS_A', 'abcd-2345');
insert into public.roster (event_code, v, "rows") values ('RLS_A', 1, '[{"no":"A1"}]'), ('RLS_B', 1, '[]');
insert into public.apps (event_code, no, data) values ('RLS_A', 'A1', '{"s":1}'), ('RLS_A', 'A2', '{"s":2}'), ('RLS_B', 'B1', '{"s":1}');
insert into public.conduct (event_code, id, data) values ('RLS_A', 'c1', '{"v":1}'), ('RLS_B', 'c1', '{"v":1}');
insert into public.extra   (event_code, id, data) values ('RLS_A', 'x1', '{"v":1}'), ('RLS_B', 'x1', '{"v":1}');
insert into public.log (event_code, k, txt, actor) values
  ('RLS_A', 'k1', 'one', '00000000-0000-4000-8000-0000000000a1'),
  ('RLS_A', 'k2', 'two', '00000000-0000-4000-8000-0000000000a1'),
  ('RLS_B', 'k1', 'one', '00000000-0000-4000-8000-0000000000b1');

-- ---------------------------------------------------------------- matrix + report
do $matrix$
declare
  personas jsonb := '[
    {"p":"master",      "role":"authenticated", "uid":"00000000-0000-4000-8000-0000000000a1"},
    {"p":"operator",    "role":"authenticated", "uid":"00000000-0000-4000-8000-0000000000a2"},
    {"p":"must_change", "role":"authenticated", "uid":"00000000-0000-4000-8000-0000000000a3"},
    {"p":"disabled",    "role":"authenticated", "uid":"00000000-0000-4000-8000-0000000000a4"},
    {"p":"master_mc",   "role":"authenticated", "uid":"00000000-0000-4000-8000-0000000000a5"},
    {"p":"other",       "role":"authenticated", "uid":"00000000-0000-4000-8000-0000000000b1"},
    {"p":"anon",        "role":"anon",          "uid":null}
  ]';
  tables text[] := array['events','members','op_secrets','roster','apps','conduct','extra','log'];
  ops    text[] := array['select','insert','update','delete'];
  -- expected[persona][table] = [select, insert, update, delete]
  locked jsonb := '{"events":["0","denied","denied","denied"],"members":["1","denied","ok:1","denied"],
                    "op_secrets":["0","denied","denied","denied"],"roster":["0","denied","ok:0","denied"],
                    "apps":["0","denied","ok:0","denied"],"conduct":["0","denied","ok:0","denied"],
                    "extra":["0","denied","ok:0","denied"],"log":["0","denied","denied","denied"]}';
  expected jsonb;
  stmt jsonb := '{
    "events":     ["select 1 from public.events where code = ''RLS_A''",
                   "insert into public.events (code, title) values (''RLS_X_%P%'', ''x'')",
                   "update public.events set title = title where code = ''RLS_A''",
                   "delete from public.events where code = ''RLS_A''"],
    "members":    ["select 1 from public.members where event_code = ''RLS_A''",
                   "insert into public.members (user_id, event_code, login_id, kind, name) values (gen_random_uuid(), ''RLS_A'', ''x-%P%'', ''operator'', ''x'')",
                   "update public.members set last_login = now() where event_code = ''RLS_A''",
                   "delete from public.members where event_code = ''RLS_A''"],
    "op_secrets": ["select 1 from public.op_secrets where event_code = ''RLS_A''",
                   "insert into public.op_secrets (user_id, event_code, temp_pw) values (''00000000-0000-4000-8000-0000000000a2'', ''RLS_A'', ''x'')",
                   "update public.op_secrets set temp_pw = temp_pw where event_code = ''RLS_A''",
                   "delete from public.op_secrets where event_code = ''RLS_A''"],
    "roster":     ["select 1 from public.roster where event_code = ''RLS_A''",
                   "insert into public.roster (event_code, v) values (''RLS_A'', 99) on conflict (event_code) do update set v = excluded.v",
                   "update public.roster set v = v + 1 where event_code = ''RLS_A''",
                   "delete from public.roster where event_code = ''RLS_A''"],
    "apps":       ["select 1 from public.apps where event_code = ''RLS_A''",
                   "insert into public.apps (event_code, no, data) values (''RLS_A'', ''N-%P%'', ''{}'')",
                   "update public.apps set data = data where event_code = ''RLS_A''",
                   "delete from public.apps where event_code = ''RLS_A''"],
    "conduct":    ["select 1 from public.conduct where event_code = ''RLS_A''",
                   "insert into public.conduct (event_code, id, data) values (''RLS_A'', ''N-%P%'', ''{}'')",
                   "update public.conduct set data = data where event_code = ''RLS_A''",
                   "delete from public.conduct where event_code = ''RLS_A''"],
    "extra":      ["select 1 from public.extra where event_code = ''RLS_A''",
                   "insert into public.extra (event_code, id, data) values (''RLS_A'', ''N-%P%'', ''{}'')",
                   "update public.extra set data = data where event_code = ''RLS_A''",
                   "delete from public.extra where event_code = ''RLS_A''"],
    "log":        ["select 1 from public.log where event_code = ''RLS_A''",
                   "insert into public.log (event_code, k, txt) values (''RLS_A'', ''N-%P%'', ''x'')",
                   "update public.log set txt = txt where event_code = ''RLS_A''",
                   "delete from public.log where event_code = ''RLS_A''"]
  }';
  -- extra targeted checks: [persona, label, sql, expected]
  extras jsonb := '[
    ["master",      "app_patch rpc",                "select public.app_patch(''RLS_A'', ''A1'', ''{\"z\":1}'')", "1"],
    ["operator",    "app_patch rpc",                "select public.app_patch(''RLS_A'', ''A1'', ''{\"z\":1}'')", "1"],
    ["must_change", "app_patch rpc",                "select public.app_patch(''RLS_A'', ''A1'', ''{\"z\":1}'')", "denied"],
    ["disabled",    "app_patch rpc",                "select public.app_patch(''RLS_A'', ''A1'', ''{\"z\":1}'')", "denied"],
    ["other",       "app_patch rpc",                "select public.app_patch(''RLS_A'', ''A1'', ''{\"z\":1}'')", "denied"],
    ["anon",        "app_patch rpc",                "select public.app_patch(''RLS_A'', ''A1'', ''{\"z\":1}'')", "denied"],
    ["master",      "assign_device rpc",            "select public.assign_device(''RLS_A'', ''A1'')", "1"],
    ["operator",    "assign_device rpc",            "select public.assign_device(''RLS_A'', ''A1'')", "1"],
    ["must_change", "assign_device rpc",            "select public.assign_device(''RLS_A'', ''A1'')", "denied"],
    ["disabled",    "assign_device rpc",            "select public.assign_device(''RLS_A'', ''A1'')", "denied"],
    ["other",       "assign_device rpc",            "select public.assign_device(''RLS_A'', ''A1'')", "denied"],
    ["anon",        "assign_device rpc",            "select public.assign_device(''RLS_A'', ''A1'')", "denied"],
    ["operator",    "log actor spoof",              "insert into public.log (event_code, k, txt, actor) values (''RLS_A'', ''spoof'', ''x'', ''00000000-0000-4000-8000-0000000000a1'')", "denied"],
    ["master",      "log actor spoof",              "insert into public.log (event_code, k, txt, actor) values (''RLS_A'', ''spoof'', ''x'', ''00000000-0000-4000-8000-0000000000a2'')", "denied"],
    ["master",      "members.must_change self-edit","update public.members set must_change = false where user_id = auth.uid()", "denied"],
    ["must_change", "members.must_change self-edit","update public.members set must_change = false where user_id = auth.uid()", "denied"],
    ["disabled",    "members.disabled self-edit",   "update public.members set disabled = false where user_id = auth.uid()", "denied"],
    ["operator",    "members.role self-edit",       "update public.members set role = ''상주'' where user_id = auth.uid()", "denied"],
    ["operator",    "members other row last_login", "update public.members set last_login = now() where user_id = ''00000000-0000-4000-8000-0000000000a1''", "ok:0"],
    ["master",      "sync_pull secrets",            "select 1 from jsonb_array_elements(public.sync_pull(''RLS_A'', ''2000-01-01'', 0) -> ''secrets'')", "1"],
    ["operator",    "sync_pull secrets",            "select 1 from jsonb_array_elements(public.sync_pull(''RLS_A'', ''2000-01-01'', 0) -> ''secrets'')", "0"],
    ["operator",    "sync_pull apps",               "select 1 from jsonb_array_elements(public.sync_pull(''RLS_A'', ''2000-01-01'', 0) -> ''apps'')", "2"],
    ["must_change", "sync_pull apps",               "select 1 from jsonb_array_elements(public.sync_pull(''RLS_A'', ''2000-01-01'', 0) -> ''apps'')", "0"],
    ["must_change", "sync_pull members (own row)",  "select 1 from jsonb_array_elements(public.sync_pull(''RLS_A'', ''2000-01-01'', 0) -> ''members'')", "1"],
    ["other",       "sync_pull apps of RLS_A",      "select 1 from jsonb_array_elements(public.sync_pull(''RLS_A'', ''2000-01-01'', 0) -> ''apps'')", "0"],
    ["anon",        "sync_pull",                    "select 1 from jsonb_array_elements(public.sync_pull(''RLS_A'', ''2000-01-01'', 0) -> ''apps'')", "denied"],
    ["other",       "own event apps (RLS_B)",       "select 1 from public.apps where event_code = ''RLS_B''", "1"],
    ["other",       "own event roster write",       "update public.roster set v = v + 1 where event_code = ''RLS_B''", "ok:1"],
    ["master",      "other event apps (RLS_B)",     "select 1 from public.apps where event_code = ''RLS_B''", "0"],
    ["master",      "other event members (RLS_B)",  "select 1 from public.members where event_code = ''RLS_B''", "0"],
    ["master",      "insert apps into RLS_B",       "insert into public.apps (event_code, no, data) values (''RLS_B'', ''X'', ''{}'')", "denied"],
    ["anon",        "private.is_member",            "select 1 where private.is_member(''RLS_A'')", "denied"],
    ["operator",    "private.is_master (own=false)","select 1 where private.is_master(''RLS_A'')", "0"],
    ["operator",    "private.is_member (own=true)", "select 1 where private.is_member(''RLS_A'')", "1"],
    ["master",      "admin_kill_sessions rpc",      "select public.admin_kill_sessions(''00000000-0000-4000-8000-0000000000a2'')", "denied"],
    ["master",      "admin_reset_event rpc",        "select public.admin_reset_event(''RLS_A'')", "denied"],
    ["master",      "admin_purge_event_data rpc",   "select public.admin_purge_event_data(''RLS_A'', 1)", "denied"],
    ["master",      "admin_allow_signup rpc",       "select public.admin_allow_signup(''x@y.z'', ''n'')", "denied"],
    ["master",      "admin_use_bootstrap_token rpc","select public.admin_use_bootstrap_token(''00'')", "denied"],
    ["anon",        "admin_kill_sessions rpc",      "select public.admin_kill_sessions(''00000000-0000-4000-8000-0000000000a2'')", "denied"],
    ["master",      "private.bootstrap_tokens read","select 1 from private.bootstrap_tokens", "denied"],
    ["master",      "private.signup_allow write",   "insert into private.signup_allow (email, nonce) values (''a@b.c'', ''n'')", "denied"],
    ["postgres",    "auth.users insert w/o ticket", "insert into auth.users (id, email, aud, role) values (gen_random_uuid(), ''intruder@rls.onsitebeta.test'', ''authenticated'', ''authenticated'')", "denied"],
    ["postgres",    "auth.users insert bad nonce",  "insert into auth.users (id, email, raw_user_meta_data) select gen_random_uuid(), ''ticket@rls.onsitebeta.test'', ''{\"onsite_nonce\":\"wrong\"}'' from (select public.admin_allow_signup(''ticket@rls.onsitebeta.test'', ''right'')) t", "denied"],
    ["postgres",    "auth.users insert with ticket","insert into auth.users (id, email, raw_user_meta_data) select gen_random_uuid(), ''ticket@rls.onsitebeta.test'', ''{\"onsite_nonce\":\"right\"}'' from (select public.admin_allow_signup(''ticket@rls.onsitebeta.test'', ''right'')) t", "ok:1"]
  ]';
  per jsonb;
  t text;
  i int;
  q text;
  got text;
  want text;
  total int := 0;
  failures text[] := '{}';
  matrix text := '';
  line text;
  e jsonb;
begin
  for per in select * from jsonb_array_elements(personas) loop
    expected := case per->>'p'
      when 'master' then '{"events":["1","denied","denied","denied"],"members":["5","denied","ok:1","denied"],
                           "op_secrets":["1","denied","denied","denied"],"roster":["1","ok:1","ok:1","denied"],
                           "apps":["2","ok:1","ok:2","denied"],"conduct":["1","ok:1","ok:1","denied"],
                           "extra":["1","ok:1","ok:1","denied"],"log":["2","ok:1","denied","denied"]}'::jsonb
      when 'operator' then '{"events":["1","denied","denied","denied"],"members":["1","denied","ok:1","denied"],
                           "op_secrets":["0","denied","denied","denied"],"roster":["1","denied","ok:0","denied"],
                           "apps":["2","ok:1","ok:2","denied"],"conduct":["1","ok:1","ok:1","denied"],
                           "extra":["1","ok:1","ok:1","denied"],"log":["2","ok:1","denied","denied"]}'::jsonb
      when 'other' then '{"events":["0","denied","denied","denied"],"members":["0","denied","ok:0","denied"],
                           "op_secrets":["0","denied","denied","denied"],"roster":["0","denied","ok:0","denied"],
                           "apps":["0","denied","ok:0","denied"],"conduct":["0","denied","ok:0","denied"],
                           "extra":["0","denied","ok:0","denied"],"log":["0","denied","denied","denied"]}'::jsonb
      when 'anon' then '{"events":["denied","denied","denied","denied"],"members":["denied","denied","denied","denied"],
                           "op_secrets":["denied","denied","denied","denied"],"roster":["denied","denied","denied","denied"],
                           "apps":["denied","denied","denied","denied"],"conduct":["denied","denied","denied","denied"],
                           "extra":["denied","denied","denied","denied"],"log":["denied","denied","denied","denied"]}'::jsonb
      else locked  -- must_change, disabled, master_mc
    end;
    line := per->>'p' || ':';
    foreach t in array tables loop
      line := line || ' ' || t || '=';
      for i in 1..4 loop
        q := replace(stmt->t->>(i-1), '%P%', per->>'p');
        perform pg_temp.rls_as(per->>'role', (per->>'uid')::uuid);
        got := pg_temp.rls_try(q);
        perform set_config('role', 'none', true);
        want := expected->t->>(i-1);
        total := total + 1;
        line := line || got || case when i < 4 then '/' else '' end;
        if got is distinct from want then
          failures := failures || format('%s %s %s: expected %s got %s', per->>'p', t, ops[i], want, got);
        end if;
      end loop;
    end loop;
    matrix := matrix || line || E'\n';
  end loop;

  for e in select * from jsonb_array_elements(extras) loop
    if e->>0 = 'postgres' then
      perform set_config('role', 'none', true);
    else
      select pg_temp.rls_as(p->>'role', (p->>'uid')::uuid) into got
        from jsonb_array_elements(personas) p where p->>'p' = e->>0;
    end if;
    got := pg_temp.rls_try(e->>2);
    perform set_config('role', 'none', true);
    total := total + 1;
    if got is distinct from (e->>3) then
      failures := failures || format('%s [%s]: expected %s got %s', e->>0, e->>1, e->>3, got);
    end if;
  end loop;

  -- the matrix goes into the message itself (some clients drop DETAIL)
  if array_length(failures, 1) is null then
    raise exception 'RLS_MATRIX PASS %/% checks (select/insert/update/delete per table; all rolled back) || %', total, total, matrix;
  else
    raise exception 'RLS_MATRIX FAIL %/% failed: % || %', array_length(failures, 1), total, array_to_string(failures, ' | '), matrix;
  end if;
end
$matrix$;
