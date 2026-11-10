/* =====================================================================
   ONSITE BETA · 온라인 모드 (Supabase)
   - 로그인: 마스터는 이메일, 운영관리자는 아이디(예: KFI26-S01) → 내부용 이메일로 바꿔 로그인
   - 쓰기: 화면에 먼저 반영 → 전송 대기열(이 기기에 보관) → 서버 · 실패하면 자동 재전송
   - 읽기: 처음에 전체를 불러오고, 이후에는 바뀐 것만 받아요
           (Realtime 변경 신호 + 주기 확인 · WebSocket이 막힌 곳에서도 3초마다 동기화)
   - 계정 관리(초대·재발급·중지·삭제)·초기화·영구 삭제는 서버 함수(admin-ops)에서만 처리
   의존: js/onsite-engine.js, js/onsite-store.js, vendor/supabase-*.js
   ===================================================================== */
(function(){
'use strict';
if(typeof STORE==='undefined'||STORE.mode!=='sb')return;

const EV=CONFIG.code;
const OUTBOX_KEY=uid=>STORE_KEY+':outbox:'+(uid||(AUTH.me&&AUTH.me.userId)||'anon');   // 사용자별 전송 대기열
const TIMEOUT_MS=20000;    // 응답 없는 요청은 20초 뒤 끊고 다시 시도
const POLL_FAST=3000;      // Realtime이 연결되지 않았을 때
const POLL_SLOW=30000;     // Realtime이 살아 있을 때(안전망)
const OVERLAP_MS=15000;    // 커밋 지연을 고려해 지난 15초는 다시 확인
const LOG_INIT=500;        // 마스터가 처음 불러오는 활동 로그 수

const lib=window.supabase;
if(!lib||!lib.createClient){
  STORE.fatal='온라인 모드 모듈을 불러오지 못했어요 · 인터넷 연결을 확인한 뒤 새로고침해 주세요';
  SYNC.state='error';
  return;
}
/* 약한 신호에서 요청이 끝없이 걸려 대기열·동기화가 멈추지 않도록 모든 요청에 제한시간을 둬요 */
function tfetch(input,init){
  init=init||{};const c=new AbortController();const t=setTimeout(()=>c.abort(),TIMEOUT_MS);const s=init.signal;
  if(s){if(s.aborted)c.abort();else s.addEventListener('abort',()=>c.abort(),{once:true});}
  return fetch(input,Object.assign({},init,{signal:c.signal})).finally(()=>clearTimeout(t));
}
const AUTH_STORAGE_KEY=`onsitebeta:v2:auth:${EV}:${STORE.app}`;
const sb=lib.createClient(CONFIG.SB_URL,CONFIG.SB_KEY,{
  auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,storageKey:AUTH_STORAGE_KEY},
  global:{fetch:tfetch},
  realtime:{params:{eventsPerSecond:20}},
});
STORE.sb=sb;

/* ---------- 공통 ---------- */
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const fmtTs=iso=>{if(!iso)return '';const d=new Date(iso);if(isNaN(d))return '';return `${pad(d.getMonth()+1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;};
const isEmpty=o=>!o||(typeof o==='object'&&!Array.isArray(o)&&!Object.keys(o).length);
/* 서버(jsonb)는 키 순서를 바꿔 돌려줘요 → 키 순서와 상관없이 비교 */
function canon(o){if(Array.isArray(o))return '['+o.map(canon).join(',')+']';if(o&&typeof o==='object')return '{'+Object.keys(o).sort().map(k=>JSON.stringify(k)+':'+canon(o[k])).join(',')+'}';return JSON.stringify(o===undefined?null:o);}
const same=(a,b)=>canon(a)===canon(b);
const notice=msg=>{try{if(typeof STORE.onNotice==='function')STORE.onNotice(msg);}catch(e){}};
/* 서버 시계와 이 기기 시계의 차이 · 수정 시각을 서버 기준으로 맞춰 기기마다 시계가 조금 달라도 순서가 꼬이지 않게 해요 */
const SKEW_KEY=`onsitebeta:v2:skew`;
let SKEW=(()=>{try{const v=+localStorage.getItem(SKEW_KEY);return isFinite(v)?v:0;}catch(e){return 0;}})();
const srvNow=()=>Date.now()+SKEW;
function learnSkew(serverIso,t0,t1){const sv=Date.parse(serverIso);if(!isFinite(sv)||t1-t0>5000)return;SKEW=Math.round(sv-(t0+t1)/2);try{localStorage.setItem(SKEW_KEY,String(SKEW));}catch(e){}}
const idToEmail=id=>{const s=String(id||'').trim();return s.includes('@')?s.toLowerCase():s.toLowerCase()+'@'+CONFIG.OP_EMAIL_DOMAIN;};
STORE.idToEmail=idToEmail;
function stripNulls(o){const r={};Object.keys(o||{}).forEach(k=>{if(o[k]!=null)r[k]=o[k];});return r;}
function errStatus(res){return res&&typeof res.status==='number'?res.status:0;}
function isNetErr(err,status){if(!status)return true;if(status>=500||status===408||status===429)return true;const m=String((err&&err.message)||'');return /Failed to fetch|NetworkError|network|timeout|Load failed|abort/i.test(m);}
const isRetryableAuth=e=>!!e&&(e.name==='AuthRetryableFetchError'||e.status===0||/fetch|network|abort|timeout/i.test(String(e.message||'')));
function authMsg(error){
  const code=error&&(error.code||'');const st=error&&error.status;const m=String((error&&error.message)||'');
  if(code==='invalid_credentials'||/Invalid login credentials/i.test(m))return '아이디 또는 비밀번호가 맞지 않아요';
  if(code==='user_banned'||/banned/i.test(m))return '사용 중지된 계정이에요 · 채용 담당자에게 문의해 주세요';
  if(st===429||code==='over_request_rate_limit'||/rate limit/i.test(m))return '로그인 시도가 많아요 · 1분 뒤에 다시 시도해 주세요';
  if(!st||/fetch|network/i.test(m))return '서버에 연결하지 못했어요 · 인터넷 연결을 확인해 주세요';
  return '로그인하지 못했어요 · 잠시 후 다시 시도해 주세요';
}

/* ---------- 서버 함수(admin-ops) ---------- */
async function callFn(action,body){
  try{
    const {data,error}=await sb.functions.invoke('admin-ops',{body:Object.assign({action},body||{})});
    if(error){
      try{const j=await error.context.json();if(j&&j.error)return {ok:false,error:j.error,message:j.message||'처리하지 못했어요'};}catch(e){}
      return {ok:false,error:'network',message:'서버에 연결하지 못했어요 · 잠시 후 다시 시도해 주세요'};
    }
    return data||{ok:false,error:'empty',message:'서버 응답이 없어요'};
  }catch(e){return {ok:false,error:'network',message:'서버에 연결하지 못했어요 · 잠시 후 다시 시도해 주세요'};}
}

/* ---------- 계정 ---------- */
function toMe(m){return m?{userId:m.user_id,id:m.login_id,eventCode:m.event_code,kind:m.kind,name:m.name,role:m.role||(m.kind==='master'?'마스터':''),phone:m.phone||'',mustChange:!!m.must_change,disabled:!!m.disabled}:null;}
function toAcc(m,temp){const a={name:m.name,role:m.role||'',phone:m.phone||'',mustChange:!!m.must_change,lastLogin:fmtTs(m.last_login),createdAt:fmtTs(m.created_at),kind:m.kind,userId:m.user_id};if(temp)a.temp=temp;if(m.disabled)a.disabled=true;return a;}
const AUTH={me:null,
  async loadMe(){
    const {data:{session}}=await sb.auth.getSession();if(!session)return null;
    const r=await sb.from('members').select('*').eq('user_id',session.user.id).maybeSingle();
    if(r.error)throw r.error;
    AUTH.me=toMe(r.data);return AUTH.me;
  },
  async signIn(loginId,pw){
    const email=idToEmail(loginId);
    const {data,error}=await sb.auth.signInWithPassword({email,password:pw});
    if(error)return {ok:false,message:authMsg(error)};
    let me=null,err=null;
    for(let i=0;i<2&&!me;i++){try{me=await AUTH.loadMe();err=null;if(!me)break;}catch(e){err=e;await sleep(800);}}
    const bad=async msg=>{await sb.auth.signOut({scope:'local'}).catch(()=>{});AUTH.me=null;return {ok:false,message:msg};};
    if(!me&&err)return bad('서버에 연결하지 못했어요 · 잠시 후 다시 로그인해 주세요');
    if(!me||me.eventCode!==EV)return bad('이 행사에 등록된 계정이 아니에요 · 채용 담당자에게 문의해 주세요');
    if(me.disabled)return bad('사용 중지된 계정이에요 · 채용 담당자에게 문의해 주세요');
    if(STORE.app==='master'&&me.kind!=='master')return bad('운영관리자 계정은 운영자 화면에서 로그인해 주세요');
    if(!me.mustChange)touchLogin();
    return {ok:true,me,mustChange:me.mustChange};
  },
  async changePassword(oldPw,newPw){
    const r=await callFn('change_password',{old_password:oldPw,new_password:newPw});
    if(r.ok&&AUTH.me){AUTH.me.mustChange=false;touchLogin();}
    return r;
  },
  /* discard=true: 사용자가 '그래도 로그아웃'을 고른 경우에만 이 기기에 남은 미전송 기록을 지워요.
     강제 로그아웃(중지·만료 등)에서는 기록을 남겨 두었다가 같은 계정으로 다시 로그인하면 이어서 보내요. */
  async signOut(opts){
    const uid=AUTH.me&&AUTH.me.userId;
    // 먼저 내 정보를 비워요: supabase-js 의 SIGNED_OUT 알림 안에서 다시 로그아웃을 부르면 잠금이 서로 기다려 멈춰요
    stopSync();AUTH.me=null;
    OUT.epoch++;OUT.q.length=0;STORE.pending=0;
    try{await sb.auth.signOut({scope:'local'});}catch(e){}
    try{localStorage.removeItem(STORE_KEY);if(opts&&opts.discard&&uid)localStorage.removeItem(OUTBOX_KEY(uid));}catch(e){}
    replaceDB(emptyDB());
  },
};
function touchLogin(){if(!AUTH.me)return;sb.from('members').update({last_login:new Date().toISOString()}).eq('user_id',AUTH.me.userId).then(()=>{},()=>{});}
STORE.auth=AUTH;

const ADMIN={
  async run(action,body){const r=await callFn(action,body);if(r.ok)await pull(true).catch(()=>{});return r;},
  createOp(o){return ADMIN.run('create_op',o);},
  resetOp(id){return ADMIN.run('reset_op',{id});},
  setDisabled(id,disabled){return ADMIN.run('set_disabled',{id,disabled:!!disabled});},
  deleteOp(id){return ADMIN.run('delete_op',{id});},
  setRole(id,role){return ADMIN.run('set_role',{id,role});},
  async resetEvent(){const r=await callFn('reset_event',{});if(r.ok){OUT.drop(op=>op.t!=='roster');await fullLoad().catch(()=>{});}return r;},
  async purgeEvent(){const r=await callFn('purge_event',{});if(r.ok){OUT.drop(()=>true);await fullLoad().catch(()=>{});}return r;},
};
STORE.admin=ADMIN;

/* ---------- 전송 대기열 ---------- */
const OUT={q:[],busy:false,timer:null,backoff:1000,epoch:0,ackAt:{},verify:true,blockedNoticeAt:0,
  load(){OUT.epoch++;OUT.verify=true;let q=[];try{q=JSON.parse(localStorage.getItem(OUTBOX_KEY())||'[]')||[];}catch(e){}OUT.q.length=0;q.forEach(o=>OUT.q.push(o));STORE.pending=OUT.q.length;},
  save(){if(!AUTH.me||RUN.blocked)return;try{localStorage.setItem(OUTBOX_KEY(),JSON.stringify(OUT.q));}catch(e){}const was=STORE.pending;STORE.pending=OUT.q.length;if(was!==STORE.pending&&(was===0||STORE.pending===0))fireDB();},
  /* 조건에 맞는 대기 항목을 제자리에서 지워요 (전송 중인 맨 앞 항목은 그대로) · 지운 개수 */
  drop(pred,head){let n=0;for(let i=OUT.q.length-1;i>=0;i--){if(OUT.busy&&i===0&&!head)continue;if(pred(OUT.q[i])){OUT.q.splice(i,1);n++;}}if(n)OUT.save();return n;},
  key(op){return op.t==='app'?'app:'+op.no:op.t==='kv'?'kv:'+op.table+':'+op.id:op.t==='roster'?'roster':null;},
  push(op){
    if(RUN.blocked){if(Date.now()-OUT.blockedNoticeAt>5000){OUT.blockedNoticeAt=Date.now();notice('이 계정은 다른 탭에서 이미 열려 있어요 · 이 탭의 기록은 저장되지 않아요 · 그 탭을 써 주세요');}return;}
    op.ep=CUR.resetAt||null;   // 어느 초기화 이후에 만든 기록인지 (초기화 전 기록이 나중에 되살아나지 않게)
    op.at=srvNow();            // 서버 기준 만든 시각
    // 같은 대상에 대한 대기 중 변경은 하나로 합쳐요 (맨 앞 항목은 전송 중일 수 있어 건드리지 않음)
    const start=OUT.busy?1:0;
    if(op.t==='app'){const i=OUT.q.findIndex((o,j)=>j>=start&&o.t==='app'&&o.no===op.no&&o.ep===op.ep);if(i>=0){OUT.q[i].patch=Object.assign({},OUT.q[i].patch,op.patch);OUT.q[i].ts=Object.assign({},OUT.q[i].ts||{},op.ts||{});OUT.save();OUT.kick();return;}}
    if(op.t==='kv'){const i=OUT.q.findIndex((o,j)=>j>=start&&o.t==='kv'&&o.table===op.table&&o.id===op.id);if(i>=0){OUT.q[i].data=op.data;OUT.save();OUT.kick();return;}}
    if(op.t==='roster'){const i=OUT.q.findIndex((o,j)=>j>=start&&o.t==='roster');if(i>=0){OUT.q[i].row=op.row;OUT.save();OUT.kick();return;}}
    OUT.q.push(op);OUT.save();OUT.kick();
  },
  kick(delay){clearTimeout(OUT.timer);OUT.timer=setTimeout(OUT.flush,delay==null?0:delay);},
  async flush(){
    if(OUT.busy||!AUTH.me||!RUN.on||RUN.blocked)return;OUT.busy=true;const ep=OUT.epoch;
    try{
      /* 다시 연결된 직후·처음에는 보내기 전에 서버의 초기화 시각을 확인해요 → 초기화 전에 쌓인 기록은 보내지 않아요 */
      if(OUT.verify&&OUT.q.some(o=>o.ep&&o.t!=='roster')){
        let r;try{r=await sb.from('events').select('reset_at').eq('code',EV).maybeSingle();}catch(e){r={error:e,status:0};}
        if(ep!==OUT.epoch)return;
        if(r.error){if(isNetErr(r.error,errStatus(r))){setNet(false);OUT.kick(OUT.backoff);OUT.backoff=Math.min(OUT.backoff*2,15000);return;}}
        else{const ra=r.data&&r.data.reset_at;if(ra){const n=OUT.drop(o=>isStale(o,ra),true);if(n){notice(`초기화 전에 보내지 못한 기록 ${n}건은 반영하지 않았어요`);CUR.since=null;setTimeout(()=>pull(true),0);}}}
      }
      OUT.verify=false;
      while(OUT.q.length){
        const op=OUT.q[0];const r=await send(op);
        if(ep!==OUT.epoch)return;            // 그사이 로그아웃·재로그인됨 → 다른 대기열을 건드리지 않아요
        if(r==='retry'){OUT.verify=true;setNet(false);OUT.kick(OUT.backoff);OUT.backoff=Math.min(OUT.backoff*2,15000);return;}
        const i=OUT.q.indexOf(op);if(i>=0)OUT.q.splice(i,1);
        const k=OUT.key(op);if(k)OUT.ackAt[k]=Date.now();
        OUT.save();OUT.backoff=1000;
        if(r==='denied'){checkMe();}
      }
      setNet(true);
    }finally{OUT.busy=false;}
  },
};
async function send(op){
  let res;
  try{
    if(op.t==='app')res=await sb.rpc('app_patch',{p_ev:EV,p_no:op.no,p_patch:op.patch,p_ts:op.ts||null});
    else if(op.t==='kv')res=await sb.from(op.table).upsert({event_code:EV,id:op.id,data:op.data},{onConflict:'event_code,id'});
    else if(op.t==='roster')res=await sb.from('roster').upsert(Object.assign({event_code:EV},op.row),{onConflict:'event_code'});
    else if(op.t==='log'){res=await sb.from('log').insert({event_code:EV,k:op.k,at:op.e.at,who:op.e.who,txt:op.e.txt});if(res.error&&res.error.code==='23505')res={error:null,status:201};}
    else return 'ok';
  }catch(e){return 'retry';}
  if(!res.error)return 'ok';
  const st=errStatus(res);
  if(st===401||/JWT/i.test(res.error.message||'')){const {error}=await sb.auth.refreshSession().catch(e=>({error:e}));if(!error)return 'retry';checkMe();return 'retry';}
  if(isNetErr(res.error,st))return 'retry';
  console.warn('[onsite] 전송 거부',op,res.error);
  if(st===403||res.error.code==='42501')return 'denied';
  return 'denied';
}

/* 마지막 초기화보다 먼저 만든 미전송 기록인가요? (만든 시각이 없으면 초기화 시각 표시로 판단) */
function isStale(o,ra){if(o.t==='roster')return false;const r=Date.parse(ra);if(o.at&&isFinite(r))return o.at<r;return !!(o.ep&&o.ep!==ra);}
/* 칸별 수정 시각 (서버 app_patch 가 칸마다 나중에 고친 값만 받아요) · 서버 시계 기준 */
function stampTs(patch){const t=srvNow();const r={};Object.keys(patch||{}).forEach(k=>{r[k]=t;});return r;}

/* ---------- 저장소 연결부 (js/onsite-store.js 의 STORE.remote) ---------- */
STORE.remote={
  put(path,val){
    const ks=String(path).split('/').filter(Boolean);
    if(ks[0]==='roster'){
      const row=val?{v:+val.v||Date.now(),file:val.file||null,at:val.at||null,by:val.by||null,labels:val.labels||{},rows:rosterRows(val)}:{v:Date.now(),file:null,at:null,by:null,labels:{},rows:[]};
      OUT.push({t:'roster',row});return;
    }
    if((ks[0]==='conduct'||ks[0]==='extra')&&ks.length===2){OUT.push({t:'kv',table:ks[0],id:ks[1],data:val==null?null:val});return;}
    if((ks[0]==='conduct'||ks[0]==='extra')&&ks.length>2){const cur=((DB[ks[0]]||{})[ks[1]])||null;OUT.push({t:'kv',table:ks[0],id:ks[1],data:cur});return;}
    if(ks[0]==='apps'&&ks[1]){
      if(ks.length===2){const cur=(DB.apps||{})[ks[1]]||{};const patch=Object.assign({},val||{});['status','device','inR','outR','fee','delay','note','ck'].forEach(k=>{if(!(k in patch))patch[k]=null;});delete patch._ts;const p=val==null?Object.fromEntries(Object.keys(cur).filter(k=>k!=='_ts').map(k=>[k,null])):patch;OUT.push({t:'app',no:ks[1],patch:p,ts:stampTs(p)});}
      else OUT.push({t:'app',no:ks[1],patch:{[ks[2]]:val==null?null:val},ts:stampTs({[ks[2]]:1})});
      return;
    }
    if(ks[0]==='log'&&ks[1]&&val){OUT.push({t:'log',k:ks[1],e:val});return;}
    if(ks[0]==='accounts'&&ks[ks.length-1]==='lastLogin'){touchLogin();return;}
    console.warn('[onsite] 온라인 모드에서 처리하지 않는 경로',path);
  },
  patchApp(no,patch){const p=Object.assign({},patch);delete p._ts;OUT.push({t:'app',no,patch:p,ts:stampTs(p)});},
  log(k,e){OUT.push({t:'log',k,e});},
  reset(){return ADMIN.resetEvent();},
};

/* ---------- 받아오기 ---------- */
const CUR={since:null,logAfter:0,rosterV:null,rosterU:null,resetAt:null};
const isMasterView=()=>STORE.app==='master'&&AUTH.me&&AUTH.me.kind==='master';
function pendingApp(no){let p=null;OUT.q.forEach(o=>{if(o.t==='app'&&o.no===no)p=Object.assign(p||{},o.patch);});return p;}
const pendingKv=(table,id)=>OUT.q.some(o=>o.t==='kv'&&o.table===table&&o.id===id);
const pendingRoster=()=>OUT.q.some(o=>o.t==='roster');
function rosterFromRow(r){if(!r)return null;const rows=Array.isArray(r.rows)?r.rows:[];if(!rows.length)return null;return {v:+r.v||1,file:r.file||'',at:r.at||'',by:r.by||'',labels:r.labels||{},rows};}
function accountsFrom(members,secrets){
  const temp={};(secrets||[]).forEach(s=>{temp[s.user_id]=s.temp_pw;});
  const ops={},masters={};
  (members||[]).forEach(m=>{(m.kind==='operator'?ops:masters)[m.login_id]=toAcc(m,temp[m.user_id]);});
  return {ops,masters};
}
let again=false;   // 동기화 중에 새 변경 신호가 오면 끝난 뒤 한 번 더
const ackedAfter=(k,started)=>(OUT.ackAt[k]||0)>started;
function applyApp(no,data,started){
  if(started&&ackedAfter('app:'+no,started)){again=true;return false;}
  let v=isEmpty(data)?null:data;const p=pendingApp(no);
  if(p)v=stripNulls(Object.assign({},v||{},p));
  const cur=(DB.apps||{})[no]||null;
  if(same(cur||null,isEmpty(v)?null:v))return false;
  remoteSet('apps/'+no,isEmpty(v)?null:v);return true;
}
function applyKv(table,id,data,started){
  if(pendingKv(table,id))return false;
  if(started&&ackedAfter('kv:'+table+':'+id,started)){again=true;return false;}
  const cur=(DB[table]||{})[id]||null;const v=data==null?null:data;
  if(same(cur,v))return false;remoteSet(table+'/'+id,v);return true;
}
function checkOwn(members){
  if(!AUTH.me)return;
  const mine=(members||[]).find(m=>m.user_id===AUTH.me.userId);
  if(!mine){kick('계정이 삭제되어 로그아웃됐어요 · 채용 담당자에게 확인해 주세요');return;}
  if(mine.disabled){kick('사용 중지된 계정이라 로그아웃됐어요 · 채용 담당자에게 확인해 주세요');return;}
  if(mine.must_change&&!AUTH.me.mustChange){kick('비밀번호가 재발급되어 로그아웃됐어요 · 새 안내를 확인해 주세요');return;}
  const me=toMe(mine);if(!same(me,AUTH.me)){AUTH.me=me;return true;}
}
let kicking=false;
async function kick(msg){
  if(kicking)return;kicking=true;
  try{await AUTH.signOut();}finally{kicking=false;}
  if(typeof STORE.onKicked==='function')STORE.onKicked(msg);
}
async function checkMe(){
  try{
    const r=await sb.from('members').select('*').eq('user_id',(AUTH.me||{}).userId||'00000000-0000-0000-0000-000000000000');
    if(!r.error)checkOwn(r.data);
  }catch(e){}
}

async function rpcPull(since,logAfter){
  const r=await sb.rpc('sync_pull',{p_ev:EV,p_since:since,p_log_after:logAfter});
  if(r.error){const e=new Error(r.error.message);e.status=errStatus(r);e.code=r.error.code;throw e;}
  return r.data||{};
}
async function fetchRoster(){
  const r=await sb.from('roster').select('*').eq('event_code',EV).maybeSingle();
  if(r.error)throw r.error;return r.data;
}
async function fullLoad(){
  const master=isMasterView();const started=Date.now();
  const t0=Date.now();
  const [d,ro,lg]=await Promise.all([
    rpcPull('1970-01-01T00:00:00Z',null).then(x=>{learnSkew(x.now,t0,Date.now());return x;}),
    fetchRoster(),
    master?sb.from('log').select('id,k,at,who,txt').eq('event_code',EV).order('id',{ascending:false}).limit(LOG_INIT):Promise.resolve({data:[]}),
  ]);
  if(lg.error)throw lg.error;
  const next=emptyDB();
  next.roster=rosterFromRow(ro);
  (d.apps||[]).forEach(a=>{if(!isEmpty(a.data))next.apps[a.no]=a.data;});
  (d.conduct||[]).forEach(c=>{if(c.data!=null)next.conduct[c.id]=c.data;});
  (d.extra||[]).forEach(c=>{if(c.data!=null)next.extra[c.id]=c.data;});
  (lg.data||[]).forEach(l=>{next.log[l.k]={at:l.at,who:l.who,txt:l.txt};});
  next.accounts=accountsFrom(d.members,d.secrets);
  next.resetAt=d.event&&d.event.reset_at;
  // 초기화 전에 만들어졌는데 아직 못 보낸 기록은 버려요 (초기화한 내용이 되살아나지 않게)
  const ra=d.event&&d.event.reset_at;
  if(ra){const n=OUT.drop(o=>isStale(o,ra),true);if(n)notice(`초기화 전에 보내지 못한 기록 ${n}건은 반영하지 않았어요`);}
  // 방금 서버가 받은 내 변경은 이 스냅숏보다 새로워요 → 지금 화면 값을 유지하고 한 번 더 받아요
  Object.keys(OUT.ackAt).forEach(k=>{if(OUT.ackAt[k]<=started)return;again=true;const [t,a,b]=k.split(':');
    if(t==='app'){const v=(DB.apps||{})[a];if(v)next.apps[a]=v;else delete next.apps[a];}
    else if(t==='kv'){const v=(DB[a]||{})[b];if(v!=null)next[a][b]=v;else delete next[a][b];}});
  // 아직 전송하지 않은 내 변경은 위에 다시 얹어요
  OUT.q.forEach(o=>{
    if(o.t==='app')next.apps[o.no]=stripNulls(Object.assign({},next.apps[o.no]||{},o.patch));
    else if(o.t==='kv'){if(o.data==null)delete next[o.table][o.id];else next[o.table][o.id]=o.data;}
    else if(o.t==='roster')next.roster=rosterFromRow(o.row);
    else if(o.t==='log')next.log[o.k]=o.e;
  });
  CUR.since=d.now;CUR.resetAt=d.event&&d.event.reset_at;CUR.rosterV=ro?ro.v:null;CUR.rosterU=ro?ro.updated_at:null;
  CUR.logAfter=(lg.data||[]).reduce((m,l)=>Math.max(m,+l.id||0),0);
  STORE.logsCapped=master&&(lg.data||[]).length>=LOG_INIT;
  checkOwn(d.members);
  if(!AUTH.me)return;
  replaceDB(next);
}
let pulling=null;
async function pull(force){
  if(!AUTH.me||!RUN.on)return;
  if(pulling){again=true;if(!force)return pulling.catch(()=>{});await pulling.catch(()=>{});if(pulling)return pulling.catch(()=>{});}
  const started=Date.now();
  pulling=(async()=>{
    if(!CUR.since){await fullLoad();return;}
    const since=new Date(Date.parse(CUR.since)-OVERLAP_MS).toISOString();
    const master=isMasterView();
    const t0=Date.now();const d=await rpcPull(since,master?Math.max(0,CUR.logAfter-50):null);learnSkew(d.now,t0,Date.now());
    if(d.event&&CUR.resetAt&&d.event.reset_at!==CUR.resetAt){await fullLoad();return;}
    let changed=false;
    if(d.roster&&(d.roster.v!==CUR.rosterV||d.roster.updated_at!==CUR.rosterU)&&!pendingRoster()&&!ackedAfter('roster',started)){
      const ro=await fetchRoster();CUR.rosterV=ro?ro.v:null;CUR.rosterU=ro?ro.updated_at:null;
      const next=rosterFromRow(ro);if(!same(next,DB.roster||null)){remoteSet('roster',next);changed=true;}
    }
    (d.apps||[]).forEach(a=>{if(applyApp(a.no,a.data,started))changed=true;});
    (d.conduct||[]).forEach(c=>{if(applyKv('conduct',c.id,c.data,started))changed=true;});
    (d.extra||[]).forEach(c=>{if(applyKv('extra',c.id,c.data,started))changed=true;});
    if(master)(d.log||[]).forEach(l=>{CUR.logAfter=Math.max(CUR.logAfter,+l.id||0);if(!DB.log||!DB.log[l.k]){remoteSet('log/'+l.k,{at:l.at,who:l.who,txt:l.txt});changed=true;}});
    const acc=accountsFrom(d.members,d.secrets);
    if(!same(acc,DB.accounts)){remoteSet('accounts',acc);changed=true;}
    if(checkOwn(d.members))changed=true;
    if(!AUTH.me)return;
    CUR.since=d.now;
    if(changed){saveLocal();fireDB();}
  })();
  try{await pulling;setNet(true);}
  catch(e){if(isNetErr(e,e.status))setNet(false);else if(e.status===401){await sb.auth.refreshSession().catch(()=>{});}else console.warn('[onsite] 동기화 오류',e);}
  finally{pulling=null;if(again&&RUN.on){again=false;setTimeout(()=>pull(),60);}}
}
STORE.pull=pull;
STORE.loadAllLogs=async function(){
  if(!isMasterView())return;
  const all=[];let from=0;
  for(;;){const r=await sb.from('log').select('id,k,at,who,txt').eq('event_code',EV).order('id',{ascending:false}).range(from,from+999);if(r.error)throw r.error;all.push(...r.data);if(r.data.length<1000)break;from+=1000;}
  all.forEach(l=>{if(!DB.log[l.k])remoteSet('log/'+l.k,{at:l.at,who:l.who,txt:l.txt});});
  saveLocal();
  return all.length;
};

/* ---------- 연결 상태 ---------- */
let rtLive=false;
function setNet(ok){
  const next=!ok?'error':(OUT.q.length&&!OUT.busy?'error':(rtLive?'live':'poll'));
  if(SYNC.state!==next){SYNC.state=next;fireDB();}
}

/* ---------- 실행 ---------- */
const RUN={on:false,timer:null,chan:null,blocked:false,release:null};
function schedule(){clearTimeout(RUN.timer);if(!RUN.on)return;RUN.timer=setTimeout(async()=>{try{await pull();}catch(e){}finally{OUT.kick();schedule();}},rtLive?POLL_SLOW:POLL_FAST);}
let deb=null;const soon=()=>{clearTimeout(deb);deb=setTimeout(()=>pull(),250);};
function subscribe(){
  try{
    const ch=sb.channel('onsite-'+EV);
    ['apps','conduct','extra','roster','members'].concat(isMasterView()?['log']:[]).forEach(t=>ch.on('postgres_changes',{event:'*',schema:'public',table:t,filter:`event_code=eq.${EV}`},soon));
    // 필터를 건 구독에는 삭제 이벤트가 오지 않아요 → 계정 삭제는 필터 없이 따로 받고, 내 계정일 때만 반응해요
    ch.on('postgres_changes',{event:'DELETE',schema:'public',table:'members'},p=>{const o=p&&p.old;if(o&&AUTH.me&&o.user_id===AUTH.me.userId)soon();});
    ch.on('postgres_changes',{event:'*',schema:'public',table:'events',filter:`code=eq.${EV}`},soon);
    ch.subscribe(st=>{
      const was=rtLive;rtLive=st==='SUBSCRIBED';
      if(rtLive&&!was){soon();}
      if(was!==rtLive){setNet(true);schedule();}
    });
    RUN.chan=ch;
  }catch(e){rtLive=false;}
}
/* 같은 계정을 여러 탭에서 열면 한 탭만 기록을 보내요 (전송 대기열이 서로 덮어쓰지 않게) · 잠금은 탭을 닫으면 풀려요 */
async function acquireTab(){
  if(!(navigator.locks&&navigator.locks.request)||!AUTH.me)return true;
  const name=`onsitebeta:sync:${EV}:${STORE.app}:${AUTH.me.userId}`;
  return new Promise(res=>{navigator.locks.request(name,{ifAvailable:true},lock=>{if(!lock){res(false);return;}res(true);return new Promise(r=>{RUN.release=r;});}).catch(()=>res(true));});
}
async function startSync(){
  if(RUN.on)return;RUN.on=true;
  RUN.blocked=!(await acquireTab());STORE.blocked=RUN.blocked;
  if(RUN.blocked)notice('이 계정은 다른 탭에서 이미 열려 있어요 · 이 탭은 보기만 되고 기록은 저장되지 않아요 · 그 탭을 써 주세요');
  if(typeof DB.resetAt==='string')CUR.resetAt=DB.resetAt;   // 오프라인으로 시작해도 마지막으로 본 초기화 시각을 기억
  OUT.load();
  SYNC.state='connecting';fireDB();
  try{await fullLoad();setNet(true);touchLogin();}catch(e){setNet(false);console.warn('[onsite] 처음 불러오기 실패',e);}
  subscribe();schedule();OUT.kick();
}
function stopSync(){
  RUN.on=false;clearTimeout(RUN.timer);clearTimeout(OUT.timer);
  if(RUN.release){try{RUN.release();}catch(e){}RUN.release=null;}RUN.blocked=false;STORE.blocked=false;
  if(RUN.chan){try{sb.removeChannel(RUN.chan);}catch(e){}RUN.chan=null;}
  rtLive=false;CUR.since=null;CUR.logAfter=0;CUR.rosterV=null;CUR.rosterU=null;CUR.resetAt=null;
}
/* 전자기기 보관번호를 서버에서 배정받아요 (동시에 접수해도 겹치지 않음) · 실패하면 null */
STORE.assignDevice=async function(no){
  if(!navigator.onLine||RUN.blocked||SYNC.state==='error')return null;     // 연결이 불안하면 바로 이 기기에서 배정
  try{
    const c=new AbortController();const t=setTimeout(()=>c.abort(),4000);
    const r=await sb.rpc('assign_device',{p_ev:EV,p_no:no}).abortSignal(c.signal);clearTimeout(t);
    if(r.error||r.data==null)return null;
    const d=String(r.data);const cur=Object.assign({},(DB.apps||{})[no]||{});
    OUT.ackAt['app:'+no]=Date.now();
    if(!cur.device){cur.device=d;remoteSet('apps/'+no,cur);saveLocal();fireDB();}
    return cur.device||d;
  }catch(e){return null;}
};
STORE.startSync=startSync;
STORE.stopSync=stopSync;
STORE.flush=()=>OUT.flush();
/* 대기 중인 전송이 끝날 때까지 최대 ms 기다려요 (로그아웃 전에 사용) · 끝나면 true */
STORE.flushWait=async function(ms){const t0=Date.now();OUT.kick();while(OUT.q.length&&Date.now()-t0<(ms||5000))await sleep(200);return OUT.q.length===0;};

/* 처음 열 때: 저장된 로그인 세션을 확인해요 */
function cachedMe(uid){
  if(!uid||!DB.accounts)return null;
  const hit=Object.entries(DB.accounts.ops||{}).concat(Object.entries(DB.accounts.masters||{})).find(([,a])=>a.userId===uid);
  if(!hit)return null;const [id,a]=hit;
  return {userId:uid,id,eventCode:EV,kind:a.kind,name:a.name,role:a.role||(a.kind==='master'?'마스터':''),phone:a.phone||'',mustChange:false,disabled:false};
}
function storedUserId(){try{const j=JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY)||'null');return (j&&j.user&&j.user.id)||(j&&j.currentSession&&j.currentSession.user&&j.currentSession.user.id)||null;}catch(e){return null;}}
STORE.boot=async function(){
  try{
    const cm=cachedMe(storedUserId());
    const gsP=sb.auth.getSession();
    // 저장된 화면이 있으면 3초까지만 기다리고 먼저 열어요 (오래 잠든 뒤 신호가 약할 때 토큰 갱신이 30초 넘게 걸릴 수 있어요)
    const gs=cm?await Promise.race([gsP,sleep(3000).then(()=>null)]):await gsP;
    if(gs===null){AUTH.me=cm;startSync();gsP.then(()=>{if(AUTH.me)pull(true);}).catch(()=>{});return {authed:true,me:cm,offline:true};}
    if(!gs.data.session){
      // 오래 잠들어 토큰이 만료됐는데 지금 연결이 안 되면: 저장된 세션·화면으로 시작하고 연결되면 이어서 동기화
      if(!navigator.onLine||isRetryableAuth(gs.error)){const m=cachedMe(storedUserId());if(m){AUTH.me=m;startSync();return {authed:true,me:m,offline:true};}}
      return {authed:false};
    }
    const me=await AUTH.loadMe();
    if(!me)return {authed:false};
    if(me.eventCode!==EV||me.disabled||me.mustChange||(STORE.app==='master'&&me.kind!=='master')){await sb.auth.signOut({scope:'local'}).catch(()=>{});AUTH.me=null;return {authed:false};}
    await startSync();
    return {authed:true,me};
  }catch(e){
    // 오프라인으로 열린 경우: 세션이 있으면 저장된 화면으로 시작하고 연결되면 동기화
    const m=cachedMe(storedUserId());
    if(m){AUTH.me=m;startSync();return {authed:true,me:m,offline:true};}
    return {authed:false,error:'서버에 연결하지 못했어요 · 인터넷 연결을 확인해 주세요'};
  }
};

// 이 콜백 안에서 supabase 함수를 바로 부르면 잠금 때문에 멈출 수 있어 다음 틱으로 미뤄요
sb.auth.onAuthStateChange((event)=>{
  if(event!=='SIGNED_OUT')return;
  setTimeout(()=>{if(AUTH.me&&!kicking)kick('로그인이 만료됐어요 · 다시 로그인해 주세요');},0);
});
window.addEventListener('online',()=>{OUT.verify=true;OUT.kick();pull();schedule();});
window.addEventListener('offline',()=>{OUT.verify=true;setNet(false);});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&RUN.on){pull();OUT.kick();schedule();}});
})();
