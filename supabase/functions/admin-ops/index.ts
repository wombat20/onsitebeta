// admin-ops: account / event administration for onsitebeta.
// Deployed with verify_jwt = false; every action except `bootstrap` authorizes the caller in code
// (Authorization: Bearer <user access token>, resolved with auth.getUser).
//
// Response contract: HTTP 200 + {ok:true,...} | {ok:false,error:'<code>',message:'<Korean>'}
//                    HTTP 401 + {ok:false,error:'unauthorized'} when the bearer token is missing/invalid.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';

// Synthetic login e-mail domain for operator accounts (KFI26-S01 -> kfi26-s01@ops.onsitebeta.app).
// Chosen by probing admin.createUser on 2026-11-09: the first candidate was accepted (see supabase/README.md).
// The address never receives mail (accounts are created with email_confirm: true).
const OP_EMAIL_DOMAIN = 'ops.onsitebeta.app';

const ROLES = ['접수', '인솔', '상주'];
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BAN_FOREVER = '876000h';

function envKey(jsonName: string, legacyName: string): string {
  try {
    const j = JSON.parse(Deno.env.get(jsonName) || '{}');
    if (j && typeof j.default === 'string' && j.default) return j.default;
  } catch (_) { /* fall through */ }
  return Deno.env.get(legacyName) || '';
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SECRET_KEY = envKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
const PUBLISHABLE_KEY = envKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');

const NO_SESSION = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
const admin: SupabaseClient = createClient(SUPABASE_URL, SECRET_KEY, { auth: NO_SESSION });

// ------------------------------------------------------------------ messages
const MSG: Record<string, string> = {
  unauthorized: '로그인이 필요해요. 다시 로그인해 주세요',
  bad_request: '요청 내용이 올바르지 않아요',
  bad_action: '알 수 없는 요청이에요',
  not_member: '등록되지 않은 계정이에요',
  disabled: '사용이 중지된 계정이에요',
  must_change: '비밀번호를 먼저 바꿔 주세요',
  forbidden: '마스터 계정만 할 수 있어요',
  not_found: '해당 계정을 찾을 수 없어요',
  self: '내 계정에는 이 작업을 할 수 없어요',
  not_operator: '운영자 계정에만 할 수 있어요',
  bad_name: '이름을 입력해 주세요',
  bad_role: '역할은 접수·인솔·상주 중에서 골라 주세요',
  pw_short: '8자 이상 입력해 주세요',
  pw_weak: '영문과 숫자를 함께 넣어 주세요',
  pw_same: '이전 비밀번호와 다르게 정해 주세요',
  pw_wrong: '현재 비밀번호가 맞지 않아요',
  pw_policy: '더 안전한 비밀번호로 정해 주세요',
  rate_limited: '시도가 너무 많아요. 잠시 후 다시 해 주세요',
  bad_token: '부트스트랩 토큰이 올바르지 않거나 이미 사용되었어요',
  no_event: '행사를 찾을 수 없어요',
  exists: '이미 등록된 계정이에요',
  server: '서버 오류가 발생했어요. 잠시 후 다시 시도해 주세요',
};

type Result = Record<string, unknown>;
const ok = (extra: Result = {}): Result => ({ ok: true, ...extra });
const fail = (error: string, message?: string): Result => ({ ok: false, error, message: message || MSG[error] || MSG.server });

class Fail extends Error {
  constructor(public result: Result) { super(String(result.error)); }
}
const bail = (error: string, message?: string): never => { throw new Fail(fail(error, message)); };

// ------------------------------------------------------------------ CORS / HTTP
function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  if (origin === 'https://wombat20.github.io') return origin;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin)) return origin;
  return null;
}

function corsHeaders(req: Request): Record<string, string> {
  const h: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  const o = allowedOrigin(req.headers.get('origin'));
  if (o) h['Access-Control-Allow-Origin'] = o;
  return h;
}

