/**
 * Qoder CN GLM-5.3 tool-shape A/B probe.
 * Isolates whether the tool name, description, or schema causes XML-style calls.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import { getCachedModelConfig } from "../src/catalog.js";
import { buildAuthHeaders } from "../src/cosy.js";
import { qoderEncodeBody } from "../src/protocol/encoding.js";
import { getQoderChatURL } from "../src/region.js";

const AUTH_FILE=join(homedir(),".pi","agent","auth.json");
const MODEL_ID=process.argv[2]||"GLM-5.3";
const PI_BASH_DESCRIPTION=
  "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.";

type J=Record<string,any>;

function creds(){
  const a=JSON.parse(readFileSync(AUTH_FILE,"utf8"));
  const c=a?.["qoder-cn"];
  if(!c?.access) throw new Error("No qoder-cn credentials");
  return c;
}

const commandOnly={
  type:"object",
  properties:{command:{type:"string",description:"Shell command to execute"}},
  required:["command"],
};

const commandTimeout={
  type:"object",
  properties:{
    command:{type:"string",description:"Shell command to execute"},
    timeout:{type:"number",description:"Timeout in seconds (optional, no default timeout)"},
  },
  required:["command"],
};

function tool(name:string,description:string,parameters:J){
  return {type:"function",function:{name,description,parameters}};
}

const variants=[
  {
    label:"control-get_probe_value",
    tool:tool("get_probe_value","Returns a probe value for a supplied key.",{
      type:"object",
      properties:{key:{type:"string"}},
      required:["key"],
      additionalProperties:false,
    }),
    user:"Call get_probe_value exactly once with key set to ping. Do not answer in plain text.",
  },
  {
    label:"bash-name-simple-desc-command-only",
    tool:tool("bash","Execute a shell command.",commandOnly),
    user:'Call bash exactly once with command set to printf "qoder-probe\\n". Do not answer in plain text.',
  },
  {
    label:"probe-name-pi-bash-desc-command-only",
    tool:tool("get_probe_value",PI_BASH_DESCRIPTION,commandOnly),
    user:'Call get_probe_value exactly once with command set to printf "qoder-probe\\n". Do not answer in plain text.',
  },
  {
    label:"bash-name-pi-desc-command-only",
    tool:tool("bash",PI_BASH_DESCRIPTION,commandOnly),
    user:'Call bash exactly once with command set to printf "qoder-probe\\n". Do not answer in plain text.',
  },
  {
    label:"bash-name-simple-desc-command-timeout",
    tool:tool("bash","Execute a shell command.",commandTimeout),
    user:'Call bash exactly once with command set to printf "qoder-probe\\n". Do not answer in plain text.',
  },
  {
    label:"bash-exact-pi-shape",
    tool:tool("bash",PI_BASH_DESCRIPTION,commandTimeout),
    user:'Call bash exactly once with command set to printf "qoder-probe\\n". Do not answer in plain text.',
  },
  {
    label:"bash-exact-pi-shape-chinese-prompt",
    tool:tool("bash",PI_BASH_DESCRIPTION,commandTimeout),
    user:'必须调用 bash 工具执行 printf "qoder-probe\\n"，不要直接回答。',
  },
];

function body(raw:J,v:(typeof variants)[number]){
  const id=crypto.randomUUID();
  return {
    request_id:id,
    request_set_id:id,
    chat_record_id:id,
    session_id:`pi-qoder-tool-shape-${crypto.randomUUID()}`,
    stream:true,
    chat_task:"FREE_INPUT",
    is_reply:true,
    is_retry:false,
    source:1,
    version:"3",
    session_type:"qodercli",
    agent_id:"agent_common",
    task_id:"common",
    code_language:"",
    chat_prompt:"",
    image_urls:null,
    aliyun_user_type:"",
    system:"",
    messages:[
      {role:"system",content:"You are a coding assistant. Use the provided tools when requested."},
      {role:"user",content:v.user},
    ],
    tools:[v.tool],
    parameters:{max_tokens:131072,enable_thinking:true,reasoning_effort:"high"},
    chat_context:{
      chatPrompt:"",
      imageUrls:null,
      extra:{context:[],modelConfig:{key:raw.key,is_reasoning:true},originalContent:v.user},
      features:[],
      text:v.user,
    },
    model_config:raw,
    business:{
      product:"cli",version:"1.0.0",type:"agent",stage:"start",
      id:crypto.randomUUID(),name:v.user.slice(0,30),begin_at:Date.now(),
    },
  };
}

function xmlCount(s:string){
  return (s.match(/<\/?tool_call\b/gi)||[]).length+
    (s.match(/<\/?function_call\b/gi)||[]).length;
}

async function send(label:string,b:J,raw:J,c:J){
  const url=getQoderChatURL("cn");
  const enc=qoderEncodeBody(Buffer.from(JSON.stringify(b)));
  const h=buildAuthHeaders(enc,url,{
    userID:c.userID,authToken:c.access,name:c.name,email:c.email,machineID:c.machineID,
  });
  const t0=performance.now();
  const res=await fetch(url,{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      Accept:"text/event-stream",
      "Cache-Control":"no-cache",
      "Accept-Encoding":"identity",
      "X-Model-Key":raw.key,
      "X-Model-Source":raw.source||"system",
      ...h,
    },
    body:enc,
  });
  let structured=0,xml=0,finish="",preview="",buffer="";
  if(!res.body) return {label,http:res.status,structured,xml,finish,preview,total:Math.round(performance.now()-t0)};
  const rd=res.body.getReader(),dec=new TextDecoder();
  let done=false;
  while(!done){
    const p=await rd.read(); if(p.done) break;
    buffer+=dec.decode(p.value,{stream:true});
    const lines=buffer.split(/\r?\n/); buffer=lines.pop()||"";
    for(const rl of lines){
      const line=rl.trim(); if(!line.startsWith("data:")) continue;
      const d=line.slice(5).trim(); if(!d) continue;
      if(d==="[DONE]"){done=true;break;}
      let env:any; try{env=JSON.parse(d)}catch{continue}
      if(env?.body==="[DONE]"){done=true;break;}
      if(typeof env?.body!=="string") continue;
      let inner:any; try{inner=JSON.parse(env.body)}catch{
        xml+=xmlCount(env.body); if(!preview) preview=env.body.slice(0,160); continue;
      }
      const ch=inner?.choices?.[0]; if(ch?.finish_reason) finish=ch.finish_reason;
      const delta=ch?.delta??ch?.message; if(!delta) continue;
      if(Array.isArray(delta.tool_calls)){
        structured+=delta.tool_calls.filter((x:any)=>x&&(x.id||x.function?.name||x.function?.arguments)).length;
      }
      if(delta.function_call) structured++;
      if(typeof delta.content==="string"){
        xml+=xmlCount(delta.content);
        if(!preview&&delta.content.trim()) preview=delta.content.replace(/\s+/g," ").slice(0,160);
      }
    }
  }
  return {label,http:res.status,structured,xml,finish,preview,total:Math.round(performance.now()-t0)};
}

async function main(){
  const raw=getCachedModelConfig(MODEL_ID,"cn") as J|null;
  if(!raw?.key) throw new Error(`No cached config for ${MODEL_ID}`);
  const c=creds();
  console.log("Qoder CN GLM tool-shape probe");
  console.log("=============================");
  console.log(`Model: ${MODEL_ID} (${raw.key})\n`);
  const results=[];
  for(const v of variants){
    process.stdout.write(`[${v.label}] ... `);
    const r=await send(v.label,body(raw,v),raw,c);
    results.push(r);
    console.log(`HTTP ${r.http} structured=${r.structured} xml=${r.xml} finish=${r.finish||"-"} total=${r.total}ms`);
    if(r.preview) console.log(`  text: ${r.preview}`);
  }
  console.log("\nSummary");
  console.log("variant | structured | xml | finish");
  for(const r of results) console.log(`${r.label} | ${r.structured} | ${r.xml} | ${r.finish}`);
}
main().catch(e=>{console.error(e instanceof Error?e.message:String(e));process.exitCode=1});
