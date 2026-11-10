# onsitebeta — Supabase backend

Project ref `pptxgvkbgzasygdryxkw` (ap-northeast-2) · URL `https://pptxgvkbgzasygdryxkw.supabase.co`
Publishable key (public, safe in the client): `sb_publishable_hJz2LkwR9sicQPe7J3v89Q_Nxxixoif`

No secret, service key, password or token is stored in this repository. Account passwords created
during setup live only outside the repo (see "Accounts in place").

| Path | What |
|---|---|
| `migrations/20261109150000_init.sql` | schema `private`, all tables, indexes, `updated_at` triggers, `private.bootstrap_tokens`, seed events |
| `migrations/20261109150100_rls.sql` | `private.is_member/is_master`, RLS + grants, `public.app_patch`, realtime publication |
| `migrations/20261109150200_admin_rpc.sql` | service-role-only RPCs used by admin-ops (`admin_kill_sessions`, `admin_use_bootstrap_token`, `admin_reset_event`, `admin_purge_event_data`) |
| `migrations/20261109150300_block_signup.sql` | no self sign-up: one-time ticket + `BEFORE INSERT` trigger on `auth.users` |
| `migrations/20261109150400_strip_signup_nonce.sql` | keeps the consumed ticket nonce out of `user_metadata` |
| `migrations/20261109235900_sync_pull.sql` | `public.sync_pull` (written by the client author; applied with the others) |
| `migrations/20261110010000_review_fixes.sql` | `app_patch` per-field last-write-wins (`p_ts`), `assign_device` (atomic locker numbers), server-stamped log author trigger |
| `functions/admin-ops/index.ts` | edge function for account / event administration (deployed with `verify_jwt=false`, authorizes in code; redeploy with `supabase functions deploy admin-ops --no-verify-jwt` or MCP `deploy_edge_function` with `verify_jwt:false`, otherwise `bootstrap` stops working) |
| `tests/rls_matrix.sql` | role-impersonation matrix (269 checks), always rolled back |
| `tests/api_e2e.mjs` | end-to-end test through the real HTTP API (74 checks; destructive for event `TEST` only) |

All migrations are applied to the project with `apply_migration` under the same names.

---

## Data model (schema `public`)

| Table | Key | Columns | Notes |
|---|---|---|---|
| `events` | `code` | `title`, `org`, `event_date` (text `2026.11.11`), `reset_at`, `updated_at`, `created_at` | seed: `KFI26`, `TEST` |
| `members` | `user_id` → `auth.users` (cascade) | `event_code` → events, `login_id` (unique), `kind` (`master`/`operator`), `name`, `role` (`접수`/`인솔`/`상주`/null), `phone`, `must_change` (default true), `disabled`, `last_login`, `pw_changed_at`, `created_at`, `updated_at` | `login_id` = `KFI26-S01` for operators, lower-case e-mail for masters |
| `op_secrets` | `user_id` → members (cascade) | `event_code`, `temp_pw`, `issued_at` | temporary password, visible to masters until the account's first password change |
| `roster` | `event_code` → events | `v` (bigint), `file`, `at`, `by`, `labels` jsonb `{}`, `rows` jsonb `[]`, `updated_at` | client upserts the whole row; "delete timetable" = `rows='[]'` |
| `apps` | (`event_code`, `no`) | `data` jsonb `{}`, `updated_at`, `updated_by` (default `auth.uid()`) | tombstone = `data='{}'` — never hard-deleted in normal ops |
| `conduct`, `extra` | (`event_code`, `id`) | `data` jsonb (null = tombstone), `updated_at` | |
| `log` | `id` identity | `event_code`, `k` (unique per event), `at`, `who`, `txt`, `actor` (default `auth.uid()`), `created_at` | append-only |

`updated_at` is set by a `BEFORE UPDATE` trigger on events, members, roster, apps, conduct, extra.
Indexes: `(event_code, updated_at)` on apps/conduct/extra/members, `(event_code, id)` on log, `(event_code)` on op_secrets.

Schema `private` (not exposed by the Data API; `usage` granted to `authenticated` so policies can call the helpers):
`is_member(ev)`, `is_master(ev)` (SECURITY DEFINER, `search_path=''`, STABLE), `bootstrap_tokens`, `signup_allow`,
trigger functions `touch_updated_at`, `block_signup`, `strip_signup_nonce`.

