// onsitebeta backend end-to-end test through the real HTTP API (Auth, PostgREST, admin-ops).
// DESTRUCTIVE FOR EVENT "TEST" ONLY: creates/deletes operators, runs reset_event and purge_event on TEST.
// Never point it at a real event. Keeps total direct sign-ins at ~7 (+1 sign-up attempt).
//
//   SECRETS_DIR=/path/to/secrets NODE_USE_ENV_PROXY=1 node supabase/tests/api_e2e.mjs
//   (NODE_USE_ENV_PROXY / NODE_EXTRA_CA_CERTS only behind an HTTPS proxy)
//
// Prints PASS/FAIL per check and a SUMMARY line; never prints passwords or tokens.
import crypto from 'crypto';
import fs from 'fs';
// SECRETS_DIR must contain qa.json ({qa_master:{email,password}}); the script rewrites qa.json.test_operator at the end.
const SECRETS_DIR = process.env.SECRETS_DIR;
if (!SECRETS_DIR) { console.error('set SECRETS_DIR (directory holding qa.json)'); process.exit(2); }
const SP = SECRETS_DIR.replace(/\/secrets\/?$/, '');
const URL_='https://pptxgvkbgzasygdryxkw.supabase.co';
const PK='sb_publishable_hJz2LkwR9sicQPe7J3v89Q_Nxxixoif';
const FN=URL_+'/functions/v1/admin-ops';
const A='abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function rand(n){ const lim=256-(256%A.length); let o=''; while(o.length<n){ for(const b of crypto.randomBytes(n*2)){ if(b<lim) o+=A[b%A.length]; if(o.length===n) break; } } return o; }
function strongPw(n){ for(;;){ const s=rand(n); if(/[a-z]/.test(s)&&/[A-Z]/.test(s)&&/[0-9]/.test(s)) return s; } }
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
function readJ(p){ return JSON.parse(fs.readFileSync(p,'utf8')); }
function writeSecret(p,obj){ fs.writeFileSync(p, JSON.stringify(obj,null,2), {mode:0o600}); fs.chmodSync(p,0o600); }
async function fn(body, token){ const h={'content-type':'application/json', apikey:PK}; if(token) h.authorization='Bearer '+token; const r=await fetch(FN,{method:'POST',headers:h,body:JSON.stringify(body)}); let j; const t=await r.text(); try{ j=JSON.parse(t);}catch{ j={raw:t}; } return {status:r.status, ...j}; }
async function rawSignIn(email,password){ const r=await fetch(URL_+'/auth/v1/token?grant_type=password',{method:'POST',headers:{'content-type':'application/json',apikey:PK},body:JSON.stringify({email,password})}); const j=await r.json().catch(()=>({})); return {status:r.status, ...j}; }
async function rest(method, path, token, body, extraHeaders={}){ const h={apikey:PK, 'content-type':'application/json', ...extraHeaders}; if(token) h.authorization='Bearer '+token; const r=await fetch(URL_+'/rest/v1/'+path,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body)}); const t=await r.text(); let j; try{ j=t?JSON.parse(t):null; }catch{ j=t; } return {status:r.status, body:j, range:r.headers.get('content-range')}; }

const OPD = 'ops.onsitebeta.app';
const qa = readJ(SECRETS_DIR+'/qa.json');
const R = []; let signins = 0;
function rec(name, pass, evidence){ R.push({name, pass: !!pass, evidence}); console.log((pass?'PASS':'FAIL')+' | '+name+' | '+JSON.stringify(evidence)); }
async function signIn(email, pw){
  for (let i=0;i<3;i++){
    await sleep(2500); signins++;
    const r = await rawSignIn(email, pw);
    if (r.status === 429){ console.log('429 rate limit, waiting 70s'); await sleep(70000); continue; }
    return r;
  }
  throw new Error('rate limited');
}
const opEmail = (id)=> id.toLowerCase()+'@'+OPD;
const cnt = (r)=> Array.isArray(r.body) ? r.body.length : null;

