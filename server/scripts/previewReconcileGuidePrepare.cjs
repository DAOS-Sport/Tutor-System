'use strict';
// Official stopped-development Workflow only. No dotenv, app bootstrap or external provider.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../..'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
const requiredPaths=["client/admin/src/pages/ReconcilePage.jsx","client/admin/src/components/FilterBar.jsx","client/admin/src/utils/reconcileDateRange.mjs","client/shared/DateTimePicker.jsx","client/liff/src/pages/GuidePage.jsx","client/liff/src/components/GuideTour.jsx","client/liff/src/utils/guideTour.mjs"];
const publicKeys=['VITE_LIFF_ID_PARENT','VITE_LIFF_ID_COACH','VITE_LIFF_ID','VITE_SUPPORT_LINE_COACH','VITE_SUPPORT_LINE_PARENT','VITE_USE_MOCK'];

async function main(){
 if(process.argv.length!==3||process.argv[2]!=='e7eef8e210c8f91f9c9a8c1c9d6d3ec9db0e3568323ce3bb2ddb2c09dabe1a3d')fail('UNAPPROVED_TARGET_DIGEST');
 const m=JSON.parse(fs.readFileSync(path.join(__dirname,'preview-reconcile-guide-manifest.json'),'utf8'));
 if(m.version!==1||!/^preview-reconcile-guide-[a-z0-9-]+$/.test(m.runId)||JSON.stringify(Object.keys(m.sources).sort())!==JSON.stringify(requiredPaths.slice().sort()))fail('MANIFEST_INVALID');
 for(const p of requiredPaths)if(sha(fs.readFileSync(path.join(root,p)))!==m.sources[p])fail('SOURCE_HASH_MISMATCH');
 console.log(JSON.stringify({event:'public_build_settings',presence:Object.fromEntries(publicKeys.map(key=>[key,Boolean(process.env[key])]))}));
 // Public compile settings only; values never enter receipts. Missing settings refuse LIFF activation.
 if(!(process.env.VITE_LIFF_ID_PARENT||process.env.VITE_LIFF_ID)||!(process.env.VITE_LIFF_ID_COACH||process.env.VITE_LIFF_ID))fail('PUBLIC_LIFF_ID_MISSING');
 if(process.env.VITE_USE_MOCK==='true')fail('MOCK_BUILD_REFUSED');
 const artifacts=path.join(root,'outputs',m.runId);if(fs.existsSync(artifacts))fail('RUN_DIRECTORY_EXISTS');fs.mkdirSync(artifacts);
 const staged=[];
 for(const kind of ['admin','liff']){
  const client=path.join(root,'client',kind),live=path.join(root,'server/public',kind),index=path.join(live,'index.html'),original=fs.readFileSync(index);
  if(sha(original)!==m.indexHashes[kind])fail('INDEX_CAS_MISMATCH');fs.writeFileSync(path.join(artifacts,kind+'-original-index.html'),original,{flag:'wx'});
  const {build}=await import(pathToFileURL(path.join(client,'node_modules/vite/dist/node/index.js')).href),react=(await import(pathToFileURL(path.join(client,'node_modules/@vitejs/plugin-react/dist/index.js')).href)).default;
  const stage=path.join(artifacts,kind+'-build'),cwd=process.cwd();try{process.chdir(client);await build({root:client,configFile:false,envFile:false,plugins:[react()],base:'/'+kind+'/',build:{outDir:stage,emptyOutDir:false}});}finally{process.chdir(cwd);}
  const assetDir=path.join(stage,'assets'),names=fs.readdirSync(assetDir),css=names.filter(n=>n.endsWith('.css')).map(n=>fs.readFileSync(path.join(assetDir,n),'utf8')).join('\n');
  for(const selector of ['.bg-brand-primary','.flex','.rounded','.grid-cols-7',String.raw`.min-h-\[44px\]`])if(!css.includes(selector))fail('TAILWIND_UTILITY_MISSING');
  if(!/rgb\(21\s+49\s+106\s*(?:\/|\))/.test(css))fail('TAILWIND_BRAND_MISSING');
  const next=fs.readFileSync(path.join(stage,'index.html')),refs=[...next.toString().matchAll(/(?:src|href)="([^"]+)"/g)].map(x=>x[1]);if(!refs.length)fail('NO_BUILD_REFERENCES');
  for(const ref of refs){if(ref==='/brand/company-1b122f0a.png'){if(!original.toString().includes(ref)||!fs.existsSync(path.join(root,'server/public/brand/company-1b122f0a.png')))fail('BRAND_ASSET_MISSING');continue;}if(!new RegExp('^/'+kind+'/assets/[A-Za-z0-9_.-]+$').test(ref)||!fs.existsSync(path.join(stage,ref.slice(kind.length+2))))fail('BUILD_ASSET_REFERENCE_INVALID');}
  for(const name of names){if(!/^[A-Za-z0-9_.-]+$/.test(name)||!fs.statSync(path.join(assetDir,name)).isFile())fail('BUILD_ASSET_INVALID');const dest=path.join(live,'assets',name);if(fs.existsSync(dest)&&sha(fs.readFileSync(dest))!==sha(fs.readFileSync(path.join(assetDir,name))))fail('ASSET_COLLISION');}
  staged.push({kind,live,index,original,next,assetDir,names,cssBytes:Buffer.byteLength(css)});
 }
 for(const x of staged)if(sha(fs.readFileSync(x.index))!==m.indexHashes[x.kind])fail('INDEX_CAS_CHANGED');
 // Stage immutable assets; retain every previous file. Indexes activate only after final CAS.
 for(const x of staged)for(const name of x.names){fs.mkdirSync(path.join(x.live,'assets'),{recursive:true});const dest=path.join(x.live,'assets',name);if(!fs.existsSync(dest))fs.copyFileSync(path.join(x.assetDir,name),dest,fs.constants.COPYFILE_EXCL);}
 for(const x of staged)if(sha(fs.readFileSync(x.index))!==m.indexHashes[x.kind])fail('INDEX_CAS_CHANGED');
 const changed=[];try{for(const x of staged){const tmp=path.join(x.live,m.runId+'.tmp');fs.writeFileSync(tmp,x.next,{flag:'wx'});fs.renameSync(tmp,x.index);changed.push(x);}}catch(e){for(const x of changed){const undo=path.join(x.live,m.runId+'.rollback.tmp');fs.writeFileSync(undo,x.original,{flag:'wx'});fs.renameSync(undo,x.index);}throw e;}
 const receipt={status:'PASS',runId:m.runId,indexes:Object.fromEntries(staged.map(x=>[x.kind,{sha256:sha(x.next),cssBytes:x.cssBytes}])),databaseAccess:false,rowsChanged:0,oldAssetsPreserved:true,appStarted:false,noticesDispatched:false};fs.writeFileSync(path.join(artifacts,'receipt.json'),JSON.stringify(receipt,null,2),{flag:'wx'});console.log(JSON.stringify(receipt));
}
main().catch(e=>{console.error(JSON.stringify({status:'FAIL',code:/^[A-Z0-9_]+$/.test(e.code||'')?e.code:'RECONCILE_GUIDE_PREP_FAILED'}));process.exitCode=1;});