function json(body: Result, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// ------------------------------------------------------------------ helpers
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const idToEmail = (id: string): string => id.toLowerCase() + '@' + OP_EMAIL_DOMAIN;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function randomFrom(alphabet: string, n: number): string {
  const limit = 256 - (256 % alphabet.length); // rejection sampling, no modulo bias
  let out = '';
  while (out.length < n) {
    const buf = new Uint8Array(n * 2);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < limit) out += alphabet[b % alphabet.length];
      if (out.length === n) break;
    }
  }
  return out;
}

// Temporary password 'xxxx-xxxx' (always contains a letter and a digit).
function genPw(): string {
  for (;;) {
    const s = randomFrom(ALPHABET, 8);
    if (/[A-Za-z]/.test(s) && /[0-9]/.test(s)) return s.slice(0, 4) + '-' + s.slice(4);
  }
}

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function check<T>(r: { data: T; error: unknown }, where: string): T {
  if (r.error) {
    console.error('db error at', where, JSON.stringify(r.error));
    throw r.error;
  }
  return r.data;
}

// deno-lint-ignore no-explicit-any
const authErrCode = (e: any): string => str(e?.code || e?.error_code || '');
// deno-lint-ignore no-explicit-any
const isEmailExists = (e: any): boolean =>
  ['email_exists', 'user_already_exists'].includes(authErrCode(e)) || /already (been )?registered|already exists/i.test(str(e?.message));

interface Member {
  user_id: string;
  event_code: string;
  login_id: string;
  kind: 'master' | 'operator';
  name: string;
  role: string | null;
  phone: string | null;
  must_change: boolean;
  disabled: boolean;
}

function requireActiveMaster(me: Member): void {
  if (me.kind !== 'master') bail('forbidden');
  if (me.disabled) bail('disabled');
  if (me.must_change) bail('must_change');
}

async function findTarget(me: Member, rawId: unknown): Promise<Member> {
  const id = str(rawId).trim();
  if (!id) bail('bad_request');
  let q = admin.from('members').select('*').eq('event_code', me.event_code);
  if (UUID_RE.test(id)) q = q.eq('user_id', id.toLowerCase());
  else q = q.in('login_id', Array.from(new Set([id, id.toUpperCase(), id.toLowerCase()])));
  const rows = check(await q.limit(2), 'findTarget') as Member[];
  if (!rows || rows.length !== 1) bail('not_found');
  return rows[0];
}

async function killSessions(uid: string): Promise<void> {
  check(await admin.rpc('admin_kill_sessions', { p_uid: uid }), 'kill_sessions');
}

// Create an auth user. auth.users has a BEFORE INSERT trigger (private.block_signup) that rejects every
// insert without a one-time ticket, so self sign-up is impossible; we issue the ticket right before.
async function createAuthUser(email: string, password: string, appMeta: Result, name: string) {
  const nonce = randomFrom(ALPHABET, 32);
  check(await admin.rpc('admin_allow_signup', { p_email: email, p_nonce: nonce }), 'allow_signup');
  return await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    app_metadata: appMeta,
    user_metadata: { name, onsite_nonce: nonce }, // consumed and stripped by the trigger
  });
}

