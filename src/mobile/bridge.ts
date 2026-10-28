import { providers, providerIds } from '../data';
import { createI18n } from '../i18n';
import { emptyJournal, record, type Journal } from '../journal';
import type { LocalStatus, PanelState, ProviderId } from '../types';

export type Question = { id:string; header?:string; options?:{label:string}[]; isOther?:boolean; isSecret?:boolean };
export type FullRequestContent = { command?:string; cwd?:string; reason?:string; grantRoot?:string; questions?:{id:string;header:string;question:string;options:{label:string;description:string}[]}[] };
export type Request = { id:string; provider:string; kind:'input'|'approval'; title:string; detail:string; expiresAt:number; questions?:Question[]; fullContent?:FullRequestContent };
export type WireState = { online:boolean; receivedAt:number; snapshot?:{ p:{i:ProviderId;c:string;a:string;n:number;w?:'input'|'approval'|'both';q:{m:string;p:string;r:number|null;s?:boolean;z?:string}[]}[]; requests:Request[]; sample?:boolean; stale?:boolean; limited?:boolean } | null;
 commands:{id:string;requestId:string;status:string;error?:string}[]; alerts?:{id:string;type:string;provider:string;requestId?:string;createdAt:number;active:boolean}[] };
export type NativeState = { configured:boolean; platform:string; state:WireState|null; online:boolean; connected:boolean; busy:boolean; message:string; pushStatus:string; liveUpdatesEnabled?:boolean; liveUpdatesStatus?:string; attentionOpenSequence?:number; accountKey?:string; reply?:{id:string;ok:boolean;error?:string} };
export type Command = {id:string;requestId:string;kind:string;answer?:string;answers?:Record<string,{answers:string[]}>};
declare global { interface Window {
 nativeBridge?:{postMessage(message:string):void}; webkit?:{messageHandlers?:{aiWatch?:{postMessage(message:unknown):void}}};
 aiWatchMobile?:{receive(value:NativeState):void};
} }
let native:NativeState={configured:false,platform:'mobile',state:null,online:false,connected:false,busy:false,message:'',pushStatus:''};
const subscribers=new Set<()=>void>(), states=new Set<(value:PanelState)=>void>(), statuses=new Set<(value:LocalStatus)=>void>(), journals=new Set<(value:Journal)=>void>();
const pending=new Map<string,{resolve:()=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;type:string;accountKey?:string}>();
const read=<T,>(key:string,fallback:T):T=>{try{return JSON.parse(localStorage.getItem('mobile:'+key)||'null')??fallback;}catch{return fallback;}};
let preferences:PanelState={side:'right',locked:false,animate:true,collapsed:false,desktop:true,platform:'mobile',scaleFactor:devicePixelRatio,trayAvailable:false,stored:false,
 widgetsEnabled:false,widgetsAvailable:false,widgetSyncError:false,widgetBackground:false,widgetLastPublishedAt:null,
 providerOrder:providerIds,enabledProviders:providerIds,qwenKeychainAllowed:false,kimiSource:'code',claudeSource:'desktop',claudeNetworkAllowed:false,claudeHooksEnabled:false,
 syncRole:'client',syncPort:47321,animeMode:false,insights:{timeline:true,resets:true,trend:true,mascot:true},insightOrder:['timeline','resets','trend','mascot'],mascotInterval:30,
 skin:'watch',layout:'single',windowLayout:'single',language:navigator.language.startsWith('zh')?'zh-CN':'en',theme:'system',resolvedTheme:'light',...read<Partial<PanelState>>('preferences',{})};
