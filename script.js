'use strict';
const $=s=>document.querySelector(s), E=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const days=['일','월','화','수','목','금','토'];
let state, selected='', view='map', month='', reqFilter='pending', search='', busy=false, lastFocus;
const modal=$('#modal');
function shift(d,n){const t=new Date(d+'T12:00:00+09:00');t.setUTCDate(t.getUTCDate()+n);return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(t)}
function day(d){return new Date(d+'T12:00:00+09:00').getUTCDay()}
let sessionToken='',lastUser=null;
async function api(action,b={}){
 const root=String(window.CB_CONFIG?.projectUrl||'').trim().replace(/\/$/,'');
 if(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(root))throw Error('config.js에 Supabase 프로젝트 URL을 설정해주세요.');
 const body={...b,operation:action,token:sessionToken};
 if(action==='state'){body.date=selected||undefined;if(view==='calendar')body.month=month;}
 if(['apply','edit'].includes(action)){
  const nums=String(b.studentIds||'').split(',').map(x=>x.trim()).filter(Boolean),names=String(b.names||'').split(',').map(x=>x.trim()).filter(Boolean);
  if(nums.length!==names.length||!nums.length||nums.length>50)throw Error('학번과 이름을 같은 인원수로 1~50명 입력하세요.');
  if(new Set(nums).size!==nums.length||nums.some(x=>!/^\d{5}$/.test(x)))throw Error('학번은 중복 없는 5자리 숫자여야 합니다.');
  body.students=nums.map((n,i)=>({number:n,name:names[i]}));delete body.studentIds;delete body.names;
 }
 if(action==='user'&&b.id===b.newId&&!state.users.some(u=>u.id===b.id))body.id='';
 if(action==='user'&&b.active!==undefined)body.active=b.active==='true'||b.active===true;
 if(action==='logout'&&!sessionToken)return {ok:true};
 const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),35000);
 try{
  const res=await fetch(root+'/functions/v1/classroom-api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'web',data:body}),signal:ctrl.signal});
  let d;try{d=await res.json();}catch{throw Error('서버 응답을 읽을 수 없습니다. Edge Function 배포를 확인하세요.');}
  if(!res.ok||!d.ok){
   if(d.code==='SESSION_EXPIRED'){sessionToken='';lastUser=null;view='map';if(action==='state')return api('state');}
   throw Error((d.message||'요청 실패')+(d.requestId?' · 확인번호 '+d.requestId:''));
  }
  if(action==='login'){sessionToken=d.token;lastUser=d.user;}
  if(action==='logout'||action==='profile'){sessionToken='';lastUser=null;}
  if(action==='detail')return d.application;
  return d;
 }catch(e){if(e.name==='AbortError')throw Error('응답 시간이 초과되었습니다. 저장됐을 수 있으니 재등록하기 전에 목록을 확인하세요.');throw e;}
 finally{clearTimeout(timer);if(action==='logout'){sessionToken='';lastUser=null;}}
}
async function load(){
 const st=await api('state');state=st;if(!selected)selected=state.today;
 if(!month)month=state.today.slice(0,7);
 render();
}
function toast(msg){$('#toast').textContent=msg;$('#toast').hidden=false;clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>$('#toast').hidden=true,4200)}
function open(title,html){const section=({'관리자 설정':'accounts','내 교실 개방 관리':'rooms','정기·당일 일정 관리':'schedules','변경 이력 조회':'history','교사 계정 추가':'add','계정 및 담당 배정 변경':'accounts'})[title];if(state?.user?.role==='admin'&&section)html=adminNav(section)+html;lastFocus=document.activeElement;$('#modal-title').textContent=title;$('#modal-body').innerHTML=html;$('#modal-error').textContent='';if(!modal.open)modal.showModal();decoratePasswords()}
function close(){modal.close();lastFocus?.focus()}
function buttons(u){return u?`<span>${u.role==='admin'?'관리자':'선생님'} <strong>${E(u.name)}</strong></span><button data-action="profile">정보변경</button><button data-action="logout">로그아웃</button>`:'<button data-action="login">교사 로그인</button>'}
const btn=(a,t,id='',cls='')=>`<button type="button" class="${cls}" data-action="${a}" data-id="${E(id)}">${t}</button>`;
function roomName(id){return state.rooms.find(r=>r.id===id)?.name||id}
function userName(id){return state.users.find(u=>u.id===id)?.name||id||'담당 없음'}
function effective(d,room){
 const recurring=state.schedules.filter(x=>!x.date&&x.day===day(d)&&(!x.startsOn||x.startsOn<=d)&&(!x.endsOn||x.endsOn>=d));const over=state.schedules.filter(x=>x.date===d);const replaced=new Set(over.map(x=>x.base).filter(Boolean));return [...recurring.filter(x=>!replaced.has(x.id)),...over].filter(x=>x.room===room&&!x.cancel);
}
function acceptedLabel(app){const names=Array.isArray(app.names)?app.names:[];return app.title+(names.length?' '+names[0]+(names.length>1?'외 '+(names.length-1)+'명':''):'');}
function slot(r,p,d=selected){
 const app=state.apps.find(a=>a.date===d&&a.room===r.id&&a.status==='accepted'&&a.periods.includes(p));
 if(app)return {type:'rented',text:acceptedLabel(app),app};
 const schedule=effective(d,r.id).find(x=>p>=(x.start||1)&&p<=x.end);
 if(schedule)return {type:'blocked',text:`${schedule.date?'당일 일정':'정기 일정'}: ${schedule.title} · ${schedule.owner?userName(schedule.owner):'담당 미지정'}`};
 const lab=state.labs.find(x=>x.room===r.id&&x.date===d&&x.slot==='야자'+p);
 if(lab)return {type:'blocked',text:`교사 사용 · ${userName(lab.user)}`};
 if(!r.open||!r.periods.includes(p))return {type:'closed',text:'미개방'};
 if([0,6].includes(day(d)))return {type:'closed',text:'주말 신청 불가'};
 if(r.teachers.length<r.required)return {type:'closed',text:'담당 배정 필요'};
 return {type:'available',text:'대여 가능'};
}
function render(){
 const u=state.user;$('#account').innerHTML=buttons(u);$('#notices').innerHTML=view==='map'?(state.notices||[]).map(n=>'<article class="operation-notice">📢 '+E(n.content)+'</article>').join(''):'';
 document.querySelectorAll('.auth').forEach(x=>x.hidden=!u);document.querySelector('nav [data-view="requests"]').hidden=!!u;
 $('#tools').innerHTML=u?`${u.role!=='admin'?btn('manage','내 교실 관리하기')+btn('schedules','선생님 일정 설정')+((u.gradeHead||u.role==='admin')?btn('notices','공지하기'):''):''}${u.role==='admin'||u.rooms.some(r=>r.startsWith('과학'))?btn('labs','과학실 일정보기'):''}${u.role==='admin'?btn('admin','관리자 설정')+btn('notices','공지하기'):''}`:'';
 const manage=$('#tools [data-action="manage"]');if(manage)manage.id='manage-btn';
 document.querySelectorAll('[data-view]').forEach(x=>x.classList.toggle('active',x.dataset.view===view));
 $('#date').value=selected;
 const prevDate=document.querySelector('[data-action="prev-date"]'),nextDate=document.querySelector('[data-action="next-date"]');prevDate.disabled=selected<=shift(state.today,-1);nextDate.disabled=selected>=shift(state.today,14);$('#date').min=shift(state.today,-1);$('#date').max=shift(state.today,14);$('#today-btn').hidden=selected===state.today;
 $('#weekday').textContent=`${days[day(selected)]}요일 · 신청 가능: 오늘 ~ 14일 후`;
 const counts={available:0,rented:0,blocked:0,closed:0};for(const r of state.rooms)for(const p of [1,2])counts[slot(r,p).type]++;
 document.body.dataset.view=view;
 const myPending=state.apps.filter(a=>a.status==='pending'&&a.canManage&&!a.approvedBy.includes(u?.id)).length;
 const reviewNav=document.querySelector('nav [data-view="review"]');reviewNav.classList.toggle('attention',!!u&&myPending>0);reviewNav.innerHTML='✓ <span>신청서 확인</span>'+(u&&myPending?'<b>'+myPending+'</b>':'');
 const pending=state.apps.filter(a=>a.date===selected&&a.status==='pending').length;$('#nav-count').textContent=pending;
 $('#stats').innerHTML=[['신청 가능 교실',state.rooms.filter(r=>[1,2].some(p=>slot(r,p).type==='available')).length,'↗','개'],['승인 대기 신청',pending,'◷','건']].map(([t,n,i,s])=>`<div class="stat"><div><small>${t}</small><strong>${n}</strong> <small class="inline">${s}</small></div><i aria-hidden="true">${i}</i></div>`).join('');
 const titles={map:['교실 배치도',''],requests:['신청 목록','신청 처리 상태를 확인하고, 비밀번호로 상세 조회·취소할 수 있습니다.'],review:['신청서 확인','내 담당 신청을 우선 표시합니다. 최종 승인 전에는 교실이 확정되지 않습니다.'],calendar:['대여 기록 달력','이번 달과 이전 달, 내가 관리하는 교실의 승인 기록만 확인합니다.']};
 $('#page-title').textContent=titles[view][0];$('#page-desc').textContent=titles[view][1];
 if(view==='map')renderMap();else if(view==='requests')renderRequests();else if(view==='review')renderReview();else renderCalendar();
 $('#sync').textContent=('공유 데이터 연결됨')+' · '+new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});
}
function roomCard(id){const r=state.rooms.find(r=>r.id===id);if(!r)return '<div class="spacer"></div>';
 const pend=state.apps.filter(a=>a.room===id&&a.date===selected&&a.status==='pending').length;
 const needsAttention=!!state.user&&state.apps.some(a=>a.room===id&&a.date===selected&&a.status==='pending'&&a.canManage&&!a.approvedBy.includes(state.user.id));
 const available=[1,2].some(p=>slot(r,p).type==='available')&&selected>=state.today;
 return `<article class="room ${needsAttention?'needs-action':''}"><div><h3>${E(roomName(id))} ${pend?`<span class="pending-badge">${pend}건 대기</span>`:''}</h3><div class="owner">${r.teachers.map(x=>E(userName(x))).join(' · ')} 선생님</div></div>${[1,2].map(p=>{const s=slot(r,p);return `<div class="slot ${s.type}"><strong>${p}교시</strong> <span>${E(s.text)}</span>${state.apps.filter(a=>a.room===id&&a.date===selected&&a.status==='pending'&&a.periods.includes(p)).length?`<span class="period-pending">신청 ${state.apps.filter(a=>a.room===id&&a.date===selected&&a.status==='pending'&&a.periods.includes(p)).length}건</span>`:''}${s.app?btn('detail','상세',s.app.id):''}</div>`}).join('')}<button class="book" data-action="apply" data-id="${E(id)}" ${available?'':'disabled'}>${available?'대여 신청하기 ↗':selected<state.today?'지난 날짜 · 조회 전용':'신청 가능한 교시 없음'}</button></article>`;
}
function renderMap(){
 $('#content').innerHTML=`<div class="section-bar"><h2>교실 현황 <small>· ${selected}</small></h2><div class="legend"><span class="dot">대여 가능</span><span class="dot rent">대여 중</span><span class="dot block">정기 일정·교사 사용</span></div></div><div class="floor"><div class="row">${['1-3','1-2','1-1','영어실','IT랩실'].map(roomCard).join('')}</div><div class="corridor" aria-hidden="true"></div><div class="row">${['진로실','1-4','1-5','과학실2','과학실1'].map(roomCard).join('')}</div></div><div class="notice">안내 · 신청 대기 상태는 교실을 점유하지 않습니다. 같은 시간대에는 한 신청만 최종 승인됩니다.</div>`;
}
function empty(t='해당하는 신청이 없습니다.'){return `<div class="empty"><b>▤</b>${t}</div>`}
function groups(apps,teacherMode=false){
 if(!apps.length)return empty();let g=new Map();for(const a of apps){const k=[a.date,a.room,a.periods.join(',')].join('|');if(!g.has(k))g.set(k,[]);g.get(k).push(a)}
 return [...g.values()].map(v=>{const first=v[0];return `<section class="group"><div class="group-head ${first.periods.length===2?'both':first.periods[0]===2?'p2':''}"><span>[${E(roomName(first.room))}] ${first.periods.join('·')}교시</span><span>${first.date}</span></div>${v.map(a=>`<article class="app ${a.canManage?'mine'+(a.status==='pending'&&!a.approvedBy.includes(state.user?.id)?' needs-action':''):''}">${a.canManage?'<span class="badge">내 담당</span>':''}<span class="badge">${({pending:'승인 대기',accepted:'승인 완료',rejected:'거절',cancelled:'취소'})[a.status]}</span><h3>${E(a.periods.join('·')+'교시 '+acceptedLabel(a))}</h3>${a.status==='accepted'?'<p class=\"approved-students\">'+a.studentIds.map((n,i)=>E(n+' '+a.names[i])).join(' · ')+'</p>':''}<p>담당: ${E(userName(a.teacher))}${a.device?' · 전자기기 '+a.device:''}${a.room.startsWith('과학')?` · 동의 ${a.approvedBy.length}/${a.required}명`:''}</p>${a.reason?`<p class="reason">${E(a.reason)}</p>`:''}${a.rejectionReason?`<p class="error">거절 사유: ${E(a.rejectionReason)}</p>`:''}<div class="toolbar">${btn('detail','자세히 보기',a.id)}${teacherMode&&a.canManage&&a.status==='pending'?`${a.approvedBy.includes(state.user.id)?'<button type="button" class="success" disabled>동의 완료</button>':a.canApprove?btn('approve','수락 / 동의',a.id,'success'):''}${btn('reject','거절',a.id,'danger')}`:''}${teacherMode&&a.status==='accepted'&&a.canEdit?btn('edit','수정',a.id):''}${a.status==='accepted'&&a.canManage?btn('cancel','승인 신청 삭제',a.id,'danger'):''}${!teacherMode&&['pending','accepted'].includes(a.status)?btn('cancel','취소',a.id,'danger'):''}</div></article>`).join('')}</section>`}).join('');
}
function renderRequests(){
 const apps=state.apps.filter(a=>a.date===selected&&(reqFilter==='all'||a.status===reqFilter)&&[a.title,...a.names,...a.studentIds].some(v=>v.includes(search)));
 $('#content').innerHTML=`<div class="filterbar"><select id="status-filter" aria-label="신청 상태">${[['pending','승인 대기'],['accepted','승인 완료'],['rejected','거절'],['cancelled','취소'],['all','전체 상태']].map(([v,t])=>`<option value="${v}" ${v===reqFilter?'selected':''}>${t}</option>`).join('')}</select><input id="search" aria-label="신청자 검색" placeholder="제목·승인자 검색" value="${E(search)}"><small>${apps.length}건 · ${selected}</small></div><div class="panel">${groups(apps)}</div>`;
}
function renderReview(){if(!state.user){view='map';render();return}
 const apps=state.apps.filter(a=>a.status==='pending').sort((a,b)=>Number(b.canManage)-Number(a.canManage)||Number(b.date===selected)-Number(a.date===selected)||a.created-b.created);
 $('#content').innerHTML=`<div class="split"><section class="panel"><h2>승인된 대여 <span class="badge">${selected}</span></h2>${groups(state.apps.filter(a=>a.status==='accepted'&&a.date===selected),true)}</section><section class="panel"><h2>수락 대기 <span class="badge">${apps.length}건</span></h2>${groups(apps,true)}</section></div>`;
}
function renderCalendar(){if(!state.user){view='map';render();return}
 const [y,m]=month.split('-').map(Number), start=new Date(y,m-1,1).getDay(), count=new Date(y,m,0).getDate();
 const cur=state.today.slice(0,7),prev=shift(cur+'-01',-1).slice(0,7);
 let cells=days.map(d=>`<div class="cal-label">${d}</div>`).join('')+'<div class="cal-cell blank"></div>'.repeat(start);
 for(let n=1;n<=count;n++){const d=month+'-'+String(n).padStart(2,'0');const apps=state.apps.filter(a=>a.date===d&&a.status==='accepted'&&(state.user.role==='admin'||state.rooms.find(r=>r.id===a.room).teachers.includes(state.user.id)));
 cells+=`<div class="cal-cell ${d===state.today?'today':''}"><div class="cal-day">${n}</div>${apps.map(a=>`<button class="chip" data-action="detail" data-id="${a.id}">[${E(roomName(a.room))}] ${a.periods.join('·')}교시<br>${E(acceptedLabel(a))}</button>`).join('')}</div>`}
 $('#content').innerHTML=`<div class="section-bar"><h2>${y}년 ${m}월</h2><div class="actions"><button data-action="month" data-id="${prev}" ${month===prev?'disabled':''}>‹ 이전 달</button><button data-action="month" data-id="${cur}" ${month===cur?'disabled':''}>이번 달 ›</button></div></div><div class="calendar">${cells}</div><div class="notice">${state.user.role==='admin'?'관리자: 전체 교실 기록':'내 관리 교실만 표시: '+state.user.rooms.join(', ')} · 날짜별 승인 기록은 삭제하지 않고 보관됩니다.</div>`;
}
function field(label,name,value='',type='text',extra=''){return `<label class="field">${label}<input type="${type}" name="${name}" value="${E(value)}" ${extra}></label>`}
function options(list,current){return list.map(x=>{const [v,t]=Array.isArray(x)?x:[x,x];return `<option value="${E(v)}" ${String(v)===String(current)?'selected':''}>${E(t)}</option>`}).join('')}
function select(label,name,list,current){return `<label class="field">${label}<select name="${name}">${options(list,current)}</select></label>`}
function toggles(name,items,checked,disabled=[]){return `<div class="toggle">${items.map(([v,t])=>`<label><input type="${name==='periods'?'checkbox':'radio'}" name="${name}" value="${v}" ${checked.map(String).includes(String(v))?'checked':''} ${disabled.map(String).includes(String(v))?'disabled':''}><span>${t}</span></label>`).join('')}</div>`}
function actions(text='저장하기'){return `<div class="form-actions">${btn('close','닫기')}<button type="submit" class="primary">${text}</button></div>`}
function applicationForm(room,app){const r=state.rooms.find(r=>r.id===room),edit=!!app;
 const unavailable=[1,2].filter(p=>slot(r,p).type!=='available');
 open(edit?'승인된 신청 수정':'교실 대여 신청',`<form data-form="${edit?'edit':'apply'}" data-id="${app?.id||''}"><input type="hidden" name="room" value="${E(room)}"><input type="hidden" name="date" value="${selected}"><div class="form-grid">${field('활동 제목','title',app?.title||'','text','required maxlength="100" placeholder="예: 동아리 활동"')}${field('신청 날짜','dateDisplay',app?.date||selected,'text','readonly')}${field('신청 교실','roomDisplay',roomName(room),'text','readonly')}${field('학생 학번 · 쉼표로 구분','studentIds',app?.studentIds.join(', ')||'','text','required maxlength="600" placeholder="예: 10206, 10212"')}${field('학생 이름 · 학번과 같은 순서','names',app?.names.join(', ')||'','text','required maxlength="1600" placeholder="예: 홍길, 김호"')}<div class="full"><small>학번과 이름의 인원수가 같아야 합니다. 학생은 최대 50명입니다.</small></div><fieldset><legend>신청 교시 ${edit?'(변경 불가)':'· 복수 선택 가능'}</legend>${toggles('periods',[[1,'야자 1교시'],[2,'야자 2교시']],app?.periods||[],edit?[1,2]:unavailable)}</fieldset>${select('담당 선생님','teacher',r.teachers.map(x=>[x,userName(x)]),app?.teacher||r.teachers[0])}<fieldset><legend>전자기기 사용 여부</legend>${toggles('device',[['O','O · 사용'],['X','X · 미사용']],[app?.device||'X'])}</fieldset>${!edit?field('신청 비밀번호 · 상세 조회·취소용','password','','password','required autocomplete="new-password" placeholder="비밀번호 입력"'):''}<label class="field full">신청 사유<textarea name="reason" required maxlength="1500" placeholder="활동 목적과 사용 내용을 작성해주세요.">${E(app?.reason||'')}</textarea></label></div><small>최종 승인 후 예약이 확정되며 학번·이름은 사이트 방문자에게 공개됩니다. 실제 정보 입력은 학교의 공개 기준에 따라주세요.</small>${actions(edit?'수정 저장':'신청 제출하기')}</form>`);
}
function loginForm(){open('교사 로그인',`<p class="help">교사·관리자 계정으로 로그인하세요.${window.demoAPI?' 체험용 비밀번호는 <strong>helloCB</strong>입니다.':''}</p><form data-form="login">${field('아이디','id',window.demoAPI?'이동희':'','text','required autocomplete="username"')}${field('비밀번호','password',window.demoAPI?'helloCB':'','password','required autocomplete="current-password"')}${actions('로그인')}</form>${window.demoAPI?'<small>체험 계정: 이동희 / 문은섭 / 김묘선 / 송선영 / 김호(관리자) 등 문서의 모든 교사 이름</small>':''}`)}
function passwordForm(action,id){const a=state.apps.find(a=>a.id===id);open(action==='cancel'?'신청 취소':'신청 상세 조회',`<p>${E(a?.title||'선택한 신청')}${action==='cancel'?'의 신청을 취소하시겠습니까?':'의 신청 비밀번호를 입력해주세요.'}</p><form data-form="${action}" data-id="${id}">${field('신청 비밀번호','password','','password','required ')}${actions(action==='cancel'?'신청 취소':'확인하기')}</form>`)}
function showDetail(a){open('신청서 상세',`<div class="detail-grid"><div><small>교실 · 교시</small><strong>${E(roomName(a.room))} / ${a.periods.join('·')}교시</strong></div><div><small>신청 날짜 · 상태</small>${a.date} / ${E(({pending:'승인 대기',accepted:'승인 완료',rejected:'거절',cancelled:'취소'})[a.status])}</div><div><small>신청 학생 전원</small>${a.studentIds.map((id,i)=>E(id+' '+a.names[i])).join('<br>')}</div><div><small>담당 선생님 · 전자기기</small>${E(userName(a.teacher))} / ${E(a.device)}</div><div class="full"><small>신청 사유</small>${E(a.reason)}</div><div class="full"><small>동의한 선생님</small>${a.approvedBy.map(x=>E(userName(x))).join(', ')||'아직 없음'}${a.rejectionReason?'<br>거절 사유: '+E(a.rejectionReason):''}</div></div><div class="form-actions">${btn('close','닫기')}${['pending','accepted'].includes(a.status)&&a.date>=state.today?btn('verified-cancel','비밀번호로 신청 취소',a.id,'danger'):''}</div>`)}
function manage(){const rooms=state.rooms.filter(r=>state.user.role==='admin'||r.teachers.includes(state.user.id)).sort((a,b)=>roomName(a.id).localeCompare(roomName(b.id),'ko',{numeric:true}));open('내 교실 개방 관리',`${rooms.length?'':'<p>담당 교실이 없습니다.</p>'}${rooms.map(r=>`<form class="panel" data-form="room" data-id="${E(r.id)}"><h3>${E(roomName(r.id))}</h3><div class="form-grid">${state.user.role==='admin'?field('교실 이름','name',roomName(r.id),'text','required maxlength="40"'):''}${select('개방 여부','open',[['true','O · 개방'],['false','X · 미개방']],r.open)}${select('개방 교시','periods',[['1,2','1·2교시'],['1','1교시'],['2','2교시']],r.periods.join(','))}${r.id.startsWith('과학')?select('최종 승인에 필요한 동의','required',r.teachers.map((x,i)=>[i+1,(i+1)+'명']),r.required):'<input type="hidden" name="required" value="1">'}</div>${actions('이 교실 저장')}</form>`).join('')}<small>승인된 대여와 충돌하는 미개방 변경은 차단됩니다. 필요한 경우 해당 예약을 먼저 취소하세요.</small>`)}
function schedules(){const u=state.user,order=['1-1','1-2','1-3','1-4','1-5','영어실','IT랩실','과학실1','과학실2','진로실'];const rank=x=>{const n=order.indexOf(roomName(x.room));return n<0?999:n};const compare=(a,b)=>Number(b.owner===u.id)-Number(a.owner===u.id)||rank(a)-rank(b)||a.title.localeCompare(b.title,'ko');const items=[...state.schedules].sort(compare);
 const row=x=>`<div class="schedule-item ${x.owner===u.id?'my-schedule':''}"><div><strong>${E(x.date||'매주 반복')} ${!x.date?'('+E(x.startsOn||'시작 제한 없음')+' ~ '+E(x.endsOn||'종료 제한 없음')+')':''} · ${E(x.title)}</strong><small>${E(roomName(x.room))} / ${(x.start||1)===x.end?x.end+'교시만':(x.start||1)+'·'+x.end+'교시'} / ${E(userName(x.owner))}${x.cancel?' · 당일 취소':''}</small></div><div class="toolbar">${btn('schedule-edit','수정',x.id)}${!x.date?btn('schedule-override','당일 변경',x.id):''}${btn('schedule-delete','삭제',x.id,'danger')}</div></div>`;
 let sections=[1,2,3,4,5].map(d=>{const a=items.filter(x=>!x.date&&x.day===d).sort(compare);return `<section class="weekday-group"><h3>${days[d]}요일 <small>${a.length}건</small></h3>${a.map(row).join('')||'<p class="help">등록된 일정 없음</p>'}</section>`}).join('');
 const dated=items.filter(x=>x.date).sort(compare);if(dated.length)sections+='<section class="weekday-group"><h3>당일 일정 · 날짜순</h3>'+dated.map(row).join('')+'</section>';
 const legacy=items.filter(x=>!x.date&&[0,6].includes(x.day));if(legacy.length)sections+='<section class="weekday-group"><h3>기존 주말 일정 · 확인용</h3>'+legacy.map(row).join('')+'</section>';
 open('정기·당일 일정 관리',`<div class="toolbar">${btn('schedule-new','+ 주기 일정 추가')}${btn('schedule-single','+ 당일 일정 추가')}</div><div class="notice">반복 일정은 월~금요일로 설정합니다. 하루만 바꾸려면 ‘당일 변경’을 사용하세요.</div>${sections}`);
}
function scheduleForm(kind,id){const u=state.user,old=state.schedules.find(x=>x.id===id),override=kind==='override';
 const x=old?{...old}:{room:state.rooms[0].id,title:u.programs[0]||'',owner:u.id,start:1,end:2,day:day(selected),date:kind==='single'?selected:'',base:'',cancel:false};if(override){x.base=x.id;x.id='';x.date=selected}
 open(x.date?'당일 일정 설정':'매주 반복 일정 설정',`<form data-form="schedule" data-id="${E(x.id||'')}"><input type="hidden" name="base" value="${E(x.base||'')}"><div class="form-grid">${x.date?field('적용 날짜','date',x.date,'date','required'):select('반복 요일','day',[1,2,3,4,5].map(i=>[i,days[i]+'요일']),x.day)}${!x.date?field('반복 시작일','startsOn',x.startsOn||state.today,'date','required')+field('반복 종료일','endsOn',x.endsOn||shift(state.today,180),'date','required'):''}${select('교실','room',state.rooms.map(r=>[r.id,roomName(r.id)]),x.room)}${field('일정 제목 · 새 담당 일정 직접 입력','title',x.title,'text','required maxlength="60" list="program-options"')}<datalist id="program-options">${u.programs.map(v=>'<option value="'+E(v)+'"></option>').join('')}</datalist>${select('담당 교사','owner',[['','담당 없음'],...state.users.filter(v=>v.active).map(v=>[v.id,v.name])],x.owner)}${select('진행 교시','periodRange',[['1,1','1교시만'],['2,2','2교시만'],['1,2','1·2교시 모두']],(x.start||1)+','+x.end)}${x.base?select('당일 진행 여부','cancel',[['false','진행 / 교실·시간 변경'],['true','이 날짜만 취소']],x.cancel):''}</div>${actions('일정 저장')}</form>`);}