// ------------------------------------------------------------------ actions
async function createOp(me: Member, body: Result): Promise<Result> {
  requireActiveMaster(me);
  const name = str(body.name).trim().slice(0, 40);
  if (!name) bail('bad_name');
  const role = str(body.role);
  if (!ROLES.includes(role)) bail('bad_role');
  const phone = str(body.phone).trim().slice(0, 40) || null;
  const ev = me.event_code;
  const prefix = ev + '-S';

  const existing = check(
    await admin.from('members').select('login_id').eq('event_code', ev).eq('kind', 'operator'),
    'create_op.list',
  ) as { login_id: string }[];
  let max = 0;
  for (const r of existing || []) {
    if (r.login_id.startsWith(prefix)) {
      const tail = r.login_id.slice(prefix.length);
      if (/^\d+$/.test(tail)) max = Math.max(max, parseInt(tail, 10));
    }
  }

  for (let n = max + 1, attempt = 0; attempt < 8; attempt++, n++) {
    const id = prefix + String(n).padStart(2, '0');
    const temp = genPw();
    const { data: cu, error: ce } = await createAuthUser(idToEmail(id), temp, { onsite: 'staff', event: ev, kind: 'operator' }, name);
    if (ce) {
      if (isEmailExists(ce)) continue;
      console.error('create_op createUser', authErrCode(ce), ce.message);
      throw ce;
    }
    const uid = cu.user!.id;
    const { error: mErr } = await admin.from('members').insert({
      user_id: uid, event_code: ev, login_id: id, kind: 'operator', name, role, phone, must_change: true,
    });
    if (mErr) {
      await admin.auth.admin.deleteUser(uid);
      // deno-lint-ignore no-explicit-any
      if ((mErr as any).code === '23505') continue;
      console.error('create_op members', JSON.stringify(mErr));
      throw mErr;
    }
    const { error: sErr } = await admin.from('op_secrets').insert({ user_id: uid, event_code: ev, temp_pw: temp });
    if (sErr) {
      await admin.auth.admin.deleteUser(uid);
      console.error('create_op op_secrets', JSON.stringify(sErr));
      throw sErr;
    }
    return ok({ id, temp, user_id: uid });
  }
  return fail('server', '계정 번호를 정하지 못했어요. 다시 시도해 주세요');
}

async function resetOp(me: Member, body: Result): Promise<Result> {
  requireActiveMaster(me);
  const t = await findTarget(me, body.id);
  if (t.user_id === me.user_id) bail('self');
  const temp = genPw();
  // 1) RLS lock-out first (must_change = true makes is_member() false for live access tokens)
  check(await admin.from('members').update({ must_change: true, disabled: false }).eq('user_id', t.user_id), 'reset_op.members');
  check(await admin.from('op_secrets').upsert({
    user_id: t.user_id, event_code: t.event_code, temp_pw: temp, issued_at: new Date().toISOString(),
  }), 'reset_op.secrets');
  const { error } = await admin.auth.admin.updateUserById(t.user_id, { password: temp, ban_duration: 'none' });
  if (error) { console.error('reset_op updateUser', authErrCode(error), error.message); throw error; }
  await killSessions(t.user_id);
  return ok({ id: t.login_id, temp });
}

async function setDisabled(me: Member, body: Result): Promise<Result> {
  requireActiveMaster(me);
  if (typeof body.disabled !== 'boolean') bail('bad_request');
  const disabled = body.disabled as boolean;
  const t = await findTarget(me, body.id);
  if (t.user_id === me.user_id) bail('self');
  check(await admin.from('members').update({ disabled }).eq('user_id', t.user_id), 'set_disabled.members');
  const { error } = await admin.auth.admin.updateUserById(t.user_id, { ban_duration: disabled ? BAN_FOREVER : 'none' });
  if (error) { console.error('set_disabled updateUser', authErrCode(error), error.message); throw error; }
  if (disabled) await killSessions(t.user_id);
  return ok({ id: t.login_id, disabled });
}

async function deleteOp(me: Member, body: Result): Promise<Result> {
  requireActiveMaster(me);
  const t = await findTarget(me, body.id);
  if (t.kind !== 'operator') bail('not_operator');
  const { error } = await admin.auth.admin.deleteUser(t.user_id); // cascades members, op_secrets
  if (error) { console.error('delete_op deleteUser', authErrCode(error), error.message); throw error; }
  return ok({ id: t.login_id });
}

async function setRole(me: Member, body: Result): Promise<Result> {
  requireActiveMaster(me);
  const t = await findTarget(me, body.id);
  if (t.kind !== 'operator') bail('not_operator');
  const patch: Result = {};
  if (body.role !== undefined) {
    const role = str(body.role);
    if (!ROLES.includes(role)) bail('bad_role');
    patch.role = role;
  }
  if (body.name !== undefined) {
    const name = str(body.name).trim().slice(0, 40);
    if (!name) bail('bad_name');
    patch.name = name;
  }
  if (body.phone !== undefined) patch.phone = str(body.phone).trim().slice(0, 40) || null;
  if (!Object.keys(patch).length) bail('bad_request');
  check(await admin.from('members').update(patch).eq('user_id', t.user_id), 'set_role');
  return ok({ id: t.login_id });
}

