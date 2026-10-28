import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { installBridge, label } from './bridge';
import { Connection, MobileModal, useNative } from './MobilePanel';
import '../view/skins.css';
import '../screen.css';
import '../stream-settings.css';
import './mobile.css';
installBridge();
void import('../App').then(({default:App})=>{
 function MobileApp(){const native=useNative();const [open,setOpen]=useState(true);const [provider,setProvider]=useState<string>();
  useEffect(()=>{setOpen(!native.configured);},[native.configured]);
  useEffect(()=>{if((native.attentionOpenSequence||0)>0){setProvider(undefined);setOpen(true);}},[native.attentionOpenSequence]);
  function show(id?:string){setProvider(id);setOpen(true);}
  return <><App mobile={{onOpen:show,settings:<Connection/>,label:label('连接与消息','Connection and inbox')}}/><MobileModal open={open} onClose={()=>setOpen(false)} provider={provider}/></>;
 }
 createRoot(document.getElementById('root')!).render(<React.StrictMode><MobileApp/></React.StrictMode>);
});
