"""교실빌리자 · Python 3.10+ / 표준 라이브러리만 사용. 공개 배포 시 HTTPS reverse proxy 필수."""
import csv, hashlib, hmac, io, json, mimetypes, os, re, secrets, sqlite3, time
from pathlib import Path
from datetime import datetime, timedelta, timezone, date
from http.cookies import SimpleCookie
from urllib.parse import parse_qs
BASE=Path(__file__).resolve().parent
KST=timezone(timedelta(hours=9))
DB=BASE/'data'/'classroom.sqlite3'
class Problem(Exception):
    def __init__(self,msg,status=400): self.msg,self.status=msg,status

def today(): return datetime.now(KST).date().isoformat()
def uid(): return secrets.token_hex(12)
def password_hash(p):
    salt=secrets.token_hex(16)
    return salt+':'+hashlib.pbkdf2_hmac('sha256',p.encode(),salt.encode(),260000).hex()
def verify(p,v):
    try:
        salt,digest=v.split(':'); return hmac.compare_digest(hashlib.pbkdf2_hmac('sha256',p.encode(),salt.encode(),260000).hex(),digest)
    except (ValueError,AttributeError): return False

def connect():
    c=sqlite3.connect(DB,timeout=20); c.execute('PRAGMA foreign_keys=ON'); return c

def initialize():
    DB.parent.mkdir(exist_ok=True)
    c=connect()
    c.executescript('CREATE TABLE IF NOT EXISTS store (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user TEXT, expires REAL); CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, failures INTEGER, since REAL); CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at TEXT, actor TEXT, action TEXT, target TEXT);')
    if not c.execute('SELECT 1 FROM store').fetchone():
        s=json.loads((BASE/'seed.json').read_text('utf-8')); accounts=[]
        for u in s['users']:
            p=secrets.token_urlsafe(12) if u['role']=='admin' else 'helloCB'; u['hash']=password_hash(p); accounts.append([u['name'],u['id'],p])
        c.execute('INSERT INTO store VALUES(1,?)',(json.dumps(s,ensure_ascii=False),))
        with (DB.parent/'initial_accounts.csv').open('w',encoding='utf-8-sig',newline='') as f:
            w=csv.writer(f); w.writerow(['이름','아이디','초기 비밀번호']); w.writerows(accounts)
        try: os.chmod(DB.parent/'initial_accounts.csv',0o600)
        except OSError: pass
        print('초기 계정: data/initial_accounts.csv (안전하게 전달한 후 삭제하세요.)')
    # 기존 DB는 보존하고 진로실·교사만 일회성 추가합니다.
    s=json.loads(c.execute('SELECT body FROM store WHERE id=1').fetchone()[0])
    if not any(x['id']=='진로실' for x in s['rooms']):
        t=next((x for x in s['users'] if x['name']=='이계식'),None)
        if not t:
            ident='이계식'
            while any(x['id']==ident for x in s['users']): ident='career-'+uid()[:8]
            pw='helloCB'
            t=dict(id=ident,name='이계식',rooms=[],subject='진로',programs=[],role='teacher',hash=password_hash(pw))
            s['users'].append(t)
            with (DB.parent/'career_initial_account.csv').open('w',encoding='utf-8-sig',newline='') as f:
                w=csv.writer(f); w.writerow(['이름','아이디','초기 비밀번호']); w.writerow(['이계식',ident,pw])
            try: os.chmod(DB.parent/'career_initial_account.csv',0o600)
            except OSError: pass
            print('추가 계정: data/career_initial_account.csv')
        if '진로실' not in t['rooms']: t['rooms'].append('진로실')
        s['rooms'].append(dict(id='진로실',open=True,periods=[1,2],required=1,teachers=[t['id']]))
        c.execute('UPDATE store SET body=? WHERE id=1',(json.dumps(s,ensure_ascii=False),))
    c.commit(); c.close()

def check(v,msg,status=400):
    if not v: raise Problem(msg,status)
def user_by(s,k): return next((u for u in s['users'] if u['id']==k),None)
def room_by(s,k):
    r=next((r for r in s['rooms'] if r['id']==k),None); check(r,'교실을 찾을 수 없습니다.',404); return r