async function changePassword(me: Member, email: string, callerToken: string, body: Result): Promise<Result> {
  if (me.disabled) bail('disabled');
  const oldPw = str(body.old_password);
  const newPw = str(body.new_password);
  if (!oldPw) bail('pw_wrong');
  if (newPw.length < 8) bail('pw_short');
  if (!/[A-Za-z]/.test(newPw) || !/[0-9]/.test(newPw)) bail('pw_weak');
  if (newPw === oldPw) bail('pw_same');
  if (!email) bail('server');

  // 1) verify the current password
  const pub = createClient(SUPABASE_URL, PUBLISHABLE_KEY, { auth: NO_SESSION });
  const { data: si, error: se } = await pub.auth.signInWithPassword({ email, password: oldPw });
  if (se || !si?.session) {
    // deno-lint-ignore no-explicit-any
    if ((se as any)?.status === 429 || authErrCode(se) === 'over_request_rate_limit') bail('rate_limited');
    bail('pw_wrong');
  }
  // drop the verification session
  try { await admin.auth.admin.signOut(si!.session!.access_token, 'local'); } catch (_) { /* best effort */ }

  // 2) change the password through the CALLER'S OWN session (PUT /auth/v1/user).
  //    GoTrue then keeps that session and revokes the user's other sessions.
  //    (admin.updateUserById({password}) would revoke ALL sessions, logging the caller out.)
  const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
    method: 'PUT',
    headers: { apikey: PUBLISHABLE_KEY, Authorization: 'Bearer ' + callerToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: newPw }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({})) as Record<string, unknown>;
    const c = str(j.error_code || j.code);
    if (c === 'same_password') bail('pw_same');
    if (c === 'weak_password') bail('pw_policy');
    if (r.status === 429 || c === 'over_request_rate_limit') bail('rate_limited');
    if (r.status === 401 || r.status === 403) bail('unauthorized');
    console.error('change_password PUT /user', r.status, c, str(j.msg || j.message));
    bail('server');
  }
  check(await admin.from('members').update({ must_change: false, pw_changed_at: new Date().toISOString() }).eq('user_id', me.user_id), 'change_password.members');
  check(await admin.from('op_secrets').delete().eq('user_id', me.user_id), 'change_password.secrets');
  return ok();
}

async function resetEvent(me: Member): Promise<Result> {
  requireActiveMaster(me);
  check(await admin.rpc('admin_reset_event', { p_ev: me.event_code }), 'reset_event');
  return ok();
}

async function purgeEvent(me: Member): Promise<Result> {
  requireActiveMaster(me);
  const ev = me.event_code;
  check(await admin.rpc('admin_purge_event_data', { p_ev: ev, p_v: Date.now() }), 'purge_event.data');

  const uids = new Set<string>();
  const ops = check(await admin.from('members').select('user_id').eq('event_code', ev).eq('kind', 'operator'), 'purge_event.list') as { user_id: string }[];
  for (const r of ops || []) uids.add(r.user_id);
  // also orphaned operator auth users of this event (no members row)
  for (let page = 1; page < 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) { console.error('purge_event listUsers', error.message); break; }
    for (const u of data.users) {
      const am = (u.app_metadata || {}) as Record<string, unknown>;
      if (am.onsite === 'staff' && am.event === ev && am.kind === 'operator') uids.add(u.id);
    }
    if (data.users.length < 1000) break;
  }
  let deleted = 0;
  for (const uid of uids) {
    const { error } = await admin.auth.admin.deleteUser(uid);
    if (error) console.error('purge_event deleteUser', authErrCode(error), error.message);
    else deleted++;
  }
  // in case an auth delete failed, never leave an operator row behind
  await admin.from('members').delete().eq('event_code', ev).eq('kind', 'operator');
  return ok({ deleted_operators: deleted });
}