**Active member** of event `ev` = has a `members` row for `ev`, `disabled = false` and `must_change = false`.
**Active master** = active member with `kind = 'master'`.

## RLS / grants

RLS is on for every public table. `anon` and `authenticated` lose every table/sequence privilege; only these are granted to `authenticated`:

| Table | Grants | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|---|
| events | select | active member | – | – | – |
| members | select, update(`last_login`) | own row always; whole event for active master | – | own row, `last_login` column only | – |
| op_secrets | select | active master | – (edge function only) | – | – |
| roster | select, insert, update | active member | active master | active master | – |
| apps / conduct / extra | select, insert, update | active member | active member | active member | – (tombstones) |
| log | select, insert | active member | active member and `actor = auth.uid()` | – | – |

Consequences (all verified by the tests):
- An operator who has not changed the temporary password, or is disabled, sees **zero rows** everywhere except its own `members` row — immediately, even with an access token issued before (RLS reads `members` on every request).
- Members of another event see nothing of this event.
- Nobody can update/delete `log`, nobody can delete anything through the API, nobody can change `must_change`/`disabled`/`role` of a member except through admin-ops.

RPCs (schema `public`):

| Function | Security | Who | What |
|---|---|---|---|
| `app_patch(p_ev, p_no, p_patch jsonb, p_ts jsonb default null)` | INVOKER (RLS applies) | authenticated | upsert apps with per-field last-write-wins: a field is applied only if its `p_ts` time is newer than the stored `data._ts` time for that field; a `null` value deletes the key (merge is shallow, nested objects are replaced) |
| `sync_pull(p_ev, p_since, p_log_after)` | INVOKER | authenticated | one-shot delta pull used by the client |
| `admin_kill_sessions(uid)` | DEFINER | service_role only | `delete from auth.sessions where user_id = uid` |
| `admin_use_bootstrap_token(sha256)` | DEFINER | service_role only | atomically marks an unused token used, returns true/false |
| `admin_allow_signup(email, nonce)` | DEFINER | service_role only | one-time sign-up ticket (2 min) |
| `admin_reset_event(ev)` / `admin_purge_event_data(ev, v)` | DEFINER | service_role only | data part of reset_event / purge_event, one transaction each |

Realtime: `supabase_realtime` publishes events, members, roster, apps, conduct, extra, log (**not** op_secrets).
Postgres-changes INSERT/UPDATE events are filtered by RLS; DELETE events are not (they only carry the primary key),
which is why normal operations use tombstones instead of deletes.

## No self sign-up (deviation from the first design, verified)

The first design was a `BEFORE INSERT` trigger on `auth.users` requiring `raw_app_meta_data->>'onsite'`.
Verified on this project (temporary capture trigger, 2026-11-09): `admin.createUser` INSERTs the row with
`raw_app_meta_data = {"provider":"email","providers":["email"]}` only; the custom `app_metadata` and
`email_confirmed_at` are written by a later UPDATE in the same transaction. That trigger would have blocked the
edge function itself.

Implemented instead (`20261109150300_block_signup.sql`):
1. admin-ops calls `admin_allow_signup(email, nonce)` (service role only) with a fresh 32-char random nonce;
2. then `admin.createUser({..., user_metadata: {name, onsite_nonce: nonce}})`;
3. trigger `onsite_block_signup` (`BEFORE INSERT ON auth.users`) consumes the matching unexpired ticket and strips the
   nonce; any insert without a valid (email, nonce) ticket raises `42501` → GoTrue answers
   `500 Database error saving new user`.

So public `/auth/v1/signup`, anonymous sign-in, OAuth/SSO first logins, invites and the Studio "Add user" button are
all rejected. Because the nonce is unknown outside the edge function, even a racing public sign-up for a predictable
operator address cannot use a ticket. (GoTrue rewrites `raw_user_meta_data` later in the same transaction, so a second
trigger, `onsite_strip_signup_nonce`, removes the consumed nonce on UPDATE as well.)
To add accounts, use admin-ops (`create_op`, or `bootstrap` for masters — see below).

---

## admin-ops edge function