def date_check(d,write=False):
    try: dt=date.fromisoformat(d)
    except (ValueError,TypeError): raise Problem('날짜 형식이 올바르지 않습니다.')
    t=date.fromisoformat(today())
    check(t<=dt<=t+timedelta(days=14) if write else t-timedelta(days=1)<=dt<=t+timedelta(days=14),'신청은 오늘부터 14일 후까지, 현황은 어제부터 확인할 수 있습니다.')

def schedules_for(s,d,r):
    wd=date.fromisoformat(d).isoweekday()%7
    recurring=[x for x in s['schedules'] if not x['date'] and x['day']==wd]
    overrides=[x for x in s['schedules'] if x['date']==d]
    replaced={x['base'] for x in overrides if x.get('base')}
    return [x for x in recurring+overrides if x['room']==r and x['id'] not in replaced and not x.get('cancel')]

def blocked(s,d,r,p,exclude=None):
    room=room_by(s,r)
    if not room['open'] or p not in room['periods']: return '미개방'
    for a in s['apps']:
        if a['id']!=exclude and a['status']=='accepted' and a['date']==d and a['room']==r and p in a['periods']: return '이미 승인된 대여'
    for x in schedules_for(s,d,r):
        if p<=x['end']: return x['title']
    for x in s['labs']:
        if x['date']==d and x['room']==r and x['slot']==f'야자{p}': return '교사 과학실 사용'
    return ''

def can_manage(u,r): return bool(u and (u['role']=='admin' or u['id'] in r['teachers']))
def can_app(u,a,s): return bool(u and (can_manage(u,room_by(s,a['room'])) or u['id']==a['teacher']))
def teacher(u): check(u,'로그인이 필요합니다.',401)
def admin(u): teacher(u); check(u['role']=='admin','관리자 권한이 필요합니다.',403)
def periods(v):
    check(isinstance(v,list) and bool(v) and len(v)<=2 and all(type(x) is int and x in (1,2) for x in v),'교시를 선택해주세요.'); return sorted(set(v))
def people(b):
    ids=[x.strip() for x in b.get('studentIds','').split(',')]
    names=[x.strip() for x in b.get('names','').split(',')]
    check(1<=len(ids)<=50 and len(ids)==len(names),'학번과 이름을 같은 인원수로 쉼표로 구분해주세요.')
    check(all(re.fullmatch(r'\d{4,10}',x) for x in ids),'학번은 4~10자리 숫자로 입력해주세요.')
    check(len(set(ids))==len(ids),'중복 학번을 확인해주세요.')
    check(all(1<=len(x)<=30 for x in names),'이름을 확인해주세요.')
    reason=b.get('reason','').strip(); check(1<=len(reason)<=1500,'신청 사유는 1~1500자입니다.')
    device=b.get('device','X'); check(device in ('O','X'),'전자기기 사용 여부를 선택해주세요.')
    return ids,names,reason,device

def title(a): return a['studentIds'][0]+' '+a['names'][0]+(f" 외 {len(a['names'])-1}명" if len(a['names'])>1 else '')
def public_user(u): return {k:v for k,v in u.items() if k!='hash'} if u else None

def public_app(a,u,s):
    if u: return {**{k:v for k,v in a.items() if k!='hash'},'title':title(a),'canManage':can_app(u,a,s),'canEdit':u['role']=='admin' or u['id'] in a['approvedBy']}
    # 비로그인 화면에는 개인정보 전체 대신 마스킹된 대표자만 공개
    if a['status']=='accepted':
        return {k:a[k] for k in ['id','date','room','periods','status','teacher','approvedBy','created']} | {'title':', '.join(sid+' '+name for sid,name in zip(a['studentIds'],a['names'])),'canManage':False,'canEdit':False}
    name=a['names'][0]; sid=a['studentIds'][0]
    masked=sid[:2]+'*'*(len(sid)-2)+' '+name[:1]+'*'*(len(name)-1)
    return {k:a[k] for k in ['id','date','room','periods','status','teacher','approvedBy','created']} | {'title':masked+(f" 외 {len(a['names'])-1}명" if len(a['names'])>1 else ''),'canManage':False,'canEdit':False}

