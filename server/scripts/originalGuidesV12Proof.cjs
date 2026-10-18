'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..'),at=r=>path.join(root,r),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const m=JSON.parse(fs.readFileSync(at('server/scripts/original-guides-redo-v12-manifest.json')));
const r=JSON.parse(fs.readFileSync(at('outputs/original-guides-redo-20261001-v12-build/receipt.json')));
const baseline=JSON.parse(fs.readFileSync(at('outputs/original-guides-redo-20260930/preview-baseline.json')));
const fresh=Object.fromEntries(Object.keys(m.sourceRawByteSha256).map(p=>{
 if((p!=='client/liff/package.json'&&!/^client\/liff\/src\/[A-Za-z0-9_./-]+\.(jsx|js|mjs)$/.test(p))||p.includes('..'))throw Error('PATH_INVALID');
 return[p,sha(fs.readFileSync(at(p)))];
}));
const sourceMatches=Object.entries(fresh).every(([p,h])=>m.sourceRawByteSha256[p]===h);
const index=fs.readFileSync(at('server/public/liff/index.html'));
const adminUnchanged=sha(fs.readFileSync(at('server/public/admin/index.html')))===baseline.rows.find(x=>x.surface==='admin').sha256;
const p={status:r.status==='PASS'&&sourceMatches&&sha(index)===r.indexes.liff.sha256&&adminUnchanged?'FILESYSTEM_PROOF_PASS':'FAIL',capturedAt:new Date().toISOString(),sourceCount:Object.keys(fresh).length,sourceMatches,indexSha:sha(index),scriptReferences:[...index.toString().matchAll(/src="([^"]+)"/g)].map(x=>x[1]),adminUnchanged,coachTargetSha:fresh['client/liff/src/components/CoachCard.jsx'],build:{status:r.status,runId:r.runId,cssBytes:r.indexes.liff.cssBytes,oldAssetsPreserved:r.oldAssetsPreserved,databaseAccess:r.databaseAccess,rowsChanged:r.rowsChanged,appStarted:r.appStarted,noticesDispatched:r.noticesDispatched},workflowChanged:false,browserAcceptance:'SEPARATE_RUNTIME_RECEIPT'};
fs.writeFileSync(at('outputs/original-guides-redo-20260930/proof-summary-v12.json'),JSON.stringify(p,null,2),{flag:'wx'});
console.log(JSON.stringify(p));
if(p.status!=='FILESYSTEM_PROOF_PASS')process.exitCode=1;
