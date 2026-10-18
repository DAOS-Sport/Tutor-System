'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const target='e7eef8e210c8f91f9c9a8c1c9d6d3ec9db0e3568323ce3bb2ddb2c09dabe1a3d';
const binary='/home/runner/workspace/outputs/preview-ragic-rust-replay-20260930-b193ff3e/sha256-b193ff3ef079c718d3e6cc902bb2ffc46c9ff6b0c3c7fdda333967d4d838bcc5-ragic-shadow-core-linux-x86_64';
async function main(){
 if(process.argv.length!==3||process.argv[2]!==target)throw Error('target');
 require('../services/previewOutboundGuard.cjs').install({connectionString:process.env.DATABASE_URL,expectedTargetHash:target,replayPolicy:{binary,sha256:'b193ff3ef079c718d3e6cc902bb2ffc46c9ff6b0c3c7fdda333967d4d838bcc5'}});
 const child=require('node:child_process'),options={shell:false,windowsHide:true,cwd:path.dirname(binary),env:{LANG:'C',TZ:'UTC'},stdio:['pipe','pipe','pipe']};
 assert.throws(()=>child.exec('echo never'),{code:'PREVIEW_SIDE_EFFECTS_BLOCKED'});
 assert.throws(()=>child.spawn(binary,['worker-lease'],options),{code:'PREVIEW_REPLAY_REFUSED'});
 assert.throws(()=>child.spawn(process.execPath,['replay-stdin'],options),{code:'PREVIEW_REPLAY_REFUSED'});
 assert.throws(()=>child.spawn(binary,['replay-stdin'],{...options,env:{...options.env,UNEXPECTED:'1'}}),{code:'PREVIEW_REPLAY_REFUSED'});
 await assert.rejects(fetch('https://example.invalid'),{code:'PREVIEW_SIDE_EFFECTS_BLOCKED'});
 const result=await new Promise((resolve,reject)=>{const p=child.spawn(binary,['replay-stdin'],options);let out='';p.stdout.on('data',b=>out+=b);p.stderr.resume();p.on('error',reject);p.on('close',code=>code===0?resolve(JSON.parse(out)):reject(Error('replay')));p.stdin.end(JSON.stringify({command:'replay',payload:{contract_version:1,replay_schema_version:2,snapshot:{'parent:synthetic':{id:'synthetic',name:'DEMO'}},snapshot_versions:{'parent:synthetic':0},snapshot_event_ids:[],target_event_ids:[],transaction_manifest:[],events:[]}}));});
 assert.deepEqual(result.rows,{'parent:synthetic':{id:'synthetic',name:'DEMO'}});
 console.log(JSON.stringify({status:'TIMELINE_NARROW_GUARD_PASS',cases:['fixed-linux-replay','exec-denied','worker-args-denied','other-binary-denied','extra-env-denied','fetch-denied'],appStarted:false,databaseAccess:false,keyAccess:false}));
}
main().catch(()=>{console.error(JSON.stringify({status:'FAIL',code:'TIMELINE_NARROW_GUARD_FAILED'}));process.exitCode=20;});
