// Runs only against the disposable preview account, never the normal app.
import { createCanvas } from '@napi-rs/canvas';
import { mkdir,writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const base='http://127.0.0.1:3003';
const auth=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'preview@example.test',password:'preview-local-only-2026'})});if(!auth.ok)throw new Error('Start the disposable preview fixture before running smoke tests.');const {token}=await auth.json();
const keyResponse=await fetch(base+'/api/settings/api-key',{headers:{Authorization:`Bearer ${token}`}});const {apiKey}=await keyResponse.json();
const canvas=createCanvas(1200,260);const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,1200,260);ctx.fillStyle='black';ctx.font='64px Arial';ctx.fillText('FreeOCRapi document test',40,110);ctx.font='48px Arial';ctx.fillText('Invoice total 2026',40,190);
await mkdir('artifacts',{recursive:true});await writeFile('artifacts/smoke-document.png',canvas.toBuffer('image/png'));
function run(command,args){return new Promise((resolve,reject)=>{const child=spawn(command,args,{env:{...process.env,FREEOCRAPI_URL:base,FREEOCRAPI_API_KEY:apiKey},stdio:['ignore','pipe','pipe']});let output='';let error='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>error+=data);child.on('error',reject);child.on('exit',code=>{if(code||!output.includes('2026'))reject(new Error(error||'Expected OCR text missing.'));else{console.log('Verified '+args[0]+': real OCR output includes 2026');resolve();}});});}
await run(process.execPath,['cli/index.mjs','ocr','artifacts/smoke-document.png']);
if(process.env.FREEOCRAPI_TEST_PYTHON)await run(process.env.FREEOCRAPI_TEST_PYTHON,['-c','from integrations.python.freeocrapi import FreeOCRClient; print(FreeOCRClient().extract("artifacts/smoke-document.png")["text"])']);
const jobs=await (await fetch(base+'/v1/jobs',{headers:{Authorization:`Bearer ${apiKey}`}})).json();await writeFile('artifacts/smoke-result.json',JSON.stringify({verifiedAt:new Date().toISOString(),jobs:jobs.map(job=>({id:job.id,status:job.status,engine:job.engine}))},null,2));console.log('Saved resumable smoke results to artifacts/smoke-result.json.');