async function bootstrap(body: Result): Promise<Result> {
  const token = str(body.token);
  const ev = str(body.event_code).trim();
  const masters = Array.isArray(body.masters) ? body.masters as Result[] : null;
  if (!token || token.length < 16 || !ev || !masters || masters.length < 1 || masters.length > 10) bail('bad_request');

  // consume the one-time token first (atomic UPDATE ... WHERE used_at IS NULL)
  const used = check(await admin.rpc('admin_use_bootstrap_token', { p_sha256: await sha256hex(token) }), 'bootstrap.token');
  if (used !== true) bail('bad_token');

  const evRow = check(await admin.from('events').select('code').eq('code', ev).maybeSingle(), 'bootstrap.event');
  if (!evRow) bail('no_event');

  const created: Result[] = [];
  const failed: Result[] = [];
  for (const m of masters!) {
    const email = str(m.email).trim().toLowerCase();
    const name = str(m.name).trim().slice(0, 40);
    const password = str(m.password);
    const mustChange = m.must_change !== false;
    if (!email.includes('@') || !name || password.length < 8) { failed.push({ email, error: 'bad_request' }); continue; }
    const { data: cu, error: ce } = await createAuthUser(email, password, { onsite: 'staff', event: ev, kind: 'master' }, name);
    if (ce) {
      failed.push({ email, error: isEmailExists(ce) ? 'exists' : (authErrCode(ce) || 'auth_error'), message: ce.message });
      continue;
    }
    const uid = cu.user!.id;
    const { error: mErr } = await admin.from('members').insert({
      user_id: uid, event_code: ev, login_id: email, kind: 'master', name, must_change: mustChange,
    });
    if (mErr) {
      await admin.auth.admin.deleteUser(uid);
      failed.push({ email, error: 'members_insert', message: str((mErr as { message?: string }).message) });
      continue;
    }
    created.push({ email, login_id: email, user_id: uid, must_change: mustChange });
  }
  return { ok: failed.length === 0, created, failed, ...(failed.length ? { error: 'partial', message: '일부 계정을 만들지 못했어요' } : {}) };
}

// ------------------------------------------------------------------ entry
Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: cors });
  if (req.method !== 'POST') return json(fail('bad_request', 'POST 요청만 받아요'), 405, cors);

  let body: Result;
  try {
    body = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('body');
  } catch (_) {
    return json(fail('bad_request'), 200, cors);
  }
  const action = str(body.action);

  try {
    if (action === 'bootstrap') return json(await bootstrap(body), 200, cors);

    const authz = req.headers.get('authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(authz);
    const token = m ? m[1].trim() : '';
    if (!token || token.split('.').length !== 3) return json({ ok: false, error: 'unauthorized', message: MSG.unauthorized }, 401, cors);
    const { data: ud, error: ue } = await admin.auth.getUser(token);
    if (ue || !ud?.user) return json({ ok: false, error: 'unauthorized', message: MSG.unauthorized }, 401, cors);
    const user = ud.user;

    const me = check(await admin.from('members').select('*').eq('user_id', user.id).maybeSingle(), 'caller') as Member | null;
    if (!me) return json(fail('not_member'), 200, cors);

    let res: Result;
    switch (action) {
      case 'create_op': res = await createOp(me, body); break;
      case 'reset_op': res = await resetOp(me, body); break;
      case 'set_disabled': res = await setDisabled(me, body); break;
      case 'delete_op': res = await deleteOp(me, body); break;
      case 'set_role': res = await setRole(me, body); break;
      case 'change_password': res = await changePassword(me, user.email || '', token, body); break;
      case 'reset_event': res = await resetEvent(me); break;
      case 'purge_event': res = await purgeEvent(me); break;
      default: res = fail('bad_action');
    }
    return json(res, 200, cors);
  } catch (e) {
    if (e instanceof Fail) return json(e.result, 200, cors);
    console.error('admin-ops', action, e instanceof Error ? e.message : JSON.stringify(e));
    return json(fail('server'), 200, cors);
  }
});