`POST https://pptxgvkbgzasygdryxkw.supabase.co/functions/v1/admin-ops`
Headers: `apikey: <publishable key>`, `Content-Type: application/json`, `Authorization: Bearer <user access token>`
(supabase-js `functions.invoke('admin-ops', {body})` sends all of these when signed in).
CORS: origins `https://wombat20.github.io`, `http://localhost:<port>`, `http://127.0.0.1:<port>` are echoed;
methods `POST, OPTIONS`; headers `authorization, x-client-info, apikey, content-type`.

Responses: HTTP 200 with `{ok:true, ...}` or `{ok:false, error:'<code>', message:'<한국어 안내>'}`.
HTTP 401 `{ok:false, error:'unauthorized', message}` when the bearer token is missing, not a JWT, invalid, expired, or its
session was revoked (e.g. after `reset_op`/`set_disabled`). `bootstrap` needs no bearer.

Every target must belong to the caller's `event_code`. `id` may be the `login_id` (case-insensitive) or the `user_id` uuid.

| action | body | who | result |
|---|---|---|---|
| `create_op` | `{name, role, phone?}` | active master | `{ok, id:'KFI26-S03', temp:'aB3d-x9Kq', user_id}` — id = event + `-S` + 2-digit next number; must_change=true; temp stored in op_secrets |
| `reset_op` | `{id}` | active master; target operator or another master (not self) | `{ok, id, temp}` — new temp password, unban, `must_change=true`, `disabled=false`, all sessions revoked |
| `set_disabled` | `{id, disabled:true\|false}` | active master; not self | `{ok, id, disabled}` — `disabled` + ban `876000h` + sessions revoked / unban |
| `delete_op` | `{id}` | active master; operators only | `{ok, id}` — deletes the auth user (members/op_secrets cascade) |
| `set_role` | `{id, role?, name?, phone?}` | active master; operators only | `{ok, id}` |
| `change_password` | `{old_password, new_password}` | any non-disabled member (must_change allowed) | `{ok}` — see below |
| `reset_event` | `{}` | active master | `{ok}` — apps `data='{}'` (+`updated_by=null`), conduct/extra `data=null`, log deleted, `events.reset_at=now()`; roster and accounts kept |
| `purge_event` | `{}` | active master | `{ok, deleted_operators:n}` — apps/conduct/extra/log rows deleted, roster `rows='[]', labels='{}', file/at/by=null, v=<epoch ms>`, every operator auth user of the event deleted, `reset_at=now()`; masters kept |
| `bootstrap` | `{token, event_code, masters:[{email,name,password,must_change}]}` | no bearer; one-time token | `{ok, created:[{email,login_id,user_id,must_change}], failed:[...]}` — never echoes passwords |