def rate(c,key):
    row=c.execute('SELECT failures,since FROM limits WHERE key=?',(key,)).fetchone()
    check(not row or row[0]<8 or time.time()-row[1]>600,'시도가 너무 많습니다. 10분 후 다시 시도해주세요.',429)
def failed(c,key):
    row=c.execute('SELECT failures,since FROM limits WHERE key=?',(key,)).fetchone(); n,since=(row if row and time.time()-row[1]<=600 else (0,time.time()))
    c.execute('INSERT OR REPLACE INTO limits VALUES(?,?,?)',(key,n+1,since))

def dispatch(c,s,action,b,u,ip='local'):
    """All mutating calls run under BEGIN IMMEDIATE in application()."""
    if action=='apply':
        d=b.get('date'); date_check(d,True); r=room_by(s,b.get('room')); ps=periods(b.get('periods'))
        for p in ps: check(not blocked(s,d,r['id'],p),'신청할 수 없는 교시가 포함되어 있습니다. 새로고침 후 확인해주세요.',409)
        check(b.get('teacher') in r['teachers'],'해당 교실의 담당 선생님을 선택해주세요.')
        ids,names,reason,device=people(b); pw=b.get('password',''); check(isinstance(pw,str) and bool(pw),'신청 비밀번호를 입력해주세요.')
        check(not any(a['status']=='pending' and a['date']==d and a['room']==r['id'] and a['studentIds']==ids and set(a['periods'])==set(ps) for a in s['apps']),'동일한 신청이 대기 중입니다.',409)
        a=dict(id=uid(),date=d,room=r['id'],periods=ps,studentIds=ids,names=names,reason=reason,device=device,teacher=b['teacher'],hash=password_hash(pw),status='pending',approvedBy=[],rejectionReason='',created=time.time())
        s['apps'].append(a); return {'id':a['id']}
    if action in ('detail','cancel','approve','reject','edit'):
        a=next((a for a in s['apps'] if a['id']==b.get('id')),None); check(a,'신청을 찾을 수 없습니다.',404)
        if action in ('detail','cancel') and not u:
            key=ip+':app:'+a['id']; rate(c,key)
            if not verify(b.get('password',''),a['hash']): failed(c,key); raise Problem('신청 비밀번호가 일치하지 않습니다.',403)
        if action=='detail': return public_app(a,{'role':'viewer','id':''},s)
        if action=='cancel':
            # 취소는 로그인 교사도 담당 권한을 재검사
            if u: check(can_app(u,a,s),'담당 신청만 취소할 수 있습니다.',403)
            check(a['status'] in ('pending','accepted'),'취소할 수 없는 상태입니다.',409); a['status']='cancelled'; return {}
        teacher(u); check(can_app(u,a,s),'본인 담당 신청에만 처리할 수 있습니다.',403)
        if action=='edit':
            check(a['status']=='accepted' and (u['role']=='admin' or u['id'] in a['approvedBy']),'승인한 선생님만 내용을 수정할 수 있습니다.',403)
            ids,names,reason,device=people(b); check(b.get('teacher') in room_by(s,a['room'])['teachers'],'담당 교사를 확인해주세요.')
            a.update(studentIds=ids,names=names,reason=reason,device=device,teacher=b['teacher']); return {}
        check(a['status']=='pending','이미 처리된 신청입니다.',409)
        date_check(a['date'],True)
        if action=='reject': a.update(status='rejected',rejectionReason=str(b.get('reason',''))[:1500]); return {}
        for p in a['periods']: check(not blocked(s,a['date'],a['room'],p,a['id']),'다른 예약·일정과 충돌합니다. 승인할 수 없습니다.',409)
        check(u['id'] not in a['approvedBy'],'이미 동의한 신청입니다.',409)
        a['approvedBy'].append(u['id']); r=room_by(s,a['room'])
        eligible=[x for x in a['approvedBy'] if x in r['teachers'] or (user_by(s,x) or {}).get('role')=='admin']
        if len(eligible)>=r['required']:
            a['status']='accepted'
            # 남은 충돌 대기는 보관하되 거절 상태로 일관성 유지
            for other in s['apps']:
                if other['id']!=a['id'] and other['status']=='pending' and other['date']==a['date'] and other['room']==a['room'] and set(other['periods'])&set(a['periods']): other.update(status='rejected',rejectionReason='동일 시간대의 다른 신청이 최종 승인되었습니다.')
        return {}
    teacher(u)
    if action=='room':
        r=room_by(s,b.get('room')); check(can_manage(u,r),'담당 교실만 관리할 수 있습니다.',403)
        ps=periods(b.get('periods')); n=b.get('required',r['required']); check(type(n) is int and 1<=n<=len(r['teachers']),'동의 인원수를 확인해주세요.')
        check(type(b.get('open')) is bool,'개방 여부를 확인해주세요.')
        check(not any(a['status']=='accepted' and a['room']==r['id'] and a['date']>=today() and (not b['open'] or not set(a['periods'])<=set(ps)) for a in s['apps']),'기존 승인 예약이 있습니다. 해당 예약을 먼저 취소해주세요.',409)
        if 'name' in b:
            admin(u)
            name=str(b['name']).strip()
            check(1<=len(name)<=40,'교실 이름은 1~40자로 입력해주세요.')
            check(not any(v['id']!=r['id'] and v.get('name',v['id'])==name for v in s['rooms']),'이미 사용 중인 교실 이름입니다.')
            r['name']=name
        r.update(open=b['open'],periods=ps,required=n); return {}
    if action in ('schedule','schedule-delete'):
        old=next((x for x in s['schedules'] if x['id']==b.get('id')),None)
        if old: check(u['role']=='admin' or old['owner']==u['id'],'본인 담당 일정만 수정할 수 있습니다.',403)
        else: check(action!='schedule-delete','일정이 없습니다.',404)
        if action=='schedule-delete':
            check(not any(x.get('base')==old['id'] for x in s['schedules']),'당일 변경이 연결된 일정입니다. 당일 변경을 먼저 삭제해주세요.',409)
            s['schedules'].remove(old); return {}
        owner=b.get('owner',''); name=b.get('title','').strip(); check(1<=len(name)<=60,'일정 제목을 입력해주세요.')
        check(u['role']=='admin' or owner==u['id'],'본인이 담당하는 일정만 추가·변경할 수 있습니다.',403)
        check(not owner or user_by(s,owner),'담당 교사를 확인해주세요.')
        if name in ('야자','야간자율학습'):
            head=next((v for v in s['users'] if v.get('gradeHead')),None)
            check(head,'관리자가 먼저 학년 부장을 지정해주세요.')
            owner=head['id']
            check(u['role']=='admin' or owner==u['id'],'야자는 학년 부장이 담당합니다.',403)
        r=room_by(s,b.get('room')); end=b.get('end'); check(type(end) is int and end in (1,2),'종료 교시를 확인해주세요.')
        d=b.get('date',''); day=b.get('day',1); base=b.get('base','')
        if not d: check(type(day) is int and day in (1,2,3,4,5),'반복 요일은 월~금요일만 선택할 수 있습니다.')
        if d: date_check(d,True)
        else: check(type(day) is int and 0<=day<=6,'요일을 확인해주세요.')
        if base:
            orig=next((x for x in s['schedules'] if x['id']==base and not x['date']),None); check(orig and d,'주기 일정을 선택해주세요.'); check(u['role']=='admin' or orig['owner']==u['id'],'담당 일정만 변경할 수 있습니다.',403)
            check(not any(x.get('base')==base and x['date']==d and x['id']!=b.get('id') for x in s['schedules']),'이미 당일 변경이 있습니다. 기존 변경을 수정·삭제해주세요.',409)
        x=dict(id=old['id'] if old else uid(),room=r['id'],title=name,owner=owner,end=end,date=d,day=day,base=base,cancel=bool(b.get('cancel',False)))
        trial={**s,'schedules':[v for v in s['schedules'] if not old or v['id']!=old['id']]+[x]}
        for i in range(15):
            dd=(date.fromisoformat(today())+timedelta(days=i)).isoformat()
            for rr in s['rooms']:
                sched=schedules_for(trial,dd,rr['id'])
                check(len(sched)<=1,'정기·당일 일정 간 교실·시간 충돌이 있습니다.',409)
                if sched:
                    z=sched[0]
                    check(not any(a['status']=='accepted' and a['date']==dd and a['room']==rr['id'] and any(p<=z['end'] for p in a['periods']) for a in s['apps']),'승인된 학생 대여와 충돌합니다.',409)
                    check(not any(v['date']==dd and v['room']==rr['id'] and v['slot'] in [f'야자{p}' for p in range(1,z['end']+1)] for v in s['labs']),'교사 과학실 사용과 충돌합니다.',409)
        s['schedules']=trial['schedules']
        owner_user=user_by(s,owner)
        if owner_user and name not in owner_user['programs']: owner_user['programs'].append(name)
        return {}
    if action=='lab':
        d=b.get('date'); date_check(d,True); r=room_by(s,b.get('room')); check(r['id'].startswith('과학') and can_manage(u,r),'과학실 담당 교사만 사용할 수 있습니다.',403)
        slot=b.get('slot'); check(slot in [str(i) for i in range(1,8)]+['방과후','야자1','야자2'],'시간을 확인해주세요.')
        old=next((x for x in s['labs'] if x['date']==d and x['room']==r['id'] and x['slot']==slot),None)
        if b.get('cancel'):
            check(old and (old['user']==u['id'] or u['role']=='admin'),'본인의 사용 일정만 취소할 수 있습니다.',403); s['labs'].remove(old)
        else:
            check(not old,'이미 사용 중입니다.',409)
            if slot.startswith('야자'): check(not blocked(s,d,r['id'],int(slot[-1])),'학생 대여 또는 정기 일정과 충돌합니다.',409)
            s['labs'].append(dict(date=d,room=r['id'],slot=slot,user=u['id']))
        return {}
    if action=='profile':
        check(verify(b.get('currentPassword',''),u['hash']),'현재 비밀번호가 일치하지 않습니다.',403)
        new=b.get('newId',u['id']).strip(); check(1<=len(new)<=50 and (new==u['id'] or not user_by(s,new)),'사용할 수 없는 아이디입니다.')
        pw=b.get('newPassword',''); check(isinstance(pw,str),'비밀번호를 확인해주세요.')
        if pw: u['hash']=password_hash(pw)
        if new!=u['id']: rename_user(c,s,u,new)
        u['subject']=str(b.get('subject',u['subject']))[:60]
        # 담당 교실·프로그램은 권한 상승 방지를 위해 관리자만 배정
        c.execute('DELETE FROM sessions WHERE user=?',(u['id'],)); return {'relogin':True}
    admin(u)
    if action=='user':
        target=user_by(s,b.get('id'))
        if not target:
            name=b.get('name','').strip(); ident=b.get('id','').strip(); check(name and ident and len(ident)<=50 and len(name)<=30,'이름과 아이디를 입력해주세요.')
            pw=b.get('password',''); check(isinstance(pw,str) and bool(pw),'초기 비밀번호를 입력해주세요.')
            target=dict(id=ident,name=name,hash=password_hash(pw),role='teacher',rooms=[],programs=[],subject=''); s['users'].append(target)
        new=b.get('newId',target['id']).strip()
        check(new and len(new)<=50 and (new==target['id'] or not user_by(s,new)),'사용할 수 없는 아이디입니다.')
        if new!=target['id']: rename_user(c,s,target,new)
        if b.get('password'):
            check(isinstance(b['password'],str),'비밀번호를 확인해주세요.'); target['hash']=password_hash(b['password']); c.execute('DELETE FROM sessions WHERE user=?',(target['id'],))
        rr=b.get('rooms',target['rooms']); pp=b.get('programs',target['programs']); check(isinstance(rr,list) and all(x in [r['id'] for r in s['rooms']] for x in rr),'교실을 확인해주세요.')
        check(isinstance(pp,list) and len(pp)<=20 and all(isinstance(x,str) and 1<=len(x)<=60 for x in pp),'프로그램 이름을 확인해주세요.')
        for r in s['rooms']:
            assigned=[x for x in r['teachers'] if x!=target['id']]+([target['id']] if r['id'] in rr else [])
            check(len(assigned)>=r['required'],'교실의 동의 필요 인원보다 담당자가 적어집니다. 개방 설정을 먼저 조정해주세요.')
            r['teachers']=assigned
        if 'gradeHead' in b:
            check(type(b['gradeHead']) is bool,'학년 부장 여부를 확인해주세요.')
            if b['gradeHead']:
                for v in s['users']: v['gradeHead']=False
            target['gradeHead']=b['gradeHead']
            head=next((v for v in s['users'] if v.get('gradeHead')),None)
            for x in s['schedules']:
                if x['title'] in ('야자','야간자율학습'): x['owner']=head['id'] if head else ''
        target.update(rooms=rr,programs=pp,subject=str(b.get('subject',target['subject']))[:60]); return {}
    if action=='backup': return {'data':{**s,'users':[public_user(x) for x in s['users']],'apps':[{k:v for k,v in a.items() if k!='hash'} for a in s['apps']]},'exported':datetime.now(KST).isoformat()}
    if action=='audit': return {'rows':c.execute('SELECT at,actor,action,target FROM audit ORDER BY id DESC LIMIT 200').fetchall()}
    raise Problem('지원하지 않는 요청입니다.',404)

