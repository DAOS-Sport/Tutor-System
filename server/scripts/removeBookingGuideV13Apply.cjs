'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const root=path.resolve(__dirname,'../..'),at=p=>path.join(root,p),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const expectedGzip='00fe0cb749e1d5c9652a3923824a1683fb62f22258df19822fcbeaf772a0ab61',expectedTarget='282733a566f7e0dd0d4b6dc243450643a48720fa00f67da624ac5d05b1b47625',artifact='outputs/remove-booking-guide-v13-20261001-applied';
const fail=c=>{throw Object.assign(Error(c),{code:c})};
async function main(){
 if(process.argv.length!==4||process.argv[2]!==expectedGzip||process.argv[3]!==expectedTarget)fail('UNAPPROVED_ARGUMENTS');
 const bytes=fs.readFileSync(at('outputs/remove-booking-guide-v13-delivery.json.gz'));if(sha(bytes)!==expectedGzip)fail('DELIVERY_HASH_MISMATCH');
 const b=JSON.parse(zlib.gunzipSync(bytes));if(sha(JSON.stringify(b.target))!==expectedTarget||b.target.path!=='client/liff/src/pages/GuidePage.jsx')fail('TARGET_INVALID');
 for(const [p,h] of Object.entries(b.manifest.sourceRawByteSha256)){
  if((p!=='client/liff/package.json'&&!/^client\/liff\/src\/[A-Za-z0-9_./-]+\.(jsx|js|mjs)$/.test(p))||p.includes('..'))fail('SOURCE_PATH_INVALID');
  const expected=p===b.target.path?b.target.beforeRawSha256:h;
  if(sha(fs.readFileSync(at(p)))!==expected)fail('SOURCE_BEFORE_CAS_MISMATCH');
 }
 if(sha(fs.readFileSync(at('server/public/liff/index.html')))!==b.before.indexSha||sha(fs.readFileSync(at('server/public/admin/index.html')))!==b.before.adminSha)fail('INDEX_BEFORE_CAS_MISMATCH');
 if(fs.existsSync(at(artifact))||fs.existsSync(at('outputs/'+b.runId)))fail('RUN_ALREADY_EXISTS');
 fs.mkdirSync(at(artifact));fs.writeFileSync(at(artifact+'/GuidePage-before.jsx'),fs.readFileSync(at(b.target.path)),{flag:'wx'});
 fs.writeFileSync(at('server/scripts/removeBookingGuideV13Build.cjs'),b.builder,{flag:'wx'});
 fs.writeFileSync(at('server/scripts/remove-booking-guide-v13-manifest.json'),JSON.stringify(b.manifest,null,2),{flag:'wx'});
 const temp=at(b.target.path+'.remove-booking-v13.tmp');fs.writeFileSync(temp,b.target.content,{flag:'wx'});
 if(sha(fs.readFileSync(at(b.target.path)))!==b.target.beforeRawSha256)fail('SOURCE_CHANGED_BEFORE_APPLY');
 fs.renameSync(temp,at(b.target.path));
 if(sha(fs.readFileSync(at(b.target.path)))!==b.target.targetRawSha256)fail('SOURCE_AFTER_HASH_MISMATCH');
 try{
  // The builder only exports main: invoke the actual entrypoint explicitly.
  process.argv=[process.argv[0],process.argv[1],expectedTarget];
  await require('./removeBookingGuideV13Build.cjs').main();
 }catch(e){
  fs.writeFileSync(at(artifact+'/build-failure.json'),JSON.stringify({status:'FAIL',code:e.code||'BUILD_FAILED'}),{flag:'wx'});
  if(sha(fs.readFileSync(at(b.target.path)))===b.target.targetRawSha256){const rb=at(b.target.path+'.remove-booking-v13.rollback.tmp');fs.writeFileSync(rb,fs.readFileSync(at(artifact+'/GuidePage-before.jsx')),{flag:'wx'});fs.renameSync(rb,at(b.target.path));}
  throw e;
 }
 const r=JSON.parse(fs.readFileSync(at('outputs/'+b.runId+'/receipt.json')));
 const fresh=Object.fromEntries(Object.keys(b.manifest.sourceRawByteSha256).map(p=>[p,sha(fs.readFileSync(at(p)))]));
 const sourceMatches=Object.entries(fresh).every(([p,h])=>h===b.manifest.sourceRawByteSha256[p]);
 const index=fs.readFileSync(at('server/public/liff/index.html'));
 const adminUnchanged=sha(fs.readFileSync(at('server/public/admin/index.html')))===b.before.adminSha;
 const proof={status:sourceMatches&&adminUnchanged&&r.status==='PASS'&&r.indexes.liff.sha256===sha(index)?'FILESYSTEM_PROOF_PASS':'FAIL',capturedAt:new Date().toISOString(),sourceCount:Object.keys(fresh).length,sourceMatches,changedPaths:[b.target.path],guideSha:fresh[b.target.path],indexSha:sha(index),scriptReferences:[...index.toString().matchAll(/src="([^"]+)"/g)].map(x=>x[1]),adminUnchanged,build:{status:r.status,runId:r.runId,cssBytes:r.indexes.liff.cssBytes,oldAssetsPreserved:r.oldAssetsPreserved,databaseAccess:r.databaseAccess,rowsChanged:r.rowsChanged,appStarted:r.appStarted,noticesDispatched:r.noticesDispatched},browserAcceptance:'SEPARATE_RUNTIME_RECEIPT'};
 fs.writeFileSync(at(artifact+'/proof.json'),JSON.stringify(proof,null,2),{flag:'wx'});
 fs.writeFileSync(at(artifact+'/source-readback.json'),JSON.stringify({source:fs.readFileSync(at(b.target.path),'utf8'),freshRawSha256:fresh},null,2),{flag:'wx'});
 console.log(JSON.stringify(proof));if(proof.status!=='FILESYSTEM_PROOF_PASS')fail('AFTER_PROOF_FAILED');
}
main().catch(e=>{console.error(e.code||'REMOVE_BOOKING_GUIDE_FAILED');process.exitCode=1});