`change_password`: rules checked first (`8자 이상 입력해 주세요` · `영문과 숫자를 함께 넣어 주세요` · `이전 비밀번호와 다르게 정해 주세요`),
then the current password is verified with a publishable-key `signInWithPassword` (`현재 비밀번호가 맞지 않아요`); the
verification session is signed out; the password is then changed through **the caller's own session**
(`PUT /auth/v1/user` with the caller's token), so GoTrue keeps the caller's current session and revokes the user's other
sessions; finally `must_change=false`, `pw_changed_at=now()`, op_secrets row deleted.
(Implementation note: `admin.updateUserById({password})` revokes *all* sessions of the user in GoTrue, which would log the
caller out — that is why it is not used here. It is used in `reset_op`, where revoking everything is the point.)

Error codes: `unauthorized`(401) · `bad_request` · `bad_action` · `not_member` · `disabled` · `must_change` · `forbidden` ·
`not_found` · `self` · `not_operator` · `bad_name` · `bad_role` · `pw_short` · `pw_weak` · `pw_same` · `pw_wrong` ·
`pw_policy` · `rate_limited` · `bad_token` · `no_event` · `exists` · `partial` (bootstrap) · `server`.

Examples:
```
→ {"action":"create_op","name":"홍길동","role":"접수","phone":"010-1234-5678"}
← {"ok":true,"id":"KFI26-S01","temp":"Hk7q-2mPz","user_id":"…"}

→ {"action":"change_password","old_password":"Hk7q-2mPz","new_password":"abc"}
← {"ok":false,"error":"pw_short","message":"8자 이상 입력해 주세요"}

→ {"action":"reset_event"}            (operator token)
← {"ok":false,"error":"forbidden","message":"마스터 계정만 할 수 있어요"}

→ {"action":"set_disabled","id":"KFI26-S01","disabled":true}
← {"ok":true,"id":"KFI26-S01","disabled":true}
```

### OP_EMAIL_DOMAIN = `ops.onsitebeta.app`

Operators sign in with a synthetic e-mail: `idToEmail('KFI26-S01') = 'kfi26-s01@ops.onsitebeta.app'`.
Chosen by probing `admin.createUser({email_confirm:true})` with throwaway users (created and deleted) on 2026-11-09:
`ops.onsitebeta.app`, `onsitebeta.app`, `staff.onsitebeta.kr` were all accepted; the first was taken and is a constant
in `functions/admin-ops/index.ts`. No mail is ever sent to it (accounts are created confirmed).
The client must map an operator login ID to this address before `signInWithPassword`.

---

## Accounts in place

| Event | Login | Kind | State |
|---|---|---|---|
| KFI26 | two master accounts (e-mail logins, not recorded in this public repo) | master | must_change = false (both changed their temporary passwords on 2026-11-10) |
| TEST | `qa-master@ops.onsitebeta.app` (QA 마스터) | master | test-only; its data and operators were purged after the final test run and its sessions revoked. Remove it together with the TEST event with the SQL below (needs a confirmation in the Supabase tools, so it may still be present) |

```sql
-- remove the automated-test event and its accounts (does not touch KFI26)
delete from auth.users where id in (select user_id from public.members where event_code = 'TEST')
                          or raw_app_meta_data->>'event' = 'TEST';
delete from public.events where code = 'TEST';
```

Passwords were generated locally and written only to the operator's scratchpad (`secrets/masters.json`,
`secrets/qa.json`, mode 600) — never to the repo. All bootstrap tokens were used and the
`private.bootstrap_tokens` table is empty.

### Add another master later
1. Generate a token locally, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`,
   and its hash: `node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" <token>`.
2. SQL editor: `insert into private.bootstrap_tokens(token_sha256) values ('<hash>');`
3. `curl -s -X POST <URL>/functions/v1/admin-ops -H 'apikey: <publishable>' -H 'content-type: application/json' -d '{"action":"bootstrap","token":"<token>","event_code":"KFI26","masters":[{"email":"…","name":"…","password":"<temp ≥8>","must_change":true}]}'`
4. `delete from private.bootstrap_tokens;`

### Recover a master password
Preferred: the **other** active master uses "reset" on that account in the app (`reset_op` works on another master,
never on yourself) and reads the temporary password from the account list.

If no master can sign in, SQL editor (Dashboard → SQL):
```sql
-- 1. temporary password + forced change at next login
update auth.users
   set encrypted_password = extensions.crypt('Temp-0000-change', extensions.gen_salt('bf')),
       banned_until = null
 where email = '<master e-mail>';
update public.members set must_change = true, disabled = false where login_id = '<master e-mail>';
-- 2. sign out every device of that account
delete from auth.sessions where user_id = (select id from auth.users where email = '<master e-mail>');
```
Then sign in with the temporary password; the app forces a password change (`change_password`).

## After the event — purge

1. In the master app: "영구 삭제" → `purge_event` (deletes applicant data, log, timetable content and every operator
   account of the event; masters stay).
2. Optional, to remove the event completely (SQL editor):
   ```sql
   delete from auth.users where raw_app_meta_data->>'event' = 'KFI26';   -- masters (operators are already gone)
   delete from public.events where code = 'KFI26';                       -- cascades every remaining public row
   ```
3. Remove the test fixtures when no longer needed:
   ```sql
   delete from auth.users where raw_app_meta_data->>'event' = 'TEST';
   delete from public.events where code = 'TEST';
   ```

## Session / token behaviour (worth knowing)

- Access tokens are stateless JWTs (default lifetime 1 h). Revoking sessions stops refresh and makes admin-ops answer 401,
  but PostgREST would still accept the JWT until it expires — therefore RLS checks `members.disabled/must_change` on
  every request: a disabled or reset account reads **zero rows immediately** (tested).
- `set_disabled true` also bans the auth user (sign-in fails with `user_banned`).
- `change_password` keeps the caller's current session and revokes other sessions of the same account.

---

