/* =====================================================================
   ONSITE BETA · 공통 엔진 (마스터 PC · 운영관리자 휴대폰 공용)
   - 설정(CONFIG) · 유틸 · 시계 · 시간표 계산 · 엑셀/CSV 읽기 · 시간표 링크 토큰 · 행동 강령
   - 저장·동기화는 js/onsite-store.js (이 파일 다음에 불러와요) · DB 는 그 파일에 있어요
   - 이 파일에는 개인정보·비밀번호·서비스 키를 넣지 않아요 (시간표는 마스터 화면에서 엑셀로 올려요)
   불러오는 순서: <script>window.ONSITE_APP='master'|'operator'</script>
                 → js/onsite-engine.js → js/onsite-store.js → (온라인 모드) vendor/supabase-*.js, js/onsite-sb.js → 화면 스크립트
   ===================================================================== */
const CONFIG={
  title:'2026년 한국소방산업기술원 채용 1차면접(실기) 전형',
  org:'한국소방산업기술원',
  date:'2026.11.11', dow:'수',
  code:'KFI26',
  /* 면접 장소 · 운영자 화면 '마이' 탭에 보여요 (비우면 숨김) */
  place:'',
  /* 앞 조가 늦어지면 다음 조와 최소 몇 분 간격을 두고 밀릴지 (점심처럼 긴 빈 시간은 지연을 흡수해요) */
  bufferMin:5,
  useDevice:true, useFee:true,
  statuses:['','접수예정','접수','연락중','불참'],
  /* 시간표 링크가 가리킬 운영자 화면 주소 · 두 파일을 다른 곳에 올리면 넣어 주세요
     예) 'https://wombat20.github.io/onsitebeta/beta-operator.html' · 비워 두면 같은 폴더의 beta-operator.html */
  operatorUrl:'',
  /* 온라인 모드(Supabase) · SB_URL 을 비우면 로컬 모드(이 브라우저에만 저장)로 동작해요
     주소 뒤에 ?local=1 을 붙이면 SB_URL 이 있어도 로컬 모드로 열려요
     SB_KEY 는 브라우저용 공개 키(publishable)예요 · service_role 같은 비밀 키는 절대 넣지 마세요 */
  SB_URL:'https://pptxgvkbgzasygdryxkw.supabase.co',
  SB_KEY:'sb_publishable_hJz2LkwR9sicQPe7J3v89Q_Nxxixoif',
  /* 운영관리자 아이디(예: KFI26-S01)를 로그인용 내부 이메일로 바꿀 때 쓰는 도메인 */
  OP_EMAIL_DOMAIN:'ops.onsitebeta.app'
};

/* ---------- 유틸 ---------- */
const pad=n=>String(n).padStart(2,'0');
const T=s=>{if(!s)return 0;const[a,b]=String(s).split(':').map(Number);return a*60+b;};
const HM=m=>pad(Math.floor(m/60))+':'+pad(((m%60)+60)%60);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const hash=s=>{let h=2166136261;for(const c of String(s))h=Math.imul(h^c.charCodeAt(0),16777619)>>>0;return h;};
const sum=a=>a.reduce((x,y)=>x+y,0);
const natCmp=(a,b)=>String(a).localeCompare(String(b),'ko',{numeric:true});