preferences={...preferences,desktop:true,platform:'mobile',layout:'single',windowLayout:'single',syncRole:'client',trayAvailable:false};
let journal=emptyJournal();
let customModules=read('custom-modules',false);
export const getNative=()=>native;
export function subscribe(callback:()=>void){subscribers.add(callback);return()=>{subscribers.delete(callback);};}
export const uuid=()=>crypto.randomUUID?.() || '10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c=>(Number(c)^crypto.getRandomValues(new Uint8Array(1))[0]&15>>Number(c)/4).toString(16));
export function post(type:string,fields:Record<string,unknown>={}) {
 const id=uuid();
 return new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Network result unconfirmed'));},25000); pending.set(id,{resolve,reject,timer,type,accountKey:native.accountKey});
  const message={id,type,...fields};
  if(window.nativeBridge)window.nativeBridge.postMessage(JSON.stringify(message));
  else if(window.webkit?.messageHandlers?.aiWatch)window.webkit.messageHandlers.aiWatch.postMessage(message);
  else{clearTimeout(timer);pending.delete(id);reject(new Error('Native bridge unavailable'));}
 });
}
export function label(zh:string,en:string){return createI18n(preferences.language).language.startsWith('zh')?zh:en;}
function panelState():PanelState {
 return {...preferences,enabledProviders:customModules?preferences.enabledProviders:(native.state?.snapshot?.p.map(p=>p.i)||[]),platform:native.platform,resolvedTheme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light',lanSync:{role:'client',state:native.online?'connected':'disconnected',paired:native.configured,name:'Cloud'}};
}
export function project():LocalStatus {
 const wire=native.state; const stamp=wire?.receivedAt?new Date(wire.receivedAt).toISOString():null;
 const source=wire?.snapshot; const t=createI18n(preferences.language).t;
 const result=Object.fromEntries(providers.map(provider=>{
  const p=source?.p.find(item=>item.i===provider.id); const activity=native.online?p?.a||'unknown':'offline';
  const task=p?.w?t(p.w==='input'?'待回答':p.w==='approval'?'待授权':'待处理'):t(activity==='running'?'运行中':activity==='idle'?'待机':activity==='offline'?'离线':'未知');
  return [provider.id,{id:provider.id,source:p?'cache':'unavailable',connection:native.online?p?.c||'unavailable':'offline',activity,activeTasks:native.online?p?.n||0:0,
   waitingTasks:p?.w&&native.online?1:0,waitingReason:native.online?p?.w:undefined,task,
   quotas:(p?.q||[]).map(q=>({model:q.m,period:q.p,remaining:q.r,reset:q.z||'',stale:q.s||!native.online||source?.stale})),observedAt:stamp,sampledAt:stamp,
   detail:label('云端同步状态','Cloud synchronized status'),claudeSource:provider.id==='claude'?'desktop':undefined,kimiSource:provider.id==='kimi'?'code':undefined}];
 }));
 return {...result,sampledAt:stamp,isTestData:source?.sample===true,remote:{host:native.accountKey || 'unpaired',sentAt:stamp}} as LocalStatus;
}
function notify(){const state=panelState(),status=project();states.forEach(fn=>fn(state));statuses.forEach(fn=>fn(status));subscribers.forEach(fn=>fn());}
async function save(value:Partial<PanelState>){preferences={...preferences,...value,layout:'single',windowLayout:'single'};localStorage.setItem('mobile:preferences',JSON.stringify(preferences));notify();return panelState();}
export function installBridge(){
 window.aiWatchMobile={receive(value){
  if(!value||typeof value.configured!=='boolean')return;
  const changedAccount=value.accountKey!==native.accountKey;
  if(changedAccount)for(const [id,item] of pending){if(!['ready','configure','logout'].includes(item.type)&&item.accountKey!==value.accountKey){clearTimeout(item.timer);pending.delete(id);item.reject(new Error('Connection changed'));}}
  native={...value}; if(changedAccount){journal=emptyJournal();journals.forEach(fn=>fn(journal));}
  const status=project();if(status.sampledAt&&!status.isTestData){journal=record(journal,status);journals.forEach(fn=>fn(journal));}
  if(value.reply){const item=pending.get(value.reply.id);if(item){clearTimeout(item.timer);pending.delete(value.reply.id);value.reply.ok?item.resolve():item.reject(new Error(value.reply.error||value.message||'Operation failed'));}}
  notify();
 }};
 const unsupported=async()=>{throw new Error(label('此功能请在电脑处理','Use the desktop for this feature'));};
 const methods={getState:async()=>panelState(),getStatus:async()=>project(),refreshStatus:async()=>{await post('refresh');return project();},
  onState:(fn:(value:PanelState)=>void)=>{states.add(fn);return()=>states.delete(fn);},onStatus:(fn:(value:LocalStatus)=>void)=>{statuses.add(fn);return()=>statuses.delete(fn);},
  getRemoteJournal:async()=>journal,onRemoteJournal:(fn:(value:Journal)=>void)=>{journals.add(fn);return()=>journals.delete(fn);},
  setCollapsed:(collapsed:boolean)=>save({collapsed}),configure:(value:Partial<PanelState>)=>save({animate:value.animate,side:value.side}),
  setOrder:(providerOrder:ProviderId[])=>save({providerOrder}),setEnabled:(enabledProviders:ProviderId[])=>{customModules=true;localStorage.setItem('mobile:custom-modules','true');return save({enabledProviders});},
  setSkin:(skin:PanelState['skin'])=>save({skin}),setTheme:(theme:PanelState['theme'])=>save({theme}),setLanguage:(language:PanelState['language'])=>save({language}),
  setAnimeMode:(animeMode:boolean)=>save({animeMode}),setInsights:(insights:PanelState['insights'])=>save({insights}),setInsightOrder:(insightOrder:PanelState['insightOrder'])=>save({insightOrder}),setMascotInterval:(mascotInterval:number)=>save({mascotInterval}),
  setLayout:async()=>panelState(),chooseImage:async()=>null,
 };
 window.panel=new Proxy(methods,{get(target,key){return key in target?target[key as keyof typeof target]:unsupported;}}) as unknown as NonNullable<Window['panel']>;
 matchMedia('(prefers-color-scheme: dark)').addEventListener('change',notify);
 void post('ready').catch(()=>{});
}
