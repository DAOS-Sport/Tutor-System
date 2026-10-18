'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib'),cp=require('node:child_process');
const root=path.resolve(__dirname,'../..'),at=r=>path.join(root,r),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
async function main(){
 if(process.argv.length!==4)fail('ARGS_INVALID');
 const bytes=fs.readFileSync(at('outputs/original-guides-redo-20260930/v12-delivery2.json.gz'));
 if(sha(bytes)!==process.argv[2])fail('DELIVERY_HASH_MISMATCH');
 const b=JSON.parse(zlib.gunzipSync(bytes));
 if(b.digest!==process.argv[3]||sha(JSON.stringify(b.target))!==b.digest)fail('TARGET_HASH_MISMATCH');
 const old=JSON.parse(fs.readFileSync(at('server/scripts/original-guides-redo-v11-manifest.json')));
 for(const [r,h]of Object.entries(old.sourceRawByteSha256))if(sha(fs.readFileSync(at(r)))!==h)fail('SOURCE_RAW_CAS_MISMATCH');
 if(sha(fs.readFileSync(at('server/public/liff/index.html')))!==b.manifest.indexRawByteSha256.liff)fail('INDEX_RAW_CAS_MISMATCH');
 if(b.target.files.length!==1||b.target.files[0].path!=='client/liff/src/components/CoachCard.jsx')fail('SCOPE_INVALID');
 const f=b.target.files[0];if(sha(Buffer.from(f.content))!==f.targetRawSha256||old.sourceRawByteSha256[f.path]!==f.beforeRawSha256)fail('FILE_HASH_INVALID');
 const dir=at('outputs/original-guides-redo-20260930/applied-v12');if(fs.existsSync(dir))fail('RUN_EXISTS');
 fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'CoachCard-before.jsx'),fs.readFileSync(at(f.path)),{flag:'wx'});
 fs.writeFileSync(path.join(dir,'review.json'),JSON.stringify({digest:b.digest,scope:[f.path],workflowChanged:false,databaseAccess:false},null,2),{flag:'wx'});
 fs.writeFileSync(at('server/scripts/original-guides-redo-v12-manifest.json'),JSON.stringify(b.manifest,null,2),{flag:'wx'});
 fs.writeFileSync(at('server/scripts/originalGuidesV12Build.cjs'),b.builder,{flag:'wx'});
 const temp=at(f.path+'.v12-tmp');fs.writeFileSync(temp,f.content,{flag:'wx'});fs.renameSync(temp,at(f.path));
 if(sha(fs.readFileSync(at(f.path)))!==f.targetRawSha256)fail('SOURCE_READBACK_MISMATCH');
 const r=cp.spawnSync(process.execPath,[at('server/scripts/originalGuidesV12Build.cjs'),b.digest],{cwd:root,stdio:'inherit'});
 if(r.status!==0)fail('BUILD_FAILED');
 console.log(JSON.stringify({status:'V12_APPLIED',sourceSha:f.targetRawSha256,workflowChanged:false,databaseAccess:false}));
}
if(require.main===module)main().catch(e=>{console.error(e.code||'V12_FAILED');process.exitCode=1;});
