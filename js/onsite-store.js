/* =====================================================================
   ONSITE BETA · 데이터 저장 (마스터 PC · 운영관리자 휴대폰 공용)
   의존: js/onsite-engine.js (먼저 불러와요)

   모드
   - 로컬(local): CONFIG.SB_URL 이 비었거나 주소에 ?local=1 · 이 브라우저(localStorage)에만 저장
                  같은 브라우저의 다른 탭(마스터 ↔ 운영자 화면)과는 storage 이벤트로 실시간 연동
   - 온라인(sb):  CONFIG.SB_URL 이 있으면 · js/onsite-sb.js 가 STORE.remote 를 채워 서버와 주고받아요
                  localStorage 는 앱별(마스터/운영자) 임시 보관(캐시)으로만 써요 · 탭끼리 공유하지 않아요

   onsite-sb.js 와의 약속(seam)
   - STORE = {app, mode, remote, pending}
   - STORE.remote(온라인 모드에서만): put(path,val) · patchApp(no,patch) · log(k,entry) · reset() → Promise
   - 서버에서 받은 변경: remoteSet(path,val) 로 반영한 뒤 saveLocal() + fireDB()
   - 전체 스냅숏 교체: replaceDB(next)
   - 연결 상태: SYNC.state = 'live' | 'poll' | 'connecting' | 'error' | 'local' · 대기 건수 STORE.pending
   ===================================================================== */
const STORE={app:(window.ONSITE_APP||'master'),mode:(QS.get('local')==='1'||!CONFIG.SB_URL)?'local':'sb',remote:null,pending:0};
/* 로컬 모드: 마스터·운영자 탭이 같은 키를 공유 · 온라인 모드: 앱별 캐시 (같은 github.io 의 다른 저장소와 겹치지 않도록 v2 이름공간) */
let STORE_KEY=STORE.mode==='local'
  ?'onsitebeta:v2:local:'+CONFIG.code+':'+CONFIG.date
  :'onsitebeta:v2:sb:'+CONFIG.code+':'+CONFIG.date+':'+STORE.app;

function emptyDB(){return{apps:{},conduct:{},extra:{},log:{},accounts:{ops:{}},roster:null,resetAt:Date.now()};}
function normDB(v){const d=emptyDB();if(v&&typeof v==='object')Object.keys(d).forEach(k=>{if(v[k]!=null)d[k]=v[k];});if(!d.accounts||typeof d.accounts!=='object')d.accounts={};if(!d.accounts.ops)d.accounts.ops={};return d;}
function loadLocal(){try{return normDB(JSON.parse(localStorage.getItem(STORE_KEY)));}catch(e){return emptyDB();}}
function saveLocal(){try{localStorage.setItem(STORE_KEY,JSON.stringify(DB));}catch(e){}}
let DB=loadLocal();
const SYNC={on:STORE.mode==='sb',state:STORE.mode==='sb'?'connecting':'local',listeners:[]};

let builtV=-1;
function applyDB(){
  const v=DB.roster?(+DB.roster.v||1):0;if(v!==builtV){builtV=v;buildJ();}
  J.roster.forEach(r=>{const a=J.apps[r.no];const d=(DB.apps||{})[r.no]||{};
    a.status=CONFIG.statuses.includes(d.status)?d.status:'';a.device=d.device==null?'':String(d.device);a.inR=!!d.inR;a.outR=!!d.outR;a.fee=!!d.fee;a.delay=+d.delay||0;a.note=d.note||'';a.ck=d.ck||null;a.sex=d.sex==='남'||d.sex==='여'?d.sex:'';});
}
function setIn(o,path,val){
  const ks=String(path).split('/').filter(Boolean);let c=o;
  for(let i=0;i<ks.length-1;i++){if(c[ks[i]]==null||typeof c[ks[i]]!=='object')c[ks[i]]={};c=c[ks[i]];}
  const k=ks[ks.length-1];if(val==null)delete c[k];else c[k]=val;
}
function onDB(fn){SYNC.listeners.push(fn);}
function fireDB(){applyDB();SYNC.listeners.forEach(f=>{try{f();}catch(e){console.error(e);}});}

/* ---------- 쓰기 (화면에 먼저 반영 → 온라인 모드면 서버로) ----------
   STORE.blocked: 같은 계정이 다른 탭에서 기록 중 → 이 탭은 바꾸지 않아요 (저장되지 않는 변경이 화면에만 남지 않게) */
