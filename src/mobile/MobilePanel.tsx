import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { getNative, label, post, subscribe, uuid, type Command, type Request } from './bridge';
export const useNative=()=>useSyncExternalStore(subscribe,getNative);
const name=(key:string)=>key==='codex.input'?label('Codex · 待回答','Codex · Answer requested'):key==='codex.commandApproval'?label('Codex · 命令授权','Codex · Command approval'):key==='codex.fileApproval'?label('Codex · 文件修改授权','Codex · File change approval'):label('待处理请求','Pending request');
const option=(key:string)=>/^option\.\d+$/.test(key)?label('选项 ','Option ')+key.split('.')[1]:label('请在电脑查看','Review on desktop');
const statuses:Record<string,[string,string]>={queued:['已排队','Queued'],delivered:['已送达桌面，等待确认','Delivered; waiting for confirmation'],succeeded:['桌面已确认完成','Desktop confirmed completion'],failed:['操作失败','Failed'],expired:['已过期','Expired']};
const resultLabel=(key:string)=>statuses[key]?label(...statuses[key]):key;
export function Connection(){
 const native=useNative();const [server,setServer]=useState(()=>localStorage.getItem('mobile:server')||'');const [token,setToken]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [confirm,setConfirm]=useState(false);
 async function act(type:string,fields:Record<string,unknown>={}){setBusy(true);setError('');try{await post(type,fields);if(type==='configure'){localStorage.setItem('mobile:server',server);setToken('');}}catch(e){setError(String(e));}finally{setBusy(false);}}
 return <section className="settings-group" data-section="mobile"><h3>{label('手机连接','Mobile connection')}</h3>
 {!native.configured?<><label className="sync-field"><span>{label('HTTPS 服务器地址','HTTPS server address')}</span><input aria-label="Server" type="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={server} maxLength={2048} onChange={e=>setServer(e.target.value)}/></label>
 <label className="sync-field"><span>{label('手机配对凭据','Pairing credential')}</span><input aria-label="Pairing credential" type="password" autoComplete="off" value={token} maxLength={512} onChange={e=>setToken(e.target.value)}/></label>
 <button className="save-button" data-action="pair" disabled={busy} onClick={()=>void act('configure',{server,token})}>{busy?label('正在连接…','Connecting…'):label('连接','Connect')}</button></>:
 <><p role="status" data-mobile-online={native.online}>{native.online?label('桌面在线','Desktop online'):label('桌面离线 / 状态已过期','Desktop offline / state expired')} · {native.connected?label('实时连接','Live connection'):label('每 5 秒刷新','Refresh every 5 seconds')}</p>
 <p className="appearance-hint">{native.pushStatus}</p><button className="dock-button" disabled={busy} onClick={()=>void act('notifications')}>{label('启用系统通知','Enable system notifications')}</button>
 <label className="checkbox-row"><input type="checkbox" checked={native.liveUpdatesEnabled===true} disabled={busy} onChange={e=>void act('liveUpdates',{enabled:e.target.checked})}/><span>{label('实时关注待回答 / 待授权','Follow pending answers and approvals live')}</span></label>
 <p className="appearance-hint">{label('在支持的系统界面显示待处理数量，点开进入 App 处理。可随时关闭；系统权限和设备支持情况会影响展示。','Show pending counts on supported system surfaces; tap to handle them in the app. Turn this off at any time. Visibility depends on system permission and device support.')}</p>
 {native.liveUpdatesStatus&&<p role="status">{native.liveUpdatesStatus}</p>}
 <button className="dock-button" disabled={busy} onClick={()=>setConfirm(true)}>{label('断开并注销此手机','Disconnect and revoke this phone')}</button>
 {confirm&&<div className="mobile-confirm" role="alertdialog"><p>{label('确认撤销此手机？网络失败时保留连接供重试。','Revoke this phone? The connection is retained if the network request fails.')}</p><button className="save-button" onClick={()=>{setConfirm(false);void act('logout');}}>{label('确认断开','Confirm disconnect')}</button><button className="dock-button" onClick={()=>setConfirm(false)}>{label('取消','Cancel')}</button></div>}</>}
 {(error||native.message)&&<p role="alert">{error||native.message}</p>}</section>;
}
const submissions=new Map<string,Command>();
const submissionExpiries=new Map<string,number>();
function RequestForm({request,onClose}:{request:Request;onClose:()=>void}){
 const native=useNative();const [answers,setAnswers]=useState<Record<string,string>>({});const [plain,setPlain]=useState('');const [confirm,setConfirm]=useState<Command|null>(null);const [busy,setBusy]=useState(false);const [message,setMessage]=useState('');
 const original=submissions.get(request.id);
 const full=request.fullContent;
 const live=native.online&&!native.state?.snapshot?.sample&&!native.state?.snapshot?.stale&&Date.now()<request.expiresAt&&native.state?.snapshot?.requests.some(r=>r.id===request.id)&&!native.state?.commands.some(c=>c.requestId===request.id);
 function prepare(kind:string){if(original){setConfirm(original);return;}const command:Command={id:uuid(),requestId:request.id,kind};
 if(kind==='answer'){if(request.questions?.length){if(request.questions.some(q=>q.isSecret||!answers[q.id]?.trim())){setMessage(label('请完整回答，敏感问题需在电脑处理','Complete every answer; sensitive questions require the desktop'));return;}command.answers=Object.fromEntries(request.questions.map(q=>[q.id,{answers:[answers[q.id]]}]));}else{if(!plain.trim())return;command.answer=plain;}}
 setConfirm(command);}
 useEffect(()=>{if(!live)setConfirm(null);},[live]);
 async function send(){if(!confirm||!live||busy||Date.now()>=request.expiresAt){setConfirm(null);return;}const command=confirm;setConfirm(null);submissions.set(request.id,command);submissionExpiries.set(request.id,request.expiresAt);setBusy(true);try{await post('submit',{command});setMessage(label('已排队，请等待桌面回执','Queued; wait for the desktop receipt'));onClose();}catch(e){setMessage(String(e));}finally{setBusy(false);}}
 return <section className="settings-group mobile-request"><h3>{name(request.title)}</h3><p>{request.detail==='fileChange'?label('文件修改','File change'):request.detail==='input'?label('结构化问答','Structured question'):request.detail}</p>
 <p className="appearance-hint">{full?label('以下原文由电脑开启完整内容同步后提供。请核对内容，再确认操作。','The desktop has enabled full-content sync. Review the content below before confirming an action.'):label('完整内容仅保留在电脑；手机只显示类别和编号，请先在电脑确认上下文。','Full content stays on the desktop. This phone shows categories and numbers. Review the context on the desktop first.')}</p>
 {full&&<dl className="mobile-full-content">{(['command','cwd','reason','grantRoot'] as const).filter(key=>full[key]!==undefined).map(key=><div key={key}><dt>{({command:label('命令','Command'),cwd:label('工作路径','Working directory'),reason:label('原因','Reason'),grantRoot:label('请求路径','Requested path')})[key]}</dt><dd><pre data-full-content={key}>{full[key]}</pre></dd></div>)}</dl>}
 {!live&&<p>{label('请求已处理、已过期或桌面离线','The request was handled, expired, or the desktop is offline')}</p>}
 <fieldset disabled={busy||Boolean(original)||!live}>
 {request.kind==='input'&&(request.questions?.length?request.questions.map((q,index)=>{const originalQuestion=full?.questions?.find(item=>item.id===q.id);return <div key={q.id}><h4>{originalQuestion?.header||`${label('第 ','Question ')}${index+1}`}</h4>{originalQuestion&&<p className="mobile-full-question" data-full-content="question">{originalQuestion.question}</p>}{q.isSecret?<p>{label('敏感回答请在电脑提交','Submit sensitive answers on the desktop')}</p>:<><div className="segmented">{q.options?.map((o,optionIndex)=><button key={o.label} className={answers[q.id]===o.label?'selected':''} data-option={o.label} onClick={()=>setAnswers({...answers,[q.id]:o.label})}>{originalQuestion?.options[optionIndex]?.label||option(o.label)}{originalQuestion?.options[optionIndex]?.description&&<small>{originalQuestion.options[optionIndex].description}</small>}</button>)}</div>{(q.isOther||!q.options?.length)&&<textarea aria-label={label('填写回答','Enter answer')} maxLength={4000} value={answers[q.id]?.startsWith('option.')?'':answers[q.id]||''} onChange={e=>setAnswers({...answers,[q.id]:e.target.value})}/>}</>}</div>;}):<textarea aria-label={label('填写回答','Enter answer')} maxLength={4000} value={plain} onChange={e=>setPlain(e.target.value)}/>)}
 </fieldset>
 {original?<button className="save-button" disabled={busy||!live} onClick={()=>setConfirm(original)}>{label('重试原操作','Retry original action')}</button>:request.kind==='input'?<button className="save-button" data-action="answer" disabled={busy||!live} onClick={()=>prepare('answer')}>{label('发送回答','Send answer')}</button>:<div className="segmented"><button data-action="approve" disabled={busy||!live} onClick={()=>prepare('approve')}>{label('批准本次请求','Approve this request')}</button><button data-action="deny" disabled={busy||!live} onClick={()=>prepare('deny')}>{label('拒绝本次请求','Deny this request')}</button></div>}
 {confirm&&<div className="mobile-confirm" role="alertdialog"><p>{label('确认操作：','Confirm action: ')}{confirm.kind==='answer'?label('发送回答','Send answer'):confirm.kind==='approve'?label('批准','Approve'):label('拒绝','Deny')}？</p><button className="save-button" data-action="confirm" onClick={()=>void send()}>{label('确认','Confirm')}</button><button className="dock-button" onClick={()=>setConfirm(null)}>{label('取消','Cancel')}</button></div>}
 {message&&<p role="status">{message}</p>}<button className="dock-button" onClick={onClose}>{label('返回消息','Back to inbox')}</button></section>;
}
export function MobileModal({open,onClose,provider}:{open:boolean;onClose:()=>void;provider?:string}){
 const native=useNative();const ref=useRef<HTMLDialogElement>(null);const [selectedId,setSelectedId]=useState<string|null>(null);const [read,setRead]=useState<string[]>([]);const [now,setNow]=useState(Date.now);
 const key='mobile:read:'+native.accountKey;
 useEffect(()=>{submissions.clear();submissionExpiries.clear();setSelectedId(null);},[native.accountKey]);
 useEffect(()=>{if(!open)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[open]);
 useEffect(()=>{for(const [id,expires] of submissionExpiries){if(expires<=Date.now()||native.state?.commands.some(c=>c.requestId===id&&['succeeded','failed','expired'].includes(c.status))){submissions.delete(id);submissionExpiries.delete(id);}}},[native.state,now]);
 useEffect(()=>{try{setRead(JSON.parse(localStorage.getItem(key)||'[]'));}catch{setRead([]);}},[key]);
 useEffect(()=>{if(open&&!ref.current?.open)ref.current?.showModal();if(!open&&ref.current?.open)ref.current?.close();},[open]);
 useEffect(()=>{if(!open)setSelectedId(null);},[open]);
 function mark(ids:string[]){const next=[...new Set([...read,...ids])].slice(-200);setRead(next);localStorage.setItem(key,JSON.stringify(next));}
 const alerts=native.state?.alerts||[];const requests=(native.state?.snapshot?.requests||[]).filter(r=>!provider||r.provider===provider);
 const selected=requests.find(r=>r.id===selectedId&&r.expiresAt>Date.now()&&!native.state?.commands.some(c=>c.requestId===r.id&&['succeeded','failed','expired'].includes(c.status)))||null;
 useEffect(()=>{if(selectedId&&!selected)setSelectedId(null);},[selectedId,selected]);
 return <dialog ref={ref} className="settings-dialog mobile-dialog" onCancel={onClose}><div className="settings-heading"><h2>{label('连接与消息','Connection and inbox')}</h2><button className="icon-button" aria-label="Close mobile panel" onClick={onClose}><X size={18}/></button></div><div className="settings-content">
 {selected?<RequestForm key={selected.id} request={selected} onClose={()=>setSelectedId(null)}/>:<><Connection/>
 {native.configured&&<><section className="settings-group"><h3>{label('待处理请求','Pending requests')}</h3>{native.state?.snapshot?.limited&&<p>{label('部分请求未同步，请在电脑查看完整列表','Some requests were omitted. Review the complete list on the desktop.')}</p>}
 {!requests.length&&<p>{label('暂无可操作请求','No actionable requests')}</p>}{requests.map(r=><button className="dock-button" data-request={r.id} key={r.id} disabled={!native.online||native.state?.snapshot?.sample||native.state?.snapshot?.stale||Date.now()>=r.expiresAt||native.state?.commands.some(c=>c.requestId===r.id)} onClick={()=>setSelectedId(r.id)}>{name(r.title)}</button>)}</section>
 <section className="settings-group"><h3>{label('消息中心','Inbox')} · {alerts.filter(a=>!read.includes(a.id)).length} {label('未读','unread')}</h3><p className="appearance-hint">{label('无需推送凭据；前台接收，重新打开补收。后台系统通知仍需平台推送服务。','No push credentials required: receive while open and catch up on reopening. Background notifications still need a platform push service.')}</p>
 <button className="dock-button" data-action="read-all" onClick={()=>mark(alerts.map(a=>a.id))}>{label('全部标为已读','Mark all as read')}</button>
 {[...alerts].reverse().map(a=><button key={a.id} className="dock-button mobile-alert" data-alert={a.type} onClick={()=>{mark([a.id]);const r=requests.find(r=>r.id===a.requestId);if(r&&a.active)setSelectedId(r.id);}}>{!read.includes(a.id)&&'● '}{a.provider} · {a.type==='input'?label('待回答','Answer requested'):a.type==='approval'?label('待授权','Approval requested'):label('低额度','Low quota')} · {a.active?label('待处理','Active'):label('已结束','Resolved')}</button>)}</section>
 <section className="settings-group"><h3>{label('操作回执','Action receipts')}</h3>{[...(native.state?.commands||[])].reverse().slice(0,20).map(c=><p data-receipt={c.status} key={c.id}>{resultLabel(c.status)}{c.error?' · '+c.error:''}</p>)}</section></>}
 </>}
 </div></dialog>;
}