## Tests

### `tests/rls_matrix.sql` — 269/269 PASS
Run the file as one query (MCP `execute_sql`, SQL editor, or `psql -1 -f`). It creates fixture events/users/data,
impersonates each persona exactly like PostgREST (`set_config('role')` + `request.jwt.claims`), runs
select/insert/update/delete on every table (each statement in a rolled-back sub-transaction) plus 39 targeted checks
(app_patch, sync_pull, log actor spoofing, column-level member edits, private helpers, admin RPCs, the sign-up trigger),
then **always raises** an exception carrying the report, so the whole transaction is rolled back.
Result on 2026-11-09:
```
master:      events=1/denied/denied/denied members=5/denied/ok:1/denied op_secrets=1/denied/denied/denied roster=1/ok:1/ok:1/denied apps=2/ok:1/ok:2/denied conduct=1/ok:1/ok:1/denied extra=1/ok:1/ok:1/denied log=2/ok:1/denied/denied
operator:    events=1/denied/denied/denied members=1/denied/ok:1/denied op_secrets=0/denied/denied/denied roster=1/denied/ok:0/denied apps=2/ok:1/ok:2/denied conduct=1/ok:1/ok:1/denied extra=1/ok:1/ok:1/denied log=2/ok:1/denied/denied
must_change: events=0/denied/denied/denied members=1/denied/ok:1/denied op_secrets=0/… roster=0/denied/ok:0/denied apps=0/denied/ok:0/denied conduct=0/… extra=0/… log=0/denied/denied/denied
disabled:    (same as must_change)
master_mc:   (same as must_change)   -- master that has not changed the temporary password
other:       events=0/… members=0/denied/ok:0/denied … everything 0 / denied / ok:0     -- active master of another event
anon:        denied everywhere
(order per table: select / insert / update / delete; number = visible rows, ok:N = rows affected, denied = 42501)
```

### `tests/api_e2e.mjs` — 74/74 PASS (2026-11-09)
`SECRETS_DIR=<dir with qa.json> node supabase/tests/api_e2e.mjs` — real HTTP API: anonymous access to every table/RPC
denied (401/42501); public sign-up rejected (500 "Database error saving new user"); CORS allow/deny; 401 without/with bad
bearer; QA master sign-in; `create_op`; must_change operator gets zero rows and cannot write or call master actions;
`change_password` rule messages and success (caller session survives); active operator reads/inserts apps, `app_patch`
merge + null-key deletion, conduct/extra insert, no apps delete, no roster write, log insert / actor spoof denied /
duplicate `k` → 23505 / no update or delete (also for masters); `last_login` only; master-only actions → `forbidden`;
`reset_op` (old token zero rows + 401 at admin-ops, old password fails, new temp works); `set_disabled` (same token zero
rows immediately, writes denied, sign-in `user_banned`, re-enable restores); `set_role`; cross-event isolation;
`delete_op`; `reset_event`; `purge_event`; leaves one active TEST operator (`TEST-S01`; remove it with admin-ops `delete_op` as the QA master, or with the TEST removal SQL below). Uses ~7 direct sign-ins per run.

## Advisor findings (final)

| Advisor | Finding | Status / justification |
|---|---|---|
| security | `auth_leaked_password_protection` (WARN) — HaveIBeenPwned check disabled | Auth setting, not changeable from SQL/MCP. Turn on in Dashboard → Authentication → Providers → Email → "Prevent use of leaked passwords" if the plan allows it. Mitigated: no self sign-up, every password is either a random temp or a user choice under the ≥8 letters+digits rule. If enabled, admin-ops maps GoTrue `weak_password` to `pw_policy` ("더 안전한 비밀번호로 정해 주세요"). |
| performance | none in the final run | Right after the migrations it reported `unused_index` (INFO) ×6 (`apps/conduct/extra/members_event_updated_idx`, `log_event_id_idx`, `op_secrets_event_idx`) — normal for an empty database; it cleared once the tests exercised them. They back the `sync_pull` delta queries (`event_code = ? and updated_at >= ?`), log paging and RLS lookups by event. If it reappears before real traffic, keep them. |

No other security or performance findings (function `search_path` fixed everywhere, RLS initplan pattern
`(select auth.uid())` used, every FK covered by an index, one permissive policy per table/action).