// ---------- 0. anonymous access
const tables = ['events','members','op_secrets','roster','apps','conduct','extra','log'];
for (const t of tables){
  const r = await rest('GET', t+'?select=*', null);
  rec('anon read '+t+' denied', r.status===401 || r.status===403 || (r.status===200 && cnt(r)===0), {status:r.status, code:r.body?.code, rows:cnt(r)});
}
for (const [t,b] of [['apps',{event_code:'TEST',no:'x',data:{}}],['log',{event_code:'TEST',k:'x',txt:'x'}],['roster',{event_code:'TEST',v:1}],['conduct',{event_code:'TEST',id:'x',data:{}}],['members',{user_id:'00000000-0000-0000-0000-000000000000',event_code:'TEST',login_id:'x',kind:'master',name:'x'}]]){
  const r = await rest('POST', t, null, b);
  rec('anon insert '+t+' denied', r.status===401||r.status===403, {status:r.status, code:r.body?.code});
}
for (const [f,args] of [['app_patch',{p_ev:'TEST',p_no:'1',p_patch:{a:1}}],['sync_pull',{p_ev:'TEST',p_since:'2000-01-01T00:00:00Z'}],['admin_kill_sessions',{p_uid:'00000000-0000-0000-0000-000000000000'}],['admin_reset_event',{p_ev:'TEST'}]]){
  const r = await rest('POST', 'rpc/'+f, null, args);
  rec('anon rpc '+f+' denied', r.status===401||r.status===403||r.status===404, {status:r.status, code:r.body?.code});
}

// ---------- 1. public sign-up blocked
{
  await sleep(1500);
  const r = await fetch(URL_+'/auth/v1/signup', {method:'POST', headers:{'content-type':'application/json', apikey:PK}, body: JSON.stringify({email:'intruder-'+Date.now()+'@'+OPD, password:'Intrud3r-'+Date.now()})});
  const j = await r.json().catch(()=>({}));
  rec('public sign-up rejected', r.status>=400 && !j.access_token && !j.id, {status:r.status, code:j.error_code||j.code, msg:j.msg||j.message});
}

