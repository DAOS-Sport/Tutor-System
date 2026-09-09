const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const text=fs.readFileSync(path.join(root,'server/index.js'),'utf8');
const block=text.match(/\/\/ BEGIN graceful shutdown\n([\s\S]*?)\/\/ END graceful shutdown/);
assert.ok(block,'server must handle deployment SIGTERM gracefully');
const source=`const http=require('node:http');let finished=false;const pool={end:async()=>{if(!finished)throw Error('pool closed before response');console.log('POOL_END')}};const cron={getTasks:()=>new Map([['test',{stop:()=>console.log('CRON_STOP')}]])};const server=http.createServer((q,r)=>{console.log('REQUEST');setTimeout(()=>{finished=true;r.end('done')},150)});${block[1].replace("require('node-cron')","cron")}server.listen(0,'127.0.0.1',()=>console.log('PORT '+server.address().port));`;
(async()=>{
 const child=spawn(process.execPath,['-e',source],{stdio:['ignore','pipe','pipe']});let log='',err='',sent=false,response;
 const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
 child.stderr.on('data',x=>err+=x);
 child.stdout.on('data',chunk=>{log+=chunk;const port=log.match(/PORT (\d+)/);if(port&&!response){response=new Promise((resolve,reject)=>{http.get('http://127.0.0.1:'+port[1],res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve(body))}).on('error',reject)});}if(log.includes('REQUEST')&&!sent){sent=true;child.kill('SIGTERM');}});
 const result=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));clearTimeout(timer);
 assert.equal(result.code,0,err+log);assert.equal(result.signal,null);assert.equal(await response,'done');assert.ok(log.includes('CRON_STOP'));assert.ok(log.includes('POOL_END'));
 assert.match(fs.readFileSync(path.join(root,'.replit'),'utf8'),/NODE_ENV=production exec node index\.js/);
 console.log('PASS SIGTERM drains active HTTP request, stops cron, closes DB, exits 0');
})().catch(e=>{console.error(e);process.exit(1)});