def rename_user(c,s,u,new):
    old=u['id']; u['id']=new
    for r in s['rooms']: r['teachers']=[new if x==old else x for x in r['teachers']]
    for a in s['apps']:
        if a['teacher']==old: a['teacher']=new
        a['approvedBy']=[new if x==old else x for x in a['approvedBy']]
    for x in s['schedules']:
        if x['owner']==old: x['owner']=new
    for x in s['labs']:
        if x['user']==old: x['user']=new
    c.execute('UPDATE sessions SET user=? WHERE user=?',(new,old))

def application(env,start):
    headers=[('X-Content-Type-Options','nosniff'),('Referrer-Policy','same-origin'),('X-Frame-Options','DENY')]
    path=env.get('PATH_INFO','/'); status=200; response={}; c=None
    try:
        if not path.startswith('/api/'):
            check(env.get('REQUEST_METHOD')=='GET','허용되지 않는 요청입니다.',405)
            name={'/':'index.html','/index.html':'index.html','/style.css':'style.css','/script.js':'script.js'}.get(path)
            check(name,'찾을 수 없습니다.',404)
            raw=(BASE/'web'/name).read_bytes(); headers.append(('Content-Type',mimetypes.guess_type(name)[0] or 'text/plain')); headers.append(('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"))
            start('200 OK',headers+[('Content-Length',str(len(raw)))]); return [raw]
        headers.extend([('Content-Type','application/json; charset=utf-8'),('Cache-Control','no-store')])
        c=connect(); c.execute('BEGIN IMMEDIATE')
        s=json.loads(c.execute('SELECT body FROM store WHERE id=1').fetchone()[0])
        jar=SimpleCookie(); jar.load(env.get('HTTP_COOKIE','')); token=jar['classroom_session'].value if 'classroom_session' in jar else ''
        sess=c.execute('SELECT user FROM sessions WHERE token=? AND expires>?',(token,time.time())).fetchone(); u=user_by(s,sess[0]) if sess else None
        action=path.removeprefix('/api/')
        if env.get('REQUEST_METHOD')=='GET':
            check(action=='state','대상을 찾을 수 없습니다.',404)
            q=parse_qs(env.get('QUERY_STRING','')); d=q.get('date',[today()])[0]; date_check(d)
            apps=[a for a in s['apps'] if a['date']==d or (u and a['status']=='pending' and a['date']>=today())]
            month=q.get('month',[''])[0]
            if month:
                teacher(u); check(re.fullmatch(r'\d{4}-\d{2}',month),'월을 확인해주세요.')
                first=date.fromisoformat(today()).replace(day=1); prev=(first-timedelta(days=1)).strftime('%Y-%m')
                check(month in (first.strftime('%Y-%m'),prev),'현재 달과 이전 달만 조회할 수 있습니다.')
                apps=[a for a in s['apps'] if a['date'].startswith(month) and a['status']=='accepted' and (u['role']=='admin' or u['id'] in room_by(s,a['room'])['teachers'])]
            response=dict(today=today(),user=public_user(u),users=[public_user(x) for x in s['users']] if u else [],rooms=s['rooms'],apps=[public_app(a,u,s) for a in apps],schedules=s['schedules'],labs=[x for x in s['labs'] if x['date']==d])
        else:
            check(env.get('REQUEST_METHOD')=='POST','POST만 허용됩니다.',405)
            check(env.get('HTTP_X_REQUESTED_WITH')=='ClassroomON','요청을 확인할 수 없습니다.',403)
            length=int(env.get('CONTENT_LENGTH') or 0); check(0<length<=65536,'요청 크기를 확인해주세요.',413)
            try: b=json.loads(env['wsgi.input'].read(length)); check(isinstance(b,dict),'요청 형식을 확인해주세요.')
            except (ValueError,UnicodeError): raise Problem('JSON 요청 형식을 확인해주세요.')
            ip=env.get('REMOTE_ADDR','unknown')
            if action=='login':
                key=ip+':login'; rate(c,key); who=user_by(s,b.get('id'))
                if not who or not verify(b.get('password',''),who['hash']): failed(c,key); raise Problem('아이디 또는 비밀번호가 올바르지 않습니다.',401)
                c.execute('DELETE FROM sessions WHERE expires<?',(time.time(),)); token=secrets.token_urlsafe(32); c.execute('INSERT INTO sessions VALUES(?,?,?)',(token,who['id'],time.time()+28800)); c.execute('DELETE FROM limits WHERE key=?',(key,))
                secure='; Secure' if env.get('wsgi.url_scheme')=='https' or env.get('HTTP_X_FORWARDED_PROTO')=='https' else ''
                headers.append(('Set-Cookie','classroom_session='+token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800'+secure)); response={'user':public_user(who)}
            elif action=='logout':
                c.execute('DELETE FROM sessions WHERE token=?',(token,)); headers.append(('Set-Cookie','classroom_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')); response={}
            else:
                # 비밀번호 오류 횟수는 보존하되 데이터 변경은 실패 시 모두 롤백
                c.execute('SAVEPOINT mutation')
                try: response=dispatch(c,s,action,b,u,ip)
                except Problem:
                    # 실패 횟수는 SAVEPOINT 이전에 기록해야 하므로 여기서 복원
                    limits=c.execute('SELECT * FROM limits').fetchall(); c.execute('ROLLBACK TO mutation')
                    for row in limits: c.execute('INSERT OR REPLACE INTO limits VALUES(?,?,?)',row)
                    raise
                c.execute('UPDATE store SET body=? WHERE id=1',(json.dumps(s,ensure_ascii=False),))
                if action not in ('detail','backup','audit'): c.execute('INSERT INTO audit(at,actor,action,target) VALUES(?,?,?,?)',(datetime.now(KST).isoformat(),u['id'] if u else 'student',action,str(b.get('id',b.get('room','')))))
        c.commit()
    except Problem as e:
        if c: c.commit()
        status=e.status; response={'error':e.msg}
    except Exception:
        if c: c.rollback()
        status=500; response={'error':'처리 중 오류가 발생했습니다. 관리자에게 문의해주세요.'}
        import traceback; traceback.print_exc()
    finally:
        if c: c.close()
    raw=json.dumps(response,ensure_ascii=False).encode(); headers.append(('Content-Length',str(len(raw))))
    start(f'{status} '+{200:'OK',400:'Bad Request',401:'Unauthorized',403:'Forbidden',404:'Not Found',405:'Method Not Allowed',409:'Conflict',413:'Payload Too Large',429:'Too Many Requests',500:'Internal Server Error'}.get(status,'Error'),headers)
    return [raw]

if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser(); p.add_argument('--init-only',action='store_true'); p.add_argument('--host',default='127.0.0.1'); p.add_argument('--port',type=int,default=8000); args=p.parse_args()
    initialize()
    if not args.init_only:
        from wsgiref.simple_server import make_server
        print(f'교실빌리자: http://{args.host}:{args.port} · 종료 Ctrl+C')
        make_server(args.host,args.port,application).serve_forever()
