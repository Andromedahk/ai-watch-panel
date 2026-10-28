import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
const root=process.cwd(),out=path.join(root,'.local/qa/cloud-sync/shared-ui');await fs.mkdir(out,{recursive:true});
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');const mobile=url.pathname.startsWith('/mobile/');const base=path.join(root,mobile?'dist-mobile':'dist');const relative=decodeURIComponent(url.pathname.replace(/^\/(mobile|desktop)\//,''))||'index.html';const file=path.resolve(base,relative);if(!file.startsWith(base+path.sep))throw Error();const body=await fs.readFile(file);res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'})[path.extname(file)]||'application/octet-stream');res.end(body);}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,channel:process.env.AI_WATCH_BROWSER_CHANNEL || 'chrome'});let checks=0;const errors=[];
try{
 const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1});
 const mobile=await context.newPage();mobile.on('pageerror',e=>errors.push(e.message));
 const now=Date.now();const ids=['claude','codex','antigravity','deepseek','zcode','kimi','qwen','workbuddy'];
 const wire={configured:true,platform:'android',online:true,connected:true,busy:false,message:'',pushStatus:'SYNTHETIC QA',accountKey:'synthetic-qa',state:{online:true,receivedAt:now,snapshot:{sample:true,requests:[],p:ids.map((i,index)=>({i,c:'ready',a:index===0?'waiting':index===1||index===2?'running':'idle',n:index===1?2:0,...(index===0?{w:'input'}:{}),q:[{m:'SYNTHETIC QA',p:'5h',r:80-index*8}]}))},commands:[],alerts:[]}};
 await mobile.addInitScript(value=>{window.__nativeMessages=[];window.nativeBridge={postMessage(raw){const message=JSON.parse(raw);window.__nativeMessages.push(message);if(message.type==='liveUpdates')value.liveUpdatesEnabled=message.enabled;queueMicrotask(()=>window.aiWatchMobile.receive({...value,reply:{id:message.id,ok:true}}));}};},wire);
 await mobile.goto(origin+'/mobile/index.html');await mobile.waitForSelector('.provider-card');await mobile.waitForFunction(()=>!document.querySelector('.mobile-dialog')?.open);
 const state=await mobile.evaluate(()=>window.panel.getState()),status=await mobile.evaluate(()=>window.panel.getStatus());
 const desktop=await context.newPage();desktop.on('pageerror',e=>errors.push(e.message));
 await desktop.addInitScript(({state,status})=>{let current=state;const listeners=[];const save=async update=>{current={...current,...update};listeners.forEach(fn=>fn(current));return current;};window.panel={getState:async()=>current,getStatus:async()=>status,onState:fn=>{listeners.push(fn);return()=>{};},onStatus:()=>()=>{},getRemoteJournal:async()=>null,onRemoteJournal:()=>()=>{},setSkin:skin=>save({skin}),setTheme:theme=>save({theme}),setAnimeMode:animeMode=>save({animeMode}),setCollapsed:collapsed=>save({collapsed})};},{state,status});
 await desktop.goto(origin+'/desktop/index.html');await desktop.waitForSelector('.provider-card');
 const styles=async page=>page.evaluate(()=>[...document.querySelectorAll('.provider-card')].map(card=>{
 const s=getComputedStyle(card);const r=card.getBoundingClientRect();return{html:card.outerHTML,rect:[r.width,r.height],style:['borderRadius','backgroundColor','padding','fontFamily','fontSize','boxShadow'].map(key=>s[key]),animations:[...card.querySelectorAll('*'),card].flatMap(el=>['','::before','::after'].map(p=>{const v=getComputedStyle(el,p);return[v.animationName,v.animationDuration,v.animationTimingFunction];})).filter(v=>v[0]!=='none')};}));
 const motionStart=await mobile.evaluate(()=>document.getAnimations().filter(a=>a.playState==='running').map(a=>Number(a.currentTime)));await mobile.waitForTimeout(180);const motionEnd=await mobile.evaluate(()=>document.getAnimations().filter(a=>a.playState==='running').map(a=>Number(a.currentTime)));assert.ok(motionEnd.some((time,i)=>time>(motionStart[i]||0)+50));checks++;
 for(const page of [mobile,desktop])await page.addStyleTag({content:'*,*::before,*::after{animation-play-state:paused!important;transition:none!important}'});
 for(const skin of ['watch','dial','party'])for(const theme of ['light','dark'])for(const anime of [false,true]){
  for(const page of [mobile,desktop]){await page.evaluate(async({skin,theme,anime})=>{await window.panel.setSkin(skin);await window.panel.setTheme(theme);await window.panel.setAnimeMode(anime);},{skin,theme,anime});await page.waitForFunction(()=>[...document.images].every(img=>img.complete&&img.naturalWidth>0));}
  await mobile.waitForTimeout(900);
  for(const page of [mobile,desktop]) await page.evaluate(()=>document.getAnimations().forEach(animation=>{animation.pause();animation.currentTime=1000;}));
  const a=await styles(mobile),b=await styles(desktop);
  // Ignore each renderer's current animation phase, but require identical markup,
  // geometry, declarations and durations for every shared provider card.
  for(let i=0;i<a.length;i++){assert.deepEqual(a[i].style,b[i].style);assert.deepEqual(a[i].rect,b[i].rect);assert.deepEqual(a[i].animations,b[i].animations);assert.equal(a[i].html,b[i].html);checks++;}
  const [mobilePixels,desktopPixels]=await Promise.all([mobile.locator('.provider-viewport').screenshot(),desktop.locator('.provider-viewport').screenshot()]);if(!mobilePixels.equals(desktopPixels)){
   const diff=await mobile.evaluate(async([left,right])=>{const decode=async text=>createImageBitmap(new Blob([Uint8Array.from(atob(text),c=>c.charCodeAt(0))],{type:'image/png'}));const a=await decode(left),b=await decode(right);const canvas=document.createElement('canvas');canvas.width=a.width;canvas.height=a.height;const ctx=canvas.getContext('2d');ctx.drawImage(a,0,0);const x=ctx.getImageData(0,0,a.width,a.height).data;ctx.clearRect(0,0,a.width,a.height);ctx.drawImage(b,0,0);const y=ctx.getImageData(0,0,a.width,a.height).data;let maximum=0,pixels=0;for(let i=0;i<x.length;i+=4){let d=0;for(let k=0;k<4;k++)d=Math.max(d,Math.abs(x[i+k]-y[i+k]));maximum=Math.max(maximum,d);if(d)pixels++;}return{maximum,pixels,total:a.width*a.height};},[mobilePixels.toString('base64'),desktopPixels.toString('base64')]);
   // GPU gradient rasterization can differ by one 8-bit channel value at a few
   // edge pixels even for identical paused DOM; permit only that measured noise.
   if(diff.maximum>1||diff.pixels>Math.max(16,diff.total*.0001)){await fs.writeFile(path.join(out,'mismatch-mobile.png'),mobilePixels);await fs.writeFile(path.join(out,'mismatch-desktop.png'),desktopPixels);throw Error(`Shared viewport differs ${skin}/${theme}/${anime}: ${JSON.stringify(diff)}`);}
  }checks++;
  await mobile.screenshot({path:path.join(out,`${skin}-${theme}-${anime?'anime':'logo'}.png`)});
 }
 await mobile.evaluate(()=>window.panel.setCollapsed(true));assert.equal(await mobile.locator('.collapsed-rail').count(),1);checks++;
 await mobile.evaluate(()=>window.panel.setCollapsed(false));
 await mobile.getByRole('button',{name:'连接与消息',exact:true}).click();await mobile.waitForSelector('.mobile-dialog[open]');assert.equal(await mobile.locator('.mobile-dialog [data-mobile-online=true]').count(),1);checks++;
 const liveSwitch=mobile.locator('.mobile-dialog').getByLabel('实时关注待回答 / 待授权',{exact:true});await liveSwitch.check();await mobile.waitForFunction(()=>window.__nativeMessages.some(m=>m.type==='liveUpdates'&&m.enabled===true));assert.equal(await liveSwitch.isChecked(),true);checks++;
 await liveSwitch.uncheck();await mobile.waitForFunction(()=>window.__nativeMessages.some(m=>m.type==='liveUpdates'&&m.enabled===false));assert.equal(await liveSwitch.isChecked(),false);checks++;
 await mobile.getByRole('button',{name:'Close mobile panel'}).click();
 await mobile.evaluate(value=>window.aiWatchMobile.receive({...value,attentionOpenSequence:1}),wire);await mobile.waitForSelector('.mobile-dialog[open]');checks++;
 await mobile.getByRole('button',{name:'Close mobile panel'}).click();await mobile.evaluate(value=>window.aiWatchMobile.receive({...value,attentionOpenSequence:1}),wire);assert.equal(await mobile.locator('.mobile-dialog[open]').count(),0);checks++;
 const questionId='f'.repeat(64),requestId='codex-'+'e'.repeat(64),originalLabel='保留 <script>原文</script>';
 const fullWire={...wire,state:{...wire.state,snapshot:{...wire.state.snapshot,sample:false,requests:[{id:requestId,provider:'codex',kind:'input',title:'codex.input',detail:'input',expiresAt:Date.now()+60000,questions:[{id:questionId,header:'question.1',options:[{label:'option.1'}],isOther:true}],fullContent:{questions:[{id:questionId,header:'选择方向',question:'完整问题\n<img src=x onerror=alert(1)>',options:[{label:originalLabel,description:'原始选项说明'}]}]}}]}}};
 await mobile.evaluate(value=>window.aiWatchMobile.receive(value),fullWire);await mobile.getByRole('button',{name:'连接与消息',exact:true}).click();await mobile.locator(`[data-request="${requestId}"]`).click();
 assert.equal(await mobile.locator('[data-full-content="question"]').textContent(),'完整问题\n<img src=x onerror=alert(1)>');assert.equal(await mobile.locator('.mobile-request img,.mobile-request script').count(),0);checks++;
 await mobile.evaluate(()=>document.getAnimations().forEach(animation=>{animation.pause();animation.currentTime=1000;}));await mobile.screenshot({path:path.join(out,'full-question.png')});
 await mobile.locator('[data-option="option.1"]').click();await mobile.locator('[data-action="answer"]').click();await mobile.locator('[data-action="confirm"]').click();await mobile.waitForFunction(id=>window.__nativeMessages.some(m=>m.type==='submit'&&m.command?.answers?.[id]?.answers?.[0]==='option.1'),questionId);checks++;
 await mobile.getByRole('button',{name:'Close mobile panel'}).click();
 const approvalWire={...fullWire,state:{...fullWire.state,snapshot:{...fullWire.state.snapshot,requests:[{id:requestId+'a',provider:'codex',kind:'approval',title:'codex.commandApproval',detail:'git',expiresAt:Date.now()+60000,fullContent:{command:'git status\n# '+ 'long-path/'.repeat(40),cwd:'/workspace/原始项目',reason:'核实当前改动'}}]}}};
 await mobile.evaluate(value=>window.aiWatchMobile.receive(value),approvalWire);await mobile.getByRole('button',{name:'连接与消息',exact:true}).click();await mobile.locator(`[data-request="${requestId}a"]`).click();assert.match(await mobile.locator('[data-full-content="command"]').textContent(),/^git status\n/);assert.equal(await mobile.locator('[data-full-content="cwd"]').textContent(),'/workspace/原始项目');checks++;
 assert.equal(await mobile.locator('.mobile-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);checks++;
 await mobile.evaluate(()=>document.getAnimations().forEach(animation=>{animation.pause();animation.currentTime=1000;}));await mobile.screenshot({path:path.join(out,'full-command.png')});
 const metadataOnly=structuredClone(approvalWire);delete metadataOnly.state.snapshot.requests[0].fullContent;await mobile.evaluate(value=>window.aiWatchMobile.receive(value),metadataOnly);await mobile.waitForFunction(()=>!document.querySelector('[data-full-content="command"]'));assert.equal(await mobile.locator('.mobile-request').count(),1);checks++;
 await mobile.evaluate(value=>window.aiWatchMobile.receive(value),approvalWire);await mobile.waitForSelector('[data-full-content="command"]');
 const completed=structuredClone(approvalWire);completed.state.commands=[{id:'synthetic-command',requestId:requestId+'a',status:'succeeded'}];await mobile.evaluate(value=>window.aiWatchMobile.receive(value),completed);await mobile.waitForFunction(()=>!document.querySelector('.mobile-request'));assert.equal(await mobile.locator('[data-full-content]').count(),0);checks++;
 const expiring=structuredClone(approvalWire);expiring.state.snapshot.requests[0].expiresAt=Date.now()+1500;await mobile.evaluate(value=>window.aiWatchMobile.receive(value),expiring);await mobile.locator(`[data-request="${requestId}a"]`).click();await mobile.locator('[data-action="approve"]').click();await mobile.waitForFunction(()=>!document.querySelector('.mobile-request'));assert.equal(await mobile.locator('[data-action="confirm"]').count(),0);checks++;
 await mobile.getByRole('button',{name:'Close mobile panel'}).click();
 await mobile.evaluate(value=>window.aiWatchMobile.receive({...value,state:null}),wire);await mobile.waitForFunction(()=>document.querySelector('.panel')?.getAttribute('data-sampled-at')==='');assert.equal(await mobile.locator('.provider-card').count(),0);checks++;
 await mobile.evaluate(value=>window.aiWatchMobile.receive({...value,accountKey:'second-workspace',state:{...value.state,receivedAt:value.state.receivedAt-60000}}),wire);await mobile.waitForFunction(stamp=>document.querySelector('.panel')?.getAttribute('data-sampled-at')===stamp,new Date(now-60000).toISOString());checks++;
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(out,'result.json'),JSON.stringify({passed:true,checks,combinations:12,scope:'Same desktop App tree, markup, geometry, CSS/animation declarations and paused viewport pixels (only <=1/255 channel noise in <=0.01% pixels tolerated). Includes animation progress, account reset, explicit live-update opt-in/out and activity deep-link inbox opening without repeated reopening. Synthetic state; native rendering verified separately.'},null,2));
 console.log(`Shared mobile/desktop UI passed ${checks} checks across 12 skin/theme/portrait combinations.`);
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
