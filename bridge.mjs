import http from 'node:http';
import {responsesUsage} from './token-usage.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {infer, requireSubscription, prepareRequest} from './runner.mjs';
import {pickerModels, providerModels} from './models.mjs';
import {createCatalog} from './catalog.mjs';
import {createUsage} from './usage.mjs';
import {isFusionModel, handleFusion, forwardForeign, fusionPickerModel, fusionProviderModel, localBridges, prefixes as fusionPrefixes} from './fusion.mjs';

export function createHandler({config, cwd:dir, getCatalog, getUsage,
  inferRequest=infer, readAccount=requireSubscription, report=()=>{}}) {
const json = (res,status,body) => { res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body)); };
const id = prefix => prefix+'_'+crypto.randomUUID().replaceAll('-','');
// The Claude models plus Fusion, whose Scout and Builder lists also offer the
// ChatGPT models when cursor-gpt-link's bridge answers.
let lastGptModels = [];
const withFusion = async own => {
  // The last list that arrived stands in while the other bridge is busy.
  let others = lastGptModels;
  const gpt = localBridges()[fusionPrefixes.chatgpt];
  if (gpt) {
    try {
      const response = await fetch(gpt.base + '/picker-models?own=1', {headers:{authorization:'Bearer ' + gpt.key}, signal:AbortSignal.timeout(1500)});
      if (response.ok) others = lastGptModels = (await response.json()).models ?? [];
    } catch {}
  }
  const fusion = fusionPickerModel(fusionPrefixes.claude, [...own, ...others]);
  return fusion ? [...own, fusion] : own;
};
let active = 0;