function labs(){
 let html='<p class="help">'+selected+' · 과학실 1·2 통합 시간표 · 야자에는 학생 대여와 정기 일정도 표시됩니다.</p><div class="table-wrap"><table class="lab-combined"><thead><tr><th>시간</th><th>'+E(roomName('과학실1'))+'</th><th>'+E(roomName('과학실2'))+'</th></tr></thead><tbody>';
 for(const p of ['1','2','3','4','5','6','7','방과후','야자1','야자2']){
 html+='<tr><th scope="row">'+E(p)+(/^\d$/.test(p)?'교시':'')+'</th>';
 for(const room of ['과학실1','과학실2']){
 const x=state.labs.find(x=>x.room===room&&x.slot===p&&x.date===selected);
 const st=p.startsWith('야자')?slot(state.rooms.find(r=>r.id===room),Number(p.slice(-1))):null;
 const text=x?userName(x.user):st&&['blocked','rented'].includes(st.type)?st.text:'';
 const can=state.user.role==='admin'||state.rooms.find(r=>r.id===room).teachers.includes(state.user.id);
 const control=selected>=state.today&&can?(x?(x.user===state.user.id||state.user.role==='admin'?btn('lab-cancel','취소',room+'|'+p):''):(text?'':btn('lab-use','사용',room+'|'+p))):'';
 html+='<td><div class="lab-cell"><span>'+ (E(text)||'<small>—</small>')+'</span><div class="toolbar">'+control+(st?.app?btn('detail','상세',st.app.id):'')+'</div></div></td>';
 } html+='</tr>';
 }html+='</tbody></table></div>';open('과학실 1·2 일정 확인',html);
}
function profile(){const u=state.user;open('정보변경',`<p class="help">담당 교실 변경은 관리자에게 요청하세요. 새 담당 일정은 선생님 일정 설정에서 직접 추가할 수 있습니다.<br>현재 담당 교실: ${E(u.rooms.map(roomName).join(', ')||'없음')} · 프로그램: ${E(u.programs.join(', ')||'없음')}</p><form data-form="profile">${field('아이디','newId',u.loginId,'text','required maxlength="50"')}${field('담당 과목','subject',u.subject)}${field('현재 비밀번호','currentPassword','','password','required autocomplete="current-password"')}${field('새 비밀번호 · 변경할 때만 입력','newPassword','','password','autocomplete="new-password"')}${actions('변경 후 다시 로그인')}</form>`)}
const adminOptions=[['accounts','계정 · 담당 관리'],['add','계정 추가'],['rooms','교실 설정'],['schedules','정기 일정 관리'],['history','변경 이력 조회']];
function adminNav(section){return `<label class="field admin-select">관리자 설정<select id="admin-section">${adminOptions.map(([v,t])=>`<option value="${v}" ${v===section?'selected':''}>${t}</option>`).join('')}</select></label>`}
function adminSection(section){if(section==='history'){historyList().catch(e=>$('#modal-error').textContent=e.message);return}if(section==='rooms')manage();else if(section==='schedules')schedules();else if(section==='add')userForm();else adminPanel()}
function adminPanel(){open('관리자 설정',`<h3>교사 계정 · 담당 교실</h3><div class="table-wrap"><table><thead><tr><th>이름 (아이디)</th><th>담당 교실 · 프로그램</th><th>관리</th></tr></thead><tbody>${[...state.users].sort((a,b)=>Number(!!b.gradeHead)-Number(!!a.gradeHead)||a.name.localeCompare(b.name,'ko')).map(u=>`<tr class="${u.gradeHead?'grade-head-row':''}"><td>${u.gradeHead?'<span class="grade-head-badge">학년부장</span> ':''}${E(u.name)} (${E(u.loginId||u.id)})${u.active?'':' · 사용 중지'}</td><td>${E(u.rooms.map(roomName).join(', '))}<br><small>${E(u.programs.join(', '))}</small></td><td>${btn('user-edit','배정 / 아이디 변경',u.id)}${btn('user-password','비밀번호 초기화',u.id)}</td></tr>`).join('')}</tbody></table></div><p class="help">비밀번호는 복호화할 수 없습니다. 초기화 시 새 비밀번호를 직접 지정하고 해당 선생님께 안전하게 전달하세요.</p>`)}
function userForm(id,passwordOnly=false){const u=state.users.find(x=>x.id===id);if(passwordOnly){open('비밀번호 초기화',`<p>${E(u.name)} (${E(u.loginId||u.id)})</p><form data-form="reset" data-id="${E(id)}">${field('새 비밀번호','password','','password','required ')}${actions('비밀번호 초기화')}</form>`);return}
 open(u?'계정 및 담당 배정 변경':'교사 계정 추가',`<form data-form="user" data-id="${E(id||'')}"><div class="form-grid">${u?field('이름','name',u.name,'text','readonly'):field('이름','name','','text','required maxlength="30"')}${field('아이디','newId',u?.loginId||'','text','required maxlength="50"')}${field('담당 과목','subject',u?.subject||'')}${u?select('계정 상태','active',[['true','사용'],['false','사용 중지']],String(u.active)):''}${!u?field('초기 비밀번호','password','helloCB','password','required '):''}<fieldset class="full"><legend>담당 교실 · 변경 시 승인 권한에 반영</legend><div class="checkbox-list"><label><input type="checkbox" name="gradeHead" ${u?.gradeHead?'checked':''}> 학년 부장 · 야자 담당</label>${state.rooms.map(r=>`<label><input type="checkbox" name="rooms" value="${E(r.id)}" ${u?.rooms.includes(r.id)?'checked':''}> ${E(roomName(r.id))}</label>`).join('')}</div></fieldset><label class="field full">담당 프로그램 · 쉼표 구분<input name="programs" value="${E(u?.programs.join(', ')||'')}" maxlength="1000" placeholder="예: 형설지공, 국어 청출"></label></div>${actions('계정 저장')}</form>`)}
