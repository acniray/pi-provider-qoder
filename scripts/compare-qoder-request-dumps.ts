/**
 * Compare two decoded Qoder request dumps while ignoring volatile identity fields.
 * Usage: tsx scripts/compare-qoder-request-dumps.ts <a.json> <b.json>
 */
import { readFileSync } from "node:fs";

type J = any;

const [aPath,bPath]=process.argv.slice(2);
if(!aPath||!bPath){
  console.error("Usage: tsx scripts/compare-qoder-request-dumps.ts <a.json> <b.json>");
  process.exit(2);
}

function load(path:string):J{
  const x=JSON.parse(readFileSync(path,"utf8"));
  return x?.requestBody ?? x;
}

function normalize(x:J):J{
  const y=structuredClone(x);
  for(const k of ["request_id","request_set_id","chat_record_id","session_id"]) {
    if(k in y) y[k]="<volatile>";
  }
  if(y.business){
    if("id" in y.business) y.business.id="<volatile>";
    if("begin_at" in y.business) y.business.begin_at="<volatile>";
  }
  return y;
}

function short(v:J){
  if (v === undefined) return "<undefined>";
  const encoded = JSON.stringify(v);
  const s = encoded === undefined ? String(v) : encoded;
  return s.length > 600 ? s.slice(0, 600) + "..." : s;
}

const diffs:string[]=[];
function walk(a:J,b:J,path="$"){
  if(Object.is(a,b)) return;
  const ta=Array.isArray(a)?"array":a===null?"null":typeof a;
  const tb=Array.isArray(b)?"array":b===null?"null":typeof b;
  if(ta!==tb){
    diffs.push(`${path}: type ${ta} != ${tb} | A=${short(a)} | B=${short(b)}`);
    return;
  }
  if(ta==="array"){
    if(a.length!==b.length) diffs.push(`${path}.length: ${a.length} != ${b.length}`);
    const n=Math.max(a.length,b.length);
    for(let i=0;i<n;i++) walk(a[i],b[i],`${path}[${i}]`);
    return;
  }
  if(ta==="object"){
    const keys=[...new Set([...Object.keys(a),...Object.keys(b)])].sort();
    for(const k of keys){
      if(!(k in a)){diffs.push(`${path}.${k}: missing in A | B=${short(b[k])}`);continue;}
      if(!(k in b)){diffs.push(`${path}.${k}: A=${short(a[k])} | missing in B`);continue;}
      walk(a[k],b[k],`${path}.${k}`);
    }
    return;
  }
  diffs.push(`${path}: A=${short(a)} | B=${short(b)}`);
}

const A=normalize(load(aPath));
const B=normalize(load(bPath));
walk(A,B);

function summary(x:J){
  return {
    messageCount: Array.isArray(x.messages) ? x.messages.length : 0,
    messageRoles: Array.isArray(x.messages) ? x.messages.map((m:J)=>m?.role) : [],
    toolCount: Array.isArray(x.tools) ? x.tools.length : 0,
    toolNames: Array.isArray(x.tools) ? x.tools.map((t:J)=>t?.function?.name ?? t?.name ?? "<unnamed>") : [],
    systemType: Array.isArray(x.system) ? "array" : typeof x.system,
    systemLength:
      typeof x.system === "string"
        ? x.system.length
        : Array.isArray(x.system)
          ? JSON.stringify(x.system).length
          : 0,
    maxTokens: x.parameters?.max_tokens,
    enableThinking: x.parameters?.enable_thinking,
    reasoningEffort: x.parameters?.reasoning_effort,
  };
}

console.log(`A: ${aPath}`);
console.log(JSON.stringify(summary(A), null, 2));
console.log(`B: ${bPath}`);
console.log(JSON.stringify(summary(B), null, 2));
console.log(`Differences: ${diffs.length}`);
for(const d of diffs) console.log(d);