/* ---------- 시각 (실제 시계 · 테스트용 ?t=13:15 고정 가능) ---------- */
const QS=new URLSearchParams(location.search);
/* 자동 테스트 전용: ?ev=TEST 로 테스트 행사에 연결해요 (실제 행사와 데이터가 분리돼 있고, 접근은 서버가 계정별로 막아요) */
if(/^TEST[A-Z0-9-]{0,20}$/.test(QS.get('ev')||''))CONFIG.code=QS.get('ev');
let FIXED=(QS.get('t')&&/^\d{1,2}:\d{2}$/.test(QS.get('t')))?T(QS.get('t')):null;
function nowMin(){if(FIXED!=null)return FIXED;const d=new Date();return d.getHours()*60+d.getMinutes();}
function shiftClock(d){if(FIXED==null)return;FIXED=Math.max(T('07:00'),Math.min(T('20:00'),FIXED+d));}
function todayStr(){const d=new Date();return `${d.getFullYear()}.${pad(d.getMonth()+1)}.${pad(d.getDate())}`;}
const isEventDay=()=>todayStr()===CONFIG.date;
function stamp(){const d=new Date();return `${pad(d.getMonth()+1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;}
const DATE_LABEL=`${CONFIG.date}(${CONFIG.dow})`;

/* =====================================================================
   시간표 (업로드한 엑셀 기준)
   행: {no,name,field,phone,phone2,room,day,grp,ino,arrive,prepMove,prepStart,roomMove,start,end}
   ===================================================================== */
const STEP_LABEL={prepMove:'준비실 이동',prepStart:'준비 시작',roomMove:'면접실 이동'};
function blankApp(){return{status:'',device:'',inR:false,outR:false,fee:false,delay:0,note:'',ck:null,sex:''};}
const J={name:CONFIG.title,org:CONFIG.org,ready:false,v:0,file:'',labels:{},roster:[],byNo:{},apps:{},arrive:{},sched:{rooms:[]}};
let CONDUCT_BASE=[];
const shortField=f=>{const p=String(f||'').split('_');return p[p.length-1]||f||'';};
const stepLabel=(k,room)=>((J.labels[k]||{})[room])||STEP_LABEL[k];
function rosterRows(r){if(!r||!r.rows)return[];const rows=Array.isArray(r.rows)?r.rows:Object.keys(r.rows).sort((a,b)=>a-b).map(k=>r.rows[k]);return rows.filter(Boolean);}
function buildJ(){
  const R0=(typeof DB!=='undefined'&&DB.roster)||null;const rows=rosterRows(R0);
  J.ready=rows.length>0;J.v=R0?+R0.v||0:0;J.file=R0?R0.file||'':'';J.labels=(R0&&R0.labels)||{};
  J.roster=rows.map(x=>Object.assign({},x));J.byNo={};J.arrive={};
  const apps={};J.roster.forEach(r=>{J.byNo[r.no]=r;apps[r.no]=J.apps[r.no]||blankApp();J.arrive[r.no]=r.arrive||HM(T(r.start)-40);});J.apps=apps;
  const rooms={};
  J.roster.forEach(r=>{const rm=rooms[r.room]||(rooms[r.room]={name:r.room,items:{}});
    const solo=!r.grp||r.grp==='-';const key=solo?'p:'+r.no:'g:'+r.grp+'@'+r.start;
    const it=rm.items[key]||(rm.items[key]={kind:'s',id:'s'+hash(r.room+'|'+key).toString(36),grp:solo?'':r.grp,label:solo?(r['ino']||r.no):`${r.grp}조`,
      members:[],ps:T(r.start),pe:T(r.end),steps:{prepMove:r.prepMove,prepStart:r.prepStart,roomMove:r.roomMove},field:r.field});
    it.members.push(r.no);});
  J.sched.rooms=Object.values(rooms).sort((a,b)=>natCmp(a.name,b.name)).map(rm=>({name:rm.name,items:Object.values(rm.items).sort((a,b)=>a.ps-b.ps||natCmp(a.label,b.label))}));
  CONDUCT_BASE=[];
  if(J.ready){
    const first=Math.min(...Object.values(J.arrive).map(T));
    CONDUCT_BASE.push({id:'c-open',t:HM(first-10),txt:'지원자 접수 시작 · 신분증 확인',who:'접수'});
    J.sched.rooms.forEach(rm=>rm.items.forEach(it=>{
      if(it.steps.prepMove)CONDUCT_BASE.push({id:`c-${it.id}-pm`,t:it.steps.prepMove,txt:`${rm.name} · ${it.label} ${stepLabel('prepMove',rm.name)} 안내`.replace('안내 안내','안내'),who:'인솔'});
      if(it.steps.roomMove)CONDUCT_BASE.push({id:`c-${it.id}-rm`,t:it.steps.roomMove,txt:`${rm.name} · ${it.label} 면접실 이동 안내`,who:'인솔'});
      CONDUCT_BASE.push({id:`c-${it.id}-out`,t:HM(it.pe),txt:`${rm.name} · ${it.label} 퇴실 안내 · 전자기기 반환`,who:'접수'});
    }));
  }
}
/* 실제 진행 계산: 불참이면 조 시간 비례 단축 · DELAY 는 이후 일정으로 전파 · 긴 빈 시간(점심 등)은 지연을 흡수 */
function timeline(room,actual){
  const out=[];let prevE=null,prevPE=null;
  room.items.forEach(it=>{
    const n=it.members.length;const planLen=it.pe-it.ps;
    const attend=actual?it.members.filter(no=>A(no).status!=='불참').length:n;
    const len=actual?Math.round(planLen*attend/(n||1)):planLen;
    let s=it.ps;
    if(actual&&prevE!=null){const gap=Math.max(0,it.ps-prevPE);s=Math.max(it.ps,prevE+Math.min(gap,CONFIG.bufferMin));}
    const delay=actual?sum(it.members.map(no=>+A(no).delay||0)):0;
    const e=s+len+delay;
    if(prevPE!=null&&it.ps-prevPE>=30)out.push({kind:'gap',s:actual&&prevE!=null?prevE:prevPE,e:s});
    out.push({kind:'s',it,members:it.members,s,e,len,planLen,delay,attend,label:it.label,shift:s-it.ps,field:it.field});
    prevE=Math.max(prevE??0,e);prevPE=it.pe;
  });
  return out;
}
const sessions=(room,actual)=>timeline(room,actual).filter(x=>x.kind==='s');
const stepAt=(x,k)=>x.it.steps[k]?HM(T(x.it.steps[k])+Math.max(0,x.shift)):'';
function roomDelay(room){const L=sessions(room,true);const last=L[L.length-1];return last?last.e-last.it.pe:0;}

/* ---------- 엑셀·CSV 읽기 ---------- */
const COLMAP=[['no',/^수험번호/],['room',/^면접실$|^실$|^면접장/],['day',/^일차/],['grp',/^조구분|^조$/],['ino',/^면접번호/],['arrive',/^집결|^도착/],
  ['prepMove',/^준비실이동/],['prepStart',/^준비시작/],['roomMove',/^면접실이동/],['start',/^면접시작|^시작/],['end',/^면접종료|^종료/],
  ['name',/^이름|^성명/],['field',/^모집분야|^지원분야|^분야/],['phone',/^연락처|^휴대폰|^전화/],['phone2',/^비상연락처/]];
const REQ_COLS={no:'수험번호',name:'이름',room:'면접실',start:'면접시작',end:'면접종료'};
function toHM(v){
  if(v==null||v==='')return '';
  if(v instanceof Date)return HM(v.getHours()*60+v.getMinutes());
  if(typeof v==='number'){const f=v-Math.floor(v);return HM(Math.round(f*1440)%1440);}
  const s=String(v).trim();let m=s.match(/^(오전|오후|AM|PM)?\s*(\d{1,2})[:시]\s*(\d{1,2})/i);
  if(m){let h=+m[2];const mm=+m[3];if(/오후|PM/i.test(m[1]||'')&&h<12)h+=12;if(/오전|AM/i.test(m[1]||'')&&h===12)h=0;if(h<24&&mm<60)return HM(h*60+mm);}
  return null;
}
/* table: 2차원 배열(셀 병합은 미리 채움) → {rows, errors, warns, labels, stats} */
function parseTimetable(table){
  const errors=[],warns=[];const norm=h=>String(h??'').replace(/\s+/g,'');
  let hi=-1;for(let i=0;i<Math.min(table.length,15);i++){const r=(table[i]||[]).map(norm);if(r.some(c=>/^수험번호/.test(c))&&r.some(c=>/^(면접시작|시작)/.test(c))){hi=i;break;}}
  if(hi<0)return{rows:[],errors:['머리글 행을 찾지 못했어요 · 샘플 양식처럼 첫 줄 근처에 "수험번호", "면접시작" 열이 있어야 해요'],warns,labels:{}};
  const head=table[hi].map(norm);const idx={};const labels={};
  head.forEach((h,i)=>{const base=h.split('(')[0];const hit=COLMAP.find(([k,re])=>re.test(base));if(hit&&idx[hit[0]]==null)idx[hit[0]]=i;
    const raw=String(table[hi][i]??'');const pm=raw.match(/\(([^)]+?):\s*([^)]+)\)/);if(hit&&pm&&STEP_LABEL[hit[0]]){(labels[hit[0]]=labels[hit[0]]||{})[pm[1].trim()]=pm[2].trim();}});
  const miss=Object.keys(REQ_COLS).filter(k=>idx[k]==null);
  if(miss.length)return{rows:[],errors:[`필수 열이 없어요: ${miss.map(k=>REQ_COLS[k]).join(', ')}`],warns,labels};
  const rows=[];const seen={};let lastRoom='',lastDay='';
  for(let i=hi+1;i<table.length;i++){
    const c=table[i]||[];const g=k=>idx[k]==null?'':c[idx[k]];const s=k=>String(g(k)??'').trim();
    if(!s('no')&&!s('name'))continue;
    const ln=i+1;const r={no:s('no'),name:s('name'),room:s('room')||lastRoom,day:s('day')||lastDay,grp:s('grp'),ino:s('ino'),field:s('field'),phone:s('phone'),phone2:s('phone2')};
    lastRoom=r.room;lastDay=r.day;
    if(!r.no){errors.push(`${ln}행 · 수험번호 없음`);continue;}
    if(!r.name)errors.push(`${ln}행 · ${r.no} 이름 없음`);
    if(!r.room)errors.push(`${ln}행 · ${r.no} 면접실 없음`);
    let bad=false;['arrive','prepMove','prepStart','roomMove','start','end'].forEach(k=>{const t=toHM(g(k));if(t===null){bad=true;errors.push(`${ln}행 · ${r.no} ${k==='start'?'면접시작':k==='end'?'면접종료':'시각'} 형식 오류 (${String(g(k)).slice(0,12)})`);}r[k]=t||'';});
    if(!bad){if(!r.start||!r.end)errors.push(`${ln}행 · ${r.no} 면접시작·종료 시각 없음`);else if(T(r.end)<=T(r.start))errors.push(`${ln}행 · ${r.no} 종료가 시작보다 빨라요`);}
    if(seen[r.no]){errors.push(`${ln}행 · 수험번호 ${r.no} 중복 (${seen[r.no]}행)`);continue;}
    seen[r.no]=ln;rows.push(r);
  }
  if(!rows.length&&!errors.length)errors.push('지원자 행이 없어요');
  /* 조구분이 빈 칸인데 바로 위 사람과 면접실·일차·면접 시각이 같으면 같은 조예요
     (조구분을 셀 병합한 엑셀을 CSV로 저장하면 아래 칸이 비어요 · 한 면접실에서 같은 시각에 따로 면접할 수는 없어요) */
  let prevR=null,filled=0;
  rows.forEach(r=>{if(!r.grp&&prevR&&prevR.grp&&prevR.grp!=='-'&&prevR.room===r.room&&prevR.day===r.day&&prevR.start===r.start&&prevR.end===r.end){r.grp=prevR.grp;filled++;}prevR=r;});
  if(filled)warns.push(`조구분이 빈 칸인 ${filled}명은 바로 위 사람과 면접실·면접 시각이 같아 같은 조로 넣었어요`);
  /* 같은 면접실에서 서로 다른 면접의 시간이 겹치면 알려줘요 (겹치면 뒤 면접이 자동으로 밀려 '지연'처럼 보여요) */
  const byRoom={};rows.forEach(r=>{if(!r.start||!r.end)return;const solo=!r.grp||r.grp==='-';const key=solo?'p:'+r.no:'g:'+r.grp+'@'+r.start;
    const rk=r.room+'|'+r.day;const m=(byRoom[rk]=byRoom[rk]||{});if(!m[key])m[key]={room:r.room,s:T(r.start),e:T(r.end),who:r.grp&&r.grp!=='-'?r.grp+'조':r.no};});
  const over=[];Object.values(byRoom).forEach(m=>{const L=Object.values(m).sort((a,b)=>a.s-b.s||a.e-b.e);let last=null;
    L.forEach(x=>{if(last&&x.s<last.e)over.push(`${x.room} ${HM(last.s)}–${HM(last.e)}(${last.who})와 ${HM(x.s)}–${HM(x.e)}(${x.who})`);if(!last||x.e>last.e)last=x;});});
  if(over.length)warns.push(`같은 면접실에서 면접 시간이 겹쳐요 ${over.length}건 · 조구분과 시각을 확인해 주세요 (그대로 쓰면 뒤 면접이 자동으로 밀려요) · ${over.slice(0,3).join(' · ')}${over.length>3?` 외 ${over.length-3}건`:''}`);
  const days=[...new Set(rows.map(r=>r.day).filter(Boolean))];if(days.length>1)warns.push(`일차가 ${days.length}개(${days.join(', ')})예요 · 이번 베타는 하루 운영 기준이라 전부 같은 날로 보여요`);
  const g={};rows.forEach(r=>{if(r.grp&&r.grp!=='-'){const k=r.room+'|'+r.grp;(g[k]=g[k]||[]).push(r);}});
  Object.values(g).forEach(L=>{const t=new Set(L.map(r=>r.start+'-'+r.end));if(t.size>1)warns.push(`${L[0].room} ${L[0].grp}조 안에 면접 시각이 서로 달라요 · 시각별로 나눠서 보여요`);});
  rows.forEach(r=>{if(!r.arrive)r.arrive=HM(T(r.start)-40);});
  if(rows.some(r=>!r.phone))warns.push(`연락처 없는 지원자 ${rows.filter(r=>!r.phone).length}명`);
  const rooms=[...new Set(rows.map(r=>r.room))].sort(natCmp);
  const allT=rows.flatMap(r=>[T(r.arrive),T(r.end)]);
  return{rows,errors,warns,labels,stats:{n:rows.length,rooms,from:rows.length?HM(Math.min(...allT)):'',to:rows.length?HM(Math.max(...allT)):''}};
}
function parseCSV(text){
  const rows=[];let row=[],cell='',q=false;
  for(let i=0;i<text.length;i++){const c=text[i];
    if(q){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else q=false;}else cell+=c;}
    else if(c==='"')q=true;else if(c===','){row.push(cell);cell='';}else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';}else cell+=c;}
  if(cell!==''||row.length){row.push(cell);rows.push(row);}
  return rows;
}
/* 엑셀 시트 → 2차원 배열 (병합된 칸은 왼쪽 위 값으로 채움) · X 는 SheetJS(XLSX) */
function sheetTable(X,ws){
  (ws['!merges']||[]).forEach(m=>{const tl=ws[X.utils.encode_cell(m.s)];if(!tl)return;for(let r=m.s.r;r<=m.e.r;r++)for(let c=m.s.c;c<=m.e.c;c++){if(r===m.s.r&&c===m.s.c)continue;ws[X.utils.encode_cell({r,c})]={t:tl.t,v:tl.v,w:tl.w};}});
  return X.utils.sheet_to_json(ws,{header:1,raw:true,defval:''});
}


/* ---------- 시간표 링크 토큰 (압축 · # 뒤에 실어 보냄) ---------- */
const TT_KEYS=['no','name','field','phone','phone2','room','day','grp','ino','arrive','prepMove','prepStart','roomMove','start','end'];
const u8b64=u=>{let s='';for(let i=0;i<u.length;i+=0x8000)s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');};
const b64u8=s=>{const b=atob(s.replace(/-/g,'+').replace(/_/g,'/'));const u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u;};
async function streamBytes(u,ctor,fmt){const st=new Blob([u]).stream().pipeThrough(new ctor(fmt));return new Uint8Array(await new Response(st).arrayBuffer());}
async function rosterToken(R0){
  const rows=rosterRows(R0);const fields=[...new Set(rows.map(r=>r.field||''))];
  const obj={v:R0.v,f:R0.file||'',l:R0.labels||{},d:fields,r:rows.map(r=>TT_KEYS.map(k=>k==='field'?fields.indexOf(r.field||''):(r[k]||'')))};
  const raw=new TextEncoder().encode(JSON.stringify(obj));
  if(window.CompressionStream){try{return 'z'+u8b64(await streamBytes(raw,CompressionStream,'deflate-raw'));}catch(e){}}
  return 'u'+u8b64(raw);
}
async function rosterFromToken(tok){
  let u=b64u8(tok.slice(1));
  if(tok[0]==='z'){if(!window.DecompressionStream)throw new Error('old-browser');u=await streamBytes(u,DecompressionStream,'deflate-raw');}
  const o=JSON.parse(new TextDecoder().decode(u));
  return{v:o.v,file:o.f,labels:o.l||{},rows:o.r.map(a=>{const r={};TT_KEYS.forEach((k,i)=>r[k]=k==='field'?(o.d[a[i]]||''):a[i]);return r;})};
}

/* ---------- 계정 공용 (비밀번호 규칙 · 임시 비밀번호) ---------- */
function genPw(){const c='abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';let p='';const r=new Uint32Array(8);(window.crypto||{getRandomValues:a=>a.map(()=>Math.random()*1e9)}).getRandomValues(r);r.forEach(v=>p+=c[v%c.length]);return p.slice(0,4)+'-'+p.slice(4);}
function pwRule(pw,old){if(!pw||pw.length<8)return '8자 이상 입력해 주세요';if(!/[A-Za-z]/.test(pw)||!/[0-9]/.test(pw))return '영문과 숫자를 함께 넣어 주세요';if(old&&pw===old)return '처음 받은 비밀번호와 다르게 정해 주세요';return '';}
const b64e=o=>btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const b64d=s=>JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g,'+').replace(/_/g,'/')))));
const OP_ROLES=['접수','인솔','상주'];

/* ---------- 공통 조회 ---------- */
const R=()=>J.roster;
const A=no=>J.apps[no]||(J.apps[no]=blankApp());
const P=no=>J.byNo[no]||{no,name:'',field:'',phone:''};
const INO=no=>(J.byNo[no]||{})['ino']||no;

/* ---------- 행동 강령 ---------- */
/* 미도착 확인 (자동) · 집결 시각 5분 전부터, 아직 접수되지 않은 지원자가 있는 조마다 하나씩 생겨요
   접수(또는 불참 처리)되면 목록에서 빠지고, 모두 도착하면 항목이 사라져요 · 체크하면 완료로 남아요 */
const MISS_BEFORE=5;
function missConduct(now){
  const out=[];if(!J.ready)return out;
  J.sched.rooms.forEach(rm=>rm.items.forEach(it=>{
    const by={};it.members.forEach(no=>{const t=J.arrive[no];if(t)(by[t]=by[t]||[]).push(no);});
    Object.keys(by).forEach(t=>{
      if(now<T(t)-MISS_BEFORE)return;
      const miss=by[t].filter(no=>{const s=A(no).status;return s!=='접수'&&s!=='불참';});
      if(!miss.length)return;
      out.push({id:`c-${it.id}-arr${t.replace(':','')}`,t,kind:'miss',who:'접수',nos:miss,
        txt:`${rm.name} · ${it.label} 미도착 ${miss.length}명: ${miss.map(no=>P(no).name).join(', ')} · 연락 필요`});
    });
  }));
  return out;
}
function conductList(now){
  const extra=Object.entries(DB.extra||{}).map(([id,c])=>Object.assign({id,extra:true},c));
  return CONDUCT_BASE.concat(extra,missConduct(now==null?nowMin():now)).map(c=>{const d=(DB.conduct||{})[c.id];return Object.assign({},c,{done:!!(d&&d.done),at:d&&d.at,by:d&&d.by});})
    .sort((a,b)=>T(a.t)-T(b.t));
}
function lateConduct(now){return conductList(now).filter(c=>!c.done&&T(c.t)<now);}
function soonConduct(now){return conductList(now).filter(c=>!c.done&&T(c.t)>=now&&T(c.t)-now<=10);}
/* 이 분(m)에 띄울 알림 · 미도착은 집결 5분 전과 정각, 나머지는 10분 전과 정각 · 미도착이 먼저 */
function conductAlert(m,onlyMiss){
  const L=soonConduct(m).filter(c=>(!onlyMiss||c.kind==='miss')&&(T(c.t)===m||T(c.t)-m===(c.kind==='miss'?MISS_BEFORE:10)));
  const s=L.find(c=>c.kind==='miss')||L[0];if(!s)return null;
  const at=T(s.t)===m;
  return {msg:`${s.kind==='miss'?(at?'집결 마감':`${MISS_BEFORE}분 후 집결 마감`):(at?'지금 할 일':'10분 후')} · ${s.txt}`,red:s.kind==='miss'};
}

function sessionOf(no){for(const rm of J.sched.rooms){for(const x of sessions(rm,true)){if(x.members.includes(no))return{x,room:rm};}}return null;}
const stLabel=s=>s||'공란';
function statusCls(s){return s==='접수'?'pri':s==='연락중'?'err':s==='불참'?'mute':s==='접수예정'?'warn':'';}
function download(name,text){const b=new Blob(['﻿'+text],{type:'text/csv'});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),1000);}
/* CSV 칸 · 엑셀이 =,+,-,@ 로 시작하는 값을 수식으로 실행하지 않도록 앞에 ' 를 붙여요 (전화번호·숫자·'-' 단독은 그대로) */
const csvCell=v=>{let s=String(v??'');if(/^[=+\-@\t\r]/.test(s)&&!/^-$|^[-+]?\d[\d\s:.\-]*$/.test(s))s="'"+s;return /[",\n\r]/.test(s)||/^'/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};