let mutationBusy=false;
async function mutate(action,b,after){if(mutationBusy)return;mutationBusy=true;try{const result=await api(action,b);await load();if(after)after();else close();if(action==='apply'){open('신청 접수 완료',`<p>신청 목록에서 확인할 수 있습니다.</p>${btn('close','확인')}`);}toast(result.message||'처리되었습니다.');}finally{mutationBusy=false;}}
async function command(a,id){
 switch(a){
 case 'notices':await noticeList();break;
 case 'notice-new':noticeForm();break;
 case 'notice-edit':noticeForm(id);break;
 case 'notice-delete':open('공지 삭제 확인',`<p>이 공지를 삭제하시겠습니까?</p><form data-form="notice-delete" data-id="${E(id)}">${actions('삭제하기')}</form>`);break;
 case 'history-more':await historyList(historyOffset+50);break;
 case 'history-prev':await historyList(Math.max(0,historyOffset-50));break;
 case 'verified-cancel':open('내 신청 취소',`<form data-form="cancel" data-id="${E(id)}">${field('신청 비밀번호','password','','password','required')}${actions('취소 확정')}</form>`);break;
 case 'retry':await boot();break;
 case 'close':close();break;
 case 'requests':view='requests';await load();break;
 case 'login':loginForm();break;
 case 'logout':await api('logout',{});view='map';await load();toast('로그아웃되었습니다.');break;
 case 'apply':applicationForm(id);break;
 case 'detail':if(state.apps.find(a=>a.id===id)?.status==='accepted'||state.apps.find(a=>a.id===id)?.canManage){const a=await api('detail',{id});showDetail(a)}else passwordForm('detail',id);break;
 case 'cancel':if(state.apps.find(a=>a.id===id)?.canManage){open('신청 취소 확인',`<p>선택한 신청을 목록에서 제외하고 예약을 해제하시겠습니까? 처리 이력은 보존됩니다.</p><form data-form="cancel" data-id="${id}">${actions('신청 취소')}</form>`)}else passwordForm('cancel',id);break;
 case 'approve':await mutate('approve',{id});break;
 case 'reject':open('신청 거절',`<form data-form="reject" data-id="${id}"><label class="field">거절 사유 · 생략 가능<textarea name="reason" maxlength="1500"></textarea></label>${actions('거절 처리')}</form>`);break;
 case 'edit':{const a=state.apps.find(a=>a.id===id);applicationForm(a.room,a);break}
 case 'manage':manage();break;
 case 'schedules':schedules();break;
 case 'schedule-back':schedules();break;
 case 'schedule-new':scheduleForm('recurring');break;
 case 'schedule-single':scheduleForm('single');break;
 case 'schedule-edit':scheduleForm('edit',id);break;
 case 'schedule-override':scheduleForm('override',id);break;
 case 'schedule-delete':open('일정 삭제 확인',`<p>이 일정 하나만 삭제합니다. 당일 변경을 삭제하면 원래 주기 일정이 복원됩니다.</p><form data-form="schedule-delete" data-id="${id}">${actions('삭제하기')}</form>`);break;
 case 'labs':labs();break;
 case 'lab-use':case 'lab-cancel':{const [room,slot]=id.split('|');await mutate('lab',{date:selected,room,slot,cancel:a==='lab-cancel'},labs);break}
 case 'profile':profile();break;
 case 'admin':adminPanel();break;
 case 'user-new':userForm();break;
 case 'user-edit':userForm(id);break;
 case 'user-password':userForm(id,true);break;
 case 'switch':view=view==='review'?'map':'review';await load();break;
 case 'month':month=id;await load();break;
 case 'today':selected=state.today;await load();break;
 case 'prev-date':case 'next-date':{const d=shift(selected,a==='next-date'?1:-1);if(d>=shift(state.today,-1)&&d<=shift(state.today,14)){selected=d;await load()}break}
 }
}
function download(name,text){const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
document.addEventListener('click',async ev=>{const el=ev.target.closest('button');if(!el||el.disabled)return;if(el.type!=='submit')ev.preventDefault();try{
 if(el.dataset.passwordToggle!==undefined){const input=el.parentElement.querySelector('input');input.type=input.type==='password'?'text':'password';el.setAttribute('aria-pressed',String(input.type==='text'));el.setAttribute('aria-label',input.type==='text'?'비밀번호 숨기기':'비밀번호 보기');return}
 if(el.dataset.view){if(['review','calendar'].includes(el.dataset.view)&&!state.user){loginForm();return}view=el.dataset.view;await load()}
 else if(el.dataset.action)await command(el.dataset.action,el.dataset.id);
 }catch(e){if(modal.open)$('#modal-error').textContent=e.message;else toast(e.message)}});
document.addEventListener('submit',async ev=>{const f=ev.target;if(!f.dataset.form)return;ev.preventDefault();if(busy)return;busy=true;const submit=f.querySelector('[type="submit"]');if(submit)submit.disabled=true;$('#modal-error').textContent='';
 try{const fd=new FormData(f),b=Object.fromEntries(fd),action=f.dataset.form; if(f.dataset.id)b.id=f.dataset.id;
 if(action==='apply')b.periods=fd.getAll('periods').map(Number);
 if(action==='notice-save'){b.startsOn=b.startsOn||state.today;}
 if(action==='room'){b.room=f.dataset.id;b.periods=b.periods.split(',').map(Number);b.open=b.open==='true';b.required=Number(b.required)}
 if(action==='schedule'){b.day=Number(b.day||1);const range=String(b.periodRange||'1,2').split(',').map(Number);b.start=range[0];b.end=range[1];delete b.periodRange;b.cancel=b.cancel==='true'}
 if(action==='user'){b.id=f.dataset.id||b.newId;b.rooms=fd.getAll('rooms');b.gradeHead=fd.has('gradeHead');b.programs=String(b.programs||'').split(',').map(x=>x.trim()).filter(Boolean)}
 if(action==='reset'){await mutate('user',b,adminPanel)}
 else if(action==='detail'){showDetail(await api('detail',b))}
 else if(action==='login'){await api('login',b);view='review';close();await load();toast('로그인되었습니다.')}
 else if(action==='profile'){await api('profile',b);await api('logout',{});view='map';close();await load();loginForm();toast('정보를 변경했습니다. 다시 로그인해주세요.')}
 else await mutate(action,b,['schedule','schedule-delete'].includes(action)?schedules:action==='user'?adminPanel:action==='room'?manage:['notice-save','notice-delete'].includes(action)?noticeList:undefined);
 }catch(e){$('#modal-error').textContent=e.message}finally{busy=false;if(submit?.isConnected)submit.disabled=false}});
document.addEventListener('change',async ev=>{try{if(ev.target.id==='admin-section'){adminSection(ev.target.value);return}if(ev.target.id==='date'){selected=ev.target.value;await load()}if(ev.target.id==='status-filter'){reqFilter=ev.target.value;renderRequests()}}catch(e){toast(e.message)}});
document.addEventListener('input',ev=>{if(ev.target.name==='name'&&ev.target.closest('form[data-form=user]')&&!ev.target.closest('form').dataset.id){const id=ev.target.closest('form').querySelector('[name=newId]');if(id&&!id.dataset.manual)id.value=ev.target.value;}if(ev.target.name==='newId')ev.target.dataset.manual='1';if(ev.target.id==='search'){const pos=ev.target.selectionStart;search=ev.target.value;renderRequests();$('#search').focus();$('#search').setSelectionRange(pos,pos)}});
modal.addEventListener('click',ev=>{if(ev.target===modal){const r=modal.getBoundingClientRect();if(ev.clientX<r.left||ev.clientX>r.right||ev.clientY<r.top||ev.clientY>r.bottom)close()}});
async function boot(){try{await load();}catch(e){$('#content').innerHTML='<div class="panel"><h2>연결을 확인해주세요.</h2><p>'+E(e.message)+'</p><p>config.js의 프로젝트 URL, 통합 SQL 실행, classroom-api 배포를 차례로 확인하세요.</p><button type="button" data-action="retry">다시 연결</button></div>';$('#sync').textContent='연결 안 됨';}}
boot();setInterval(()=>{if(state&&!modal.open&&!document.hidden&&!busy)load().catch(()=>$('#sync').textContent='연결 끊김 · 다시 시도 중')},15000);

function decoratePasswords(){document.querySelectorAll('input[type=password]').forEach(input=>{if(input.parentElement.classList.contains('password-wrap'))return;const wrap=document.createElement('span');wrap.className='password-wrap';input.replaceWith(wrap);wrap.append(input);const b=document.createElement('button');b.type='button';b.dataset.passwordToggle='';b.textContent='👁';b.setAttribute('aria-label','비밀번호 보기');b.setAttribute('aria-pressed','false');wrap.append(b)})}
let noticeItems=[],historyOffset=0;
async function noticeList(){const r=await api('notice-list');noticeItems=r.items;open('공지 관리',`<div class="toolbar">${btn('notice-new','+ 새 공지 만들기')}</div>${noticeItems.map(n=>`<article class="panel"><p>${E(n.starts_on)} ~ ${E(n.ends_on)}</p><div class="operation-notice">📢 ${E(n.content)}</div><div class="toolbar">${btn('notice-edit','수정',n.id)}${btn('notice-delete','삭제',n.id,'danger')}</div></article>`).join('')||'<p>등록된 공지가 없습니다.</p>'}`)}
function noticeForm(id){const n=noticeItems.find(x=>x.id===id);open(n?'공지 수정':'새 공지 만들기',`<form data-form="notice-save" data-id="${E(n?.id||'')}"><div class="form-grid">${field('공지 시작일','startsOn',n?.starts_on||state.today,'date','required')}${field('공지 종료일','endsOn',n?.ends_on||state.today,'date','required')}<label class="field full">공지 내용<textarea name="content" required maxlength="2000">${E(n?.content||'')}</textarea></label></div>${actions('저장하기')}</form>`)}
const auditLabels={regular_schedules:'정기일정변경',schedule_overrides:'당일일정변경',applications:'신청서 변경',application_students:'신청 학생 변경',application_periods:'신청 교시 변경',rooms:'교실 설정 변경',room_periods:'개방 교시 변경',room_teachers:'교실 담당 변경',teachers:'교사 계정 변경',grade_heads:'학년부장 변경',approvals:'신청 동의 변경',lab_slots:'과학실 사용 변경',notices:'공지 변경'};
const auditFields={password_changed:'비밀번호 변경 여부',students:'신청 학생',periods:'신청 교시',title:'제목',room_id:'교실',weekday:'요일',start_period:'시작 교시',end_period:'종료 교시',starts_on:'시작일',ends_on:'종료일',use_date:'사용 날짜',owner_teacher_id:'담당 교사',supervising_teacher_id:'신청 담당 교사',reason:'신청 사유',status:'처리 상태',student_name:'학생 이름',student_number:'학번',content:'공지 내용',display_name:'교사 이름',login_id:'아이디',is_open:'개방 여부',required_approvals:'필요 동의 수',period:'교시',teacher_id:'교사',cancelled:'당일 취소',kind:'일정 종류',decision:'동의 여부',subject:'담당 과목',programs:'프로그램',active:'계정 사용',is_admin:'관리자',grade:'학년',device:'전자기기',rejection_reason:'거절 사유'};
function auditValue(k,v){if(v===null)return '담당 없음 / 미설정';if(k==='room_id')return state.rooms.find(r=>r.uuid===v)?.name||v;if(['owner_teacher_id','supervising_teacher_id','teacher_id'].includes(k))return userName(v);if(k==='weekday')return days[Number(v)%7]+'요일';if(k==='kind')return v==='night_study'?'야간자율학습':'일반 일정';if(k==='status')return ({pending:'승인 대기',accepted:'승인 완료',rejected:'거절',cancelled:'취소'})[v]||v;return typeof v==='object'?JSON.stringify(v):String(v)}
function auditSnapshot(x){if(!x)return '<p>없음</p>';return '<dl>'+Object.entries(x).filter(([k])=>!['id','application_id','regular_id','created_at','updated_at','position','credential_version'].includes(k)).map(([k,v])=>'<dt>'+E(auditFields[k]||k)+'</dt><dd>'+E(auditValue(k,v))+'</dd>').join('')+'</dl>'}
async function historyList(offset=0){historyOffset=offset;const r=await api('history',{offset});open('변경 이력 조회',`<p class="help">이번 업데이트 이후 저장된 변경만 기록됩니다. 시간은 한국 시간입니다. 학생 신청자의 이름은 입력 명단 기준이며 본인 인증 이름은 아닙니다.</p>${r.items.map(h=>`<article class="panel audit-entry"><small>${E(h.time)} · ${E(h.actor_name)}</small><h3>${E(h.table_name==='applications'&&h.operation==='INSERT'?'교실 신청 · '+(h.after_data?.title||'')+' · '+h.actor_name:auditLabels[h.table_name]||'설정 변경')}</h3><details><summary>자세히 보기 · ${{INSERT:'추가',UPDATE:'수정',DELETE:'삭제'}[h.operation]}</summary><div class="audit-columns"><section><h4>변경 전</h4>${auditSnapshot(h.before_data)}</section><section><h4>변경 후</h4>${auditSnapshot(h.after_data)}</section></div>${h.application?'<h4>신청서</h4>'+auditSnapshot(h.application):''}</details></article>`).join('')||'<p>기록된 변경이 없습니다.</p>'}<div class="toolbar">${offset?btn('history-prev','이전'):''}${r.items.length===50?btn('history-more','다음'):''}</div>`)}