function dbSet(path,val){if(STORE.blocked)return false;setIn(DB,path,val);saveLocal();applyDB();if(STORE.remote)STORE.remote.put(path,val);return true;}
/* 지원자 기록 병합 · patch 의 null 은 그 항목 삭제 · 서버에는 null 을 포함한 patch 그대로 보내요 */
function setApp(no,patch,who,txt){
  if(STORE.blocked)return false;
  const cur=Object.assign({},(DB.apps||{})[no]||{},patch);Object.keys(cur).forEach(k=>{if(cur[k]==null)delete cur[k];});
  setIn(DB,'apps/'+no,cur);saveLocal();applyDB();
  if(STORE.remote)STORE.remote.patchApp(no,patch);
  if(txt)addLog(who,txt);
  return true;
}
function addLog(who,txt){
  if(STORE.blocked)return false;
  const k=Date.now().toString(36)+Math.random().toString(36).slice(2,6);const e={at:stamp(),who,txt};
  setIn(DB,'log/'+k,e);saveLocal();applyDB();
  if(STORE.remote)STORE.remote.log(k,e);
  return true;
}
/* 현장 기록만 초기화 · 시간표와 계정은 유지 · 온라인 모드는 서버 함수가 처리 */
function dbReset(){
  if(STORE.remote)return STORE.remote.reset();
  const keepA=DB.accounts,keepR=DB.roster;DB=emptyDB();DB.accounts=keepA||{ops:{}};DB.roster=keepR||null;saveLocal();applyDB();
  return Promise.resolve();
}
/* 서버에서 받은 변경 반영용 (onsite-sb.js 가 호출 → 이어서 saveLocal()+fireDB()) */
function remoteSet(path,val){setIn(DB,path,val);}
/* 전체 스냅숏 교체 */
function replaceDB(next){DB=normDB(next);saveLocal();fireDB();}

/* 비상 로컬 모드: 이 PC에 남아 있는 마지막 온라인 화면(시간표·현장 기록)을 로컬로 가져와요 */
function onlineCacheKey(){return 'onsitebeta:v2:sb:'+CONFIG.code+':'+CONFIG.date+':'+STORE.app;}
function onlineCacheInfo(){if(STORE.mode!=='local')return null;try{const d=JSON.parse(localStorage.getItem(onlineCacheKey())||'null');if(!d||!d.roster||!rosterRows(d.roster).length)return null;return {n:rosterRows(d.roster).length,file:d.roster.file||'',at:d.roster.at||''};}catch(e){return null;}}
function importOnlineCache(){
  try{const d=JSON.parse(localStorage.getItem(onlineCacheKey())||'null');if(!d||!d.roster)return false;
    const next=normDB({apps:d.apps||{},conduct:d.conduct||{},extra:d.extra||{},log:d.log||{},roster:d.roster,accounts:{ops:{}}});
    next.roster=Object.assign({},next.roster,{v:Date.now()});
    DB=next;saveLocal();fireDB();return true;}catch(e){return false;}
}
function logList(){return Object.entries(DB.log||{}).map(([k,v])=>Object.assign({k},v)).sort((a,b)=>a.k<b.k?1:-1);}
function syncLabel(){
  if(STORE.blocked)return['다른 탭에서 사용 중 · 이 탭은 저장 안 됨','err'];
  switch(SYNC.state){
    case 'live':return['실시간 연결됨','ok'];
    case 'poll':return['연결됨 · 주기 동기화','ok'];
    case 'connecting':return['연결 중',''];
    case 'error':return['연결 끊김 · 이 기기에 임시 저장'+(STORE.pending?` (${STORE.pending}건 대기)`:''),'err'];
    default:return['로컬 모드 · 이 브라우저에만 저장','mute'];
  }
}

/* ---------- 계정 (이전 방식 호환용 · 온라인 모드의 계정은 서버에서 관리) ---------- */
async function hashPw(id,pw){const b=new TextEncoder().encode(String(id).trim().toLowerCase()+'|'+pw+'|onsite-beta');
  if(window.crypto&&crypto.subtle){const h=await crypto.subtle.digest('SHA-256',b);return [...new Uint8Array(h)].map(x=>x.toString(16).padStart(2,'0')).join('');}
  let h=hash(String.fromCharCode(...b));for(let i=0;i<500;i++)h=hash(h+'|'+pw);return 'f'+h.toString(16);}
const opAcc=id=>((DB.accounts||{}).ops||{})[id]||null;
const opList=()=>Object.entries((DB.accounts||{}).ops||{}).map(([id,a])=>Object.assign({id},a)).sort((a,b)=>a.id<b.id?-1:1);

/* 같은 브라우저 다른 탭 (로컬 모드에서만 · 온라인 모드의 캐시는 앱별이라 공유하지 않아요) */
if(STORE.mode==='local')window.addEventListener('storage',e=>{if(e.key===STORE_KEY){DB=loadLocal();fireDB();}});

applyDB();