// ---------- 2. CORS + 401
{
  const pre = async (origin)=>{ const r = await fetch(FN,{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization, x-client-info, apikey, content-type'}}); return {status:r.status, acao:r.headers.get('access-control-allow-origin'), acah:r.headers.get('access-control-allow-headers')}; };
  const a = await pre('https://wombat20.github.io'), b = await pre('http://localhost:5173'), c = await pre('http://127.0.0.1:8080'), d = await pre('https://evil.example.com');
  rec('CORS allowed origins echoed', a.acao==='https://wombat20.github.io' && b.acao==='http://localhost:5173' && c.acao==='http://127.0.0.1:8080', {a,b,c});
  rec('CORS foreign origin not allowed', !d.acao, d);
  const n1 = await fn({action:'create_op', name:'x', role:'접수'});
  const n2 = await fn({action:'create_op', name:'x', role:'접수'}, 'not.a.jwt');
  rec('admin-ops without/invalid bearer -> 401', n1.status===401 && n1.error==='unauthorized' && n2.status===401, {n1:[n1.status,n1.error], n2:[n2.status,n2.error]});
}

// ---------- 3. QA master sign-in
const m = await signIn(qa.qa_master.email, qa.qa_master.password);
rec('QA master sign-in', m.status===200 && !!m.access_token, {status:m.status});
const MT = m.access_token; const masterId = m.user?.id;
{
  const ev = await rest('GET','events?select=code',MT);
  rec('master sees only own event', ev.status===200 && cnt(ev)===1 && ev.body[0].code==='TEST', {rows: ev.body});
  const mem = await rest('GET','members?select=login_id,event_code',MT);
  rec('master sees only own-event members', mem.status===200 && mem.body.every(x=>x.event_code==='TEST'), {rows: mem.body.map(x=>x.login_id)});
  const adm = await rest('POST','rpc/admin_kill_sessions',MT,{p_uid:masterId});
  const adm2 = await rest('POST','rpc/admin_allow_signup',MT,{p_email:'a@b.c',p_nonce:'x'});
  rec('authenticated cannot call service-only RPCs', adm.status>=400 && adm2.status>=400, {kill:[adm.status,adm.body?.code], allow:[adm2.status,adm2.body?.code]});
}

// ---------- 4. create_op
const c1 = await fn({action:'create_op', name:'테스트 운영자', role:'접수', phone:'010-0000-0000'}, MT);
rec('create_op', c1.ok===true && /^TEST-S\d{2}$/.test(c1.id) && /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/.test(c1.temp||''), {ok:c1.ok, id:c1.id, tempFormat: /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/.test(c1.temp||''), error:c1.error});
const OPID = c1.id; let opPw = c1.temp;
{
  const sec = await rest('GET','op_secrets?select=user_id,temp_pw',MT);
  rec('master sees op_secrets temp pw', sec.status===200 && sec.body.some(s=>s.user_id===c1.user_id && s.temp_pw===c1.temp), {rows:cnt(sec)});
  const bad = await fn({action:'create_op', name:'x', role:'관리'}, MT);
  rec('create_op invalid role rejected', bad.ok===false && bad.error==='bad_role', {error:bad.error, message:bad.message});
}

// ---------- 5. operator first login (must_change) -> zero rows
const o1 = await signIn(opEmail(OPID), opPw);
rec('operator sign-in with temp password', o1.status===200 && !!o1.access_token, {status:o1.status});
let OT = o1.access_token; const opUid = o1.user?.id;
{
  // seed some data as master so there is something to (not) see
  const s1 = await rest('POST','roster',MT,{event_code:'TEST', v:1, file:'t.xlsx', at:'09:00', by:'QA', labels:{a:1}, rows:[{no:'1'}]}, {Prefer:'resolution=merge-duplicates,return=minimal'});
  const s2 = await rest('POST','rpc/app_patch',MT,{p_ev:'TEST',p_no:'0001',p_patch:{st:'접수'}});
  rec('master can upsert roster + app_patch', s1.status<300 && s2.status<300, {roster:s1.status, app:s2.status});
  const a = await rest('GET','apps?select=*',OT), r = await rest('GET','roster?select=*',OT), e = await rest('GET','events?select=*',OT), me = await rest('GET','members?select=login_id,must_change',OT);
  rec('must_change operator gets ZERO rows (apps/roster/events)', cnt(a)===0 && cnt(r)===0 && cnt(e)===0, {apps:cnt(a), roster:cnt(r), events:cnt(e)});
  rec('must_change operator sees only own members row', cnt(me)===1 && me.body[0].login_id===OPID && me.body[0].must_change===true, {rows:me.body});
  const ins = await rest('POST','apps',OT,{event_code:'TEST',no:'9999',data:{x:1}});
  const ap = await rest('POST','rpc/app_patch',OT,{p_ev:'TEST',p_no:'9999',p_patch:{x:1}});
  rec('must_change operator cannot write apps', ins.status>=400 && ap.status>=400, {insert:[ins.status,ins.body?.code], patch:[ap.status,ap.body?.code]});
  const mo = await fn({action:'create_op', name:'x', role:'접수'}, OT);
  rec('must_change operator cannot call create_op', mo.ok===false && mo.error==='forbidden', {error:mo.error});
}

// ---------- 6. change_password rules + success
{
  const t1 = await fn({action:'change_password', old_password:opPw, new_password:'ab1'}, OT);
  const t2 = await fn({action:'change_password', old_password:opPw, new_password:'abcdefghij'}, OT);
  const t3 = await fn({action:'change_password', old_password:opPw, new_password:opPw}, OT);
  const t4 = await fn({action:'change_password', old_password:'Wrong-pass1', new_password:'Newpass123'}, OT);
  rec('change_password rule messages', t1.message==='8자 이상 입력해 주세요' && t2.message==='영문과 숫자를 함께 넣어 주세요' && (t3.error==='pw_short'||t3.message==='이전 비밀번호와 다르게 정해 주세요') && t4.message==='현재 비밀번호가 맞지 않아요',
      {short:t1.message, weak:t2.message, same:t3.message, wrong:t4.message});
  // temp pw is 9 chars incl '-', letters+digits -> same-check reachable:
  const newPw = 'Op'+strongPw(10)+'7';
  const ok1 = await fn({action:'change_password', old_password:opPw, new_password:newPw}, OT);
  rec('change_password success', ok1.ok===true, {ok:ok1.ok, error:ok1.error});
  opPw = newPw;
  const alive = await fn({action:'create_op', name:'x', role:'접수'}, OT);
  rec("caller's own session survives change_password (same token still accepted by admin-ops)", alive.status===200 && alive.error==='forbidden', {status:alive.status, error:alive.error});
  const me = await rest('GET','members?select=must_change,pw_changed_at&user_id=eq.'+opUid,OT);
  const sec = await rest('GET','op_secrets?select=user_id&user_id=eq.'+opUid,MT);
  rec('after change: must_change=false, op_secrets row removed', me.body?.[0]?.must_change===false && !!me.body?.[0]?.pw_changed_at && cnt(sec)===0, {me:me.body, secrets:cnt(sec)});
}

// ---------- 7. active operator: read/insert apps, app_patch merge, log rules
{
  const a = await rest('GET','apps?select=no,data',OT);
  rec('active operator (same token) can read apps', a.status===200 && cnt(a)>=1, {rows:cnt(a)});
  const ins = await rest('POST','apps',OT,{event_code:'TEST',no:'0100',data:{a:1,b:{x:1},c:'k'}}, {Prefer:'return=minimal'});
  rec('active operator can insert apps', ins.status===201, {status:ins.status, code:ins.body?.code});
  const p = await rest('POST','rpc/app_patch',OT,{p_ev:'TEST',p_no:'0100',p_patch:{b:{y:2}, c:null, d:true}});
  const g = await rest('GET','apps?select=data,updated_by&event_code=eq.TEST&no=eq.0100',OT);
  const d = g.body?.[0]?.data;
  rec('app_patch merges and null deletes key', p.status===204 && JSON.stringify(d)===JSON.stringify({a:1,b:{y:2},d:true}) && g.body?.[0]?.updated_by===opUid, {data:d, updated_by_is_op: g.body?.[0]?.updated_by===opUid});
  const p2 = await rest('POST','rpc/app_patch',OT,{p_ev:'TEST',p_no:'0101',p_patch:{q:1, z:null}});
  const g2 = await rest('GET','apps?select=data&event_code=eq.TEST&no=eq.0101',OT);
  rec('app_patch inserts new row (nulls stripped)', p2.status===204 && JSON.stringify(g2.body?.[0]?.data)===JSON.stringify({q:1}), {data:g2.body?.[0]?.data});
  const delA = await rest('DELETE','apps?event_code=eq.TEST&no=eq.0101',OT);
  rec('operator cannot delete apps', delA.status>=400, {status:delA.status, code:delA.body?.code});
  const cIns = await rest('POST','conduct',OT,{event_code:'TEST',id:'c1',data:{v:1}}, {Prefer:'return=minimal'});
  const xIns = await rest('POST','extra',OT,{event_code:'TEST',id:'x1',data:{v:1}}, {Prefer:'return=minimal'});
  rec('active operator can insert conduct/extra', cIns.status===201 && xIns.status===201, {conduct:cIns.status, extra:xIns.status});
  const rw = await rest('PATCH','roster?event_code=eq.TEST',OT,{file:'hack'}, {Prefer:'return=representation'});
  rec('operator cannot write roster', rw.status>=400 || cnt(rw)===0, {status:rw.status, rows:cnt(rw), code:rw.body?.code});
  const l1 = await rest('POST','log',OT,{event_code:'TEST',k:'k-op-1',at:'10:00',who:'op',txt:'hello'}, {Prefer:'return=representation'});
  rec('operator can insert log (actor defaults to self)', l1.status===201 && l1.body?.[0]?.actor===opUid, {status:l1.status});
  const l2 = await rest('POST','log',OT,{event_code:'TEST',k:'k-op-2',actor:masterId,txt:'spoof'});
  rec('operator cannot spoof log actor', l2.status>=400, {status:l2.status, code:l2.body?.code});
  const l3 = await rest('POST','log',OT,{event_code:'TEST',k:'k-op-1',txt:'dup'});
  rec('duplicate log k -> 23505 conflict', l3.status===409 && l3.body?.code==='23505', {status:l3.status, code:l3.body?.code});
  const lu = await rest('PATCH','log?k=eq.k-op-1',OT,{txt:'changed'});
  const ld = await rest('DELETE','log?k=eq.k-op-1',OT);
  const lu2 = await rest('PATCH','log?k=eq.k-op-1',MT,{txt:'changed'});
  const ld2 = await rest('DELETE','log?k=eq.k-op-1',MT);
  const lchk = await rest('GET','log?select=txt&k=eq.k-op-1',MT);
  rec('log is append-only (operator+master cannot update/delete)', lu.status>=400 && ld.status>=400 && lu2.status>=400 && ld2.status>=400 && lchk.body?.[0]?.txt==='hello', {op:[lu.status,ld.status], master:[lu2.status,ld2.status], txt:lchk.body?.[0]?.txt});
  const ll = await rest('PATCH','members?user_id=eq.'+opUid,OT,{last_login:new Date().toISOString()}, {Prefer:'return=minimal'});
  const lm = await rest('PATCH','members?user_id=eq.'+opUid,OT,{must_change:true});
  const lr = await rest('PATCH','members?user_id=eq.'+opUid,OT,{role:'상주'});
  rec('members: own last_login updatable, other columns not', ll.status===204 && lm.status>=400 && lr.status>=400, {last_login:ll.status, must_change:[lm.status,lm.body?.code], role:[lr.status,lr.body?.code]});
  const osec = await rest('GET','op_secrets?select=*',OT);
  const omem = await rest('GET','members?select=login_id',OT);
  rec('operator sees no op_secrets and only own members row', cnt(osec)===0 && cnt(omem)===1, {secrets:cnt(osec), members:omem.body});
  const sp = await rest('POST','rpc/sync_pull',OT,{p_ev:'TEST',p_since:'2000-01-01T00:00:00Z',p_log_after:0});
  rec('sync_pull as operator: data visible, secrets hidden', sp.status===200 && sp.body?.apps?.length>=2 && sp.body?.secrets?.length===0 && sp.body?.members?.length===1, {apps:sp.body?.apps?.length, secrets:sp.body?.secrets?.length, members:sp.body?.members?.length, log:sp.body?.log?.length});
}

// ---------- 8. operator calling master-only actions
{
  const acts = [['create_op',{name:'x',role:'접수'}],['reset_op',{id:OPID}],['set_disabled',{id:OPID,disabled:true}],['delete_op',{id:OPID}],['set_role',{id:OPID,role:'상주'}],['reset_event',{}],['purge_event',{}]];
  const out = {};
  for (const [a,b] of acts){ const r = await fn({action:a, ...b}, OT); out[a] = r.error; }
  rec('operator cannot call master-only actions', Object.values(out).every(e=>e==='forbidden'), out);
}

// ---------- 9. reset_op
{
  const oldToken = OT;
  const r = await fn({action:'reset_op', id:OPID}, MT);
  rec('reset_op', r.ok===true && /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/.test(r.temp||''), {ok:r.ok, error:r.error});
  const a = await rest('GET','apps?select=no',oldToken);
  const me = await rest('GET','members?select=must_change',oldToken);
  rec('after reset_op: old token gets zero rows, must_change=true', cnt(a)===0 && me.body?.[0]?.must_change===true, {apps:cnt(a), me:me.body});
  const fnOld = await fn({action:'change_password', old_password:opPw, new_password:'Another123x'}, oldToken);
  rec('after reset_op: old token rejected by admin-ops (session revoked)', fnOld.status===401, {status:fnOld.status, error:fnOld.error});
  const s = await signIn(opEmail(OPID), opPw);
  rec('after reset_op: old password fails', s.status===400 && !s.access_token, {status:s.status, code:s.error_code});
  const s2 = await signIn(opEmail(OPID), r.temp);
  rec('after reset_op: new temp password works', s2.status===200, {status:s2.status});
  OT = s2.access_token; opPw = r.temp;
  const newPw = 'Op'+strongPw(10)+'8';
  const cp = await fn({action:'change_password', old_password:opPw, new_password:newPw}, OT);
  rec('change_password after reset', cp.ok===true, {ok:cp.ok, error:cp.error}); opPw = newPw;
}

// ---------- 10. set_disabled
{
  const pre = await rest('GET','apps?select=no',OT);
  const d = await fn({action:'set_disabled', id:OPID, disabled:true}, MT);
  const a = await rest('GET','apps?select=no',OT), rr = await rest('GET','roster?select=v',OT), lg = await rest('GET','log?select=id',OT);
  rec('set_disabled true: same (still valid) token now reads zero rows', d.ok===true && cnt(pre)>0 && cnt(a)===0 && cnt(rr)===0 && cnt(lg)===0, {before:cnt(pre), apps:cnt(a), roster:cnt(rr), log:cnt(lg)});
  const w = await rest('POST','rpc/app_patch',OT,{p_ev:'TEST',p_no:'0100',p_patch:{z:1}});
  rec('disabled operator cannot write', w.status>=400, {status:w.status, code:w.body?.code});
  const s = await signIn(opEmail(OPID), opPw);
  rec('disabled operator sign-in fails', s.status>=400 && !s.access_token, {status:s.status, code:s.error_code, msg:s.msg});
  const selfD = await fn({action:'set_disabled', id:qa.qa_master.email, disabled:true}, MT);
  rec('master cannot disable self', selfD.ok===false && selfD.error==='self', {error:selfD.error});
  const e = await fn({action:'set_disabled', id:OPID, disabled:false}, MT);
  const s2 = await signIn(opEmail(OPID), opPw);
  rec('set_disabled false: sign-in works again', e.ok===true && s2.status===200, {ok:e.ok, status:s2.status});
  OT = s2.access_token;
  const a2 = await rest('GET','apps?select=no',OT);
  rec('re-enabled operator reads data again', cnt(a2)>0, {apps:cnt(a2)});
}

// ---------- 11. set_role
{
  const r = await fn({action:'set_role', id:OPID, role:'상주', name:'테스트 운영자2', phone:'010-1111-2222'}, MT);
  const g = await rest('GET','members?select=role,name,phone&login_id=eq.'+OPID,MT);
  rec('set_role (+name/phone)', r.ok===true && g.body?.[0]?.role==='상주' && g.body?.[0]?.name==='테스트 운영자2', {row:g.body?.[0]});
  const bad = await fn({action:'set_role', id:OPID, role:'xx'}, MT);
  const onMaster = await fn({action:'set_role', id:qa.qa_master.email, role:'접수'}, MT);
  rec('set_role validation (bad role / master target)', bad.error==='bad_role' && onMaster.error==='not_operator', {bad:bad.error, master:onMaster.error});
}

// ---------- 12. cross-event isolation
{
  const k = await fn({action:'reset_op', id:(process.env.CROSS_EVENT_LOGIN_ID||'nobody@ops.onsitebeta.app')}, MT);
  rec('cannot target member of another event', k.ok===false && k.error==='not_found', {error:k.error});
  const w = await rest('POST','rpc/app_patch',MT,{p_ev:'KFI26',p_no:'1',p_patch:{x:1}});
  const r = await rest('GET','apps?select=no&event_code=eq.KFI26',MT);
  rec('TEST master cannot write/read KFI26 data', w.status>=400 && cnt(r)===0, {write:[w.status,w.body?.code], read:cnt(r)});
}

// ---------- 13. delete_op
{
  const del = await fn({action:'delete_op', id:OPID}, MT);
  const g = await rest('GET','members?select=login_id&login_id=eq.'+OPID,MT);
  const dm = await fn({action:'delete_op', id:qa.qa_master.email}, MT);
  rec('delete_op removes operator; masters not deletable', del.ok===true && cnt(g)===0 && dm.error==='not_operator', {ok:del.ok, left:cnt(g), master:dm.error});
  const a = await rest('GET','apps?select=no',OT);
  rec('deleted operator token reads zero rows', cnt(a)===0, {apps:cnt(a)});
}

// ---------- 14. reset_event
{
  await rest('POST','conduct',MT,{event_code:'TEST',id:'c2',data:{v:2}}, {Prefer:'resolution=merge-duplicates,return=minimal'});
  await rest('POST','log',MT,{event_code:'TEST',k:'k-m-1',txt:'m'});
  const before = await rest('POST','rpc/sync_pull',MT,{p_ev:'TEST',p_since:'2000-01-01T00:00:00Z',p_log_after:0});
  const r = await fn({action:'reset_event'}, MT);
  const after = await rest('POST','rpc/sync_pull',MT,{p_ev:'TEST',p_since:'2000-01-01T00:00:00Z',p_log_after:0});
  const ros = await rest('GET','roster?select=v,file,rows',MT);
  const apps = after.body.apps, cond = after.body.conduct, ext = after.body.extra;
  rec('reset_event: apps tombstoned, conduct/extra null, log empty, roster kept, reset_at bumped',
      r.ok===true && apps.length>0 && apps.every(a=>JSON.stringify(a.data)==='{}') && cond.every(c=>c.data===null) && ext.every(x=>x.data===null) && after.body.log.length===0 && ros.body?.[0]?.file==='t.xlsx' && ros.body?.[0]?.rows?.length===1 && after.body.event.reset_at > before.body.event.reset_at,
      {apps:apps.length, conduct:cond.length, extra:ext.length, log_before:before.body.log.length, log_after:after.body.log.length, roster_file:ros.body?.[0]?.file, reset_at_bumped: after.body.event.reset_at > before.body.event.reset_at});
}

// ---------- 15. purge_event (with 2 throwaway operators)
{
  const a1 = await fn({action:'create_op', name:'삭제용1', role:'인솔'}, MT);
  const a2 = await fn({action:'create_op', name:'삭제용2', role:'상주'}, MT);
  await rest('POST','rpc/app_patch',MT,{p_ev:'TEST',p_no:'0200',p_patch:{x:1}});
  const opsBefore = (await rest('GET','members?select=login_id&kind=eq.operator',MT)).body.length;
  const t0 = Date.now();
  const r = await fn({action:'purge_event'}, MT);
  const after = await rest('POST','rpc/sync_pull',MT,{p_ev:'TEST',p_since:'2000-01-01T00:00:00Z',p_log_after:0});
  const ros = await rest('GET','roster?select=*',MT);
  const mem = await rest('GET','members?select=login_id,kind',MT);
  const ro = ros.body?.[0] || {};
  rec('purge_event: data deleted, roster blanked (v=epoch ms), operators deleted, masters kept',
      r.ok===true && opsBefore>=2 && r.deleted_operators===opsBefore && after.body.apps.length===0 && after.body.conduct.length===0 && after.body.extra.length===0 && after.body.log.length===0 &&
      JSON.stringify(ro.rows)==='[]' && JSON.stringify(ro.labels)==='{}' && ro.file===null && ro.at===null && ro.by===null && ro.v>=t0-60000 && mem.body.every(x=>x.kind==='master') && mem.body.length===1,
      {ok:r.ok, operators_before:opsBefore, deleted_operators:r.deleted_operators, created:[a1.id,a2.id], apps:after.body.apps.length, roster:{v_is_epoch_ms: ro.v>=t0-60000, rows:ro.rows, labels:ro.labels, file:ro.file}, members:mem.body});
}

// ---------- 16. leave one active test operator for the lead's E2E
{
  const c = await fn({action:'create_op', name:'E2E 운영자', role:'접수', phone:'010-0000-0001'}, MT);
  const s = await signIn(opEmail(c.id), c.temp);
  const pw = 'E2e'+strongPw(12)+'9';
  const cp = await fn({action:'change_password', old_password:c.temp, new_password:pw}, s.access_token);
  const ok = c.ok && s.status===200 && cp.ok===true;
  rec('E2E test operator created and activated', ok, {id:c.id, signin:s.status, change:cp.ok});
  if (ok){
    const q = readJ(SECRETS_DIR+'/qa.json');
    q.test_operator = {id:c.id, email:opEmail(c.id), password:pw, must_change:false, role:'접수', note:'Active operator of event TEST. Call reset_op as the QA master to get a fresh temp password if you want to test the first-login flow.'};
    writeSecret(SECRETS_DIR+'/qa.json', q);
  }
}
console.log('direct sign-ins used:', signins);
if (process.env.RESULTS_FILE) fs.writeFileSync(process.env.RESULTS_FILE, JSON.stringify(R,null,1));
console.log('SUMMARY', R.filter(x=>x.pass).length+'/'+R.length+' passed');