return async function handle(req,res) {
  try {
    const origin = req.headers.origin;
    if (origin && !['null','vscode-file://vscode-app'].includes(origin)) return json(res,403,{error:{message:'Origin not allowed'}});
    if (origin) {res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
    if (req.method==='OPTIONS') {res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.writeHead(204);return res.end();}
    if (req.headers.authorization!=='Bearer '+config.key) return json(res,401,{error:{message:'Bridge authentication required'}});
    const url=new URL(req.url,'http://127.0.0.1'),pathname=url.pathname;
    if (pathname==='/health') return json(res,200,{ok:true,provider:'claude-subscription',active});
    if (pathname==='/picker-models') {
      const own=pickerModels(await getCatalog());
      if (url.searchParams.get('own')==='1') return json(res,200,{models:own});
      return json(res,200,{models:await withFusion(own)});
    }
    if (pathname==='/v1/models') return json(res,200,{object:'list',data:[...providerModels(await getCatalog()),fusionProviderModel(fusionPrefixes.claude)]});
    if (pathname==='/account') return json(res,200,await readAccount(config.claude,{cwd:dir}));
    if (req.method==='GET'&&(pathname==='/usage'||pathname==='/v1/usage')) {
      try { return json(res,200,await getUsage()); }
      catch (error) { return json(res,502,{error:{message:error.message||'Usage data unavailable.'}}); }
    }
    if (req.method!=='POST'||pathname!=='/v1/responses') return json(res,404,{error:{message:'Unsupported route: '+req.method+' '+pathname}});
    req.setEncoding('utf8');let text='';for await (const chunk of req) {text+=chunk;if(Buffer.byteLength(text)>64*1024*1024)throw new Error('Request exceeds the 64 MiB bridge limit. Send fewer or smaller attachments.');}
    const body=JSON.parse(text);
    // Fusion steps go to the scout or the builder, on this bridge or another;
    // those requests come back here and count against the limit themselves.
    if (isFusionModel(body?.model)) return await handleFusion(body,res);
    if (await forwardForeign(body,res,fusionPrefixes.claude)) return;
    if (active>=2) return json(res,503,{error:{message:'Two Claude requests are already running. Please wait.'}});
    const catalog=await getCatalog();prepareRequest(body,catalog);
    const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort();});
    const response={id:id('resp'),object:'response',created_at:Math.floor(Date.now()/1000),model:body.model,status:'in_progress',output:[]};
    let sequence=0;
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});
    const event=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,sequence_number:sequence++,...data})+'\n\n');
    event('response.created',{response});
    const timer=setInterval(()=>{if(!res.destroyed)res.write(': waiting for Claude Code\n\n');},10000);
    active++;
    const started=Date.now();
    const record=(status,usage)=>{try{report({id:response.id,model:body.model,status,durationMs:Date.now()-started,at:new Date().toISOString(),...(usage?{usage}: {})});}catch{}};
    record('started');
    // Thinking and the reply stream while Claude writes them; the items open on
    // their first delta and close once the answer is complete.
    const output=[];
    let reasoning,message,streamed='';
    const openReasoning=()=>{
      reasoning={item:{id:id('rs'),type:'reasoning',summary:[]},index:output.length,text:''};output.push(reasoning.item);
      event('response.output_item.added',{output_index:reasoning.index,item:{...reasoning.item}});
      event('response.reasoning_summary_part.added',{item_id:reasoning.item.id,output_index:reasoning.index,summary_index:0,part:{type:'summary_text',text:''}});
    };
    const closeReasoning=()=>{
      if(!reasoning||reasoning.closed)return;reasoning.closed=true;
      const part={type:'summary_text',text:reasoning.text};
      event('response.reasoning_summary_text.done',{item_id:reasoning.item.id,output_index:reasoning.index,summary_index:0,text:reasoning.text});
      event('response.reasoning_summary_part.done',{item_id:reasoning.item.id,output_index:reasoning.index,summary_index:0,part});
      reasoning.item.summary=[part];
      event('response.output_item.done',{output_index:reasoning.index,item:reasoning.item});
    };
    const openMessage=()=>{
      closeReasoning();
      message={item:{id:id('msg'),type:'message',role:'assistant',status:'in_progress',content:[]},index:output.length};output.push(message.item);
      event('response.output_item.added',{output_index:message.index,item:{...message.item}});
      event('response.content_part.added',{item_id:message.item.id,output_index:message.index,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
    };
    const textDelta=delta=>{if(!message)openMessage();streamed+=delta;event('response.output_text.delta',{item_id:message.item.id,output_index:message.index,content_index:0,delta});};
    const onProgress=({kind,delta})=>{
      if(res.destroyed||!delta)return;
      if(kind==='reasoning'){
        if(message)return;
        if(!reasoning)openReasoning();
        reasoning.text+=delta;
        event('response.reasoning_summary_text.delta',{item_id:reasoning.item.id,output_index:reasoning.index,summary_index:0,delta});
      } else if(kind==='text') textDelta(delta);
    };
    try {
      const {answer,usage,usageDiagnostics}=await inferRequest(config.claude,body,{signal:abort.signal,cwd:dir,catalog,onProgress});
      closeReasoning();
      if(answer.text||message){
        // What already streamed is the start of the answer; send the rest. A
        // retried answer that differs keeps the final text in the done events.
        if(answer.text.startsWith(streamed)&&answer.text.length>streamed.length)textDelta(answer.text.slice(streamed.length));
        else if(!message)openMessage();
        event('response.output_text.done',{item_id:message.item.id,output_index:message.index,content_index:0,text:answer.text});
        const part={type:'output_text',text:answer.text,annotations:[]};
        event('response.content_part.done',{item_id:message.item.id,output_index:message.index,content_index:0,part});
        message.item.content=[part];message.item.status='completed';
        event('response.output_item.done',{output_index:message.index,item:message.item});
      }
      for(const call of answer.tool_calls){
        const index=output.length,item={id:id('fc'),type:'function_call',call_id:id('call'),name:call.name,arguments:'',status:'in_progress'};
        event('response.output_item.added',{output_index:index,item:{...item}});
        event('response.function_call_arguments.delta',{item_id:item.id,output_index:index,delta:call.arguments});
        item.arguments=call.arguments;item.status='completed';output.push(item);
        event('response.function_call_arguments.done',{item_id:item.id,output_index:index,arguments:call.arguments});
        event('response.output_item.done',{output_index:index,item});
      }
      event('response.completed',{response:{...response,status:'completed',output,usage:responsesUsage(usage)}});
      res.end();
      record('completed',usageDiagnostics);
    } catch(error) {
      record(abort.signal.aborted?'cancelled':'failed');
      if(!res.destroyed){
        // Cursor's Responses adapter ignores response.failed. An error event
        // preserves the CLI error instead of triggering incomplete-stream retries.
        event('error',{code:'claude_request_failed',message:error.message||'Claude Code rejected the request.',param:null});
        res.end();
      }
    } finally {active--;clearInterval(timer);}
  }catch(error){if(res.headersSent)res.destroy();else json(res,400,{error:{message:error.message}});}
};
}

export function startBridge() {
const dir=path.dirname(fileURLToPath(import.meta.url));
const config=JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8'));
const records=[];
const report=record=>{
  records.push(record);
  if(records.length>40)records.shift();
  const state=path.join(dir,'.state');
  fs.mkdirSync(state,{recursive:true});
  // Only request IDs, model IDs, timestamps and outcomes. No prompts or credentials.
  fs.writeFileSync(path.join(state,'bridge-status.json'),JSON.stringify(records,null,2)+'\n');
};
const handle=createHandler({config,cwd:dir,getCatalog:createCatalog(config.claude,{cwd:dir}),
  getUsage:createUsage(config.claude,{cwd:dir}),report});
const server=http.createServer(handle);
server.on('error',error=>{console.error('Claude bridge could not listen: '+error.code);process.exit(1);});
server.listen(config.port,'127.0.0.1',()=>console.log('Claude subscription bridge ready.'));

return server;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))startBridge();
