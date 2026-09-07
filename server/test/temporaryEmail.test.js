'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('temporary email cannot receive mail, including test-recipient overrides',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../services/mailer.js'),'utf8');let sent=0;
 const env={SMTP_HOST:'test',SMTP_USER:'test@example.test',SMTP_PASS:'test'};
 const ctx={module:{exports:{}},process:{env},require:(name)=>{assert.equal(name,'nodemailer');return{createTransport:()=>({sendMail:async()=>{sent++;return{messageId:'test'}}})}}};
 vm.runInNewContext(source,ctx);const mail=ctx.module.exports;
 for(const to of ['example@gmail.com',' EXAMPLE@GMAIL.COM ']){const r=await mail.sendMail({to,subject:'test'});assert.equal(r.status,'skipped');assert.equal(r.reason,'PLACEHOLDER_RECIPIENT');assert.equal(r.sent,false);}
 env.MAIL_TEST_RECIPIENT='example@gmail.com';assert.equal((await mail.sendMail({to:'real@example.test',subject:'test'})).reason,'PLACEHOLDER_RECIPIENT');assert.equal(sent,0);
 delete env.MAIL_TEST_RECIPIENT;assert.equal((await mail.sendMail({to:'real@example.test',subject:'test'})).sent,true);assert.equal(sent,1);
});
test('profile asks temporary-email users for their own address and preserves real addresses',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../../client/liff/src/pages/ProfilePage.jsx'),'utf8');
 const code=source.slice(source.indexOf('function parentFormFrom('),source.indexOf('function syncErrMsg('));const ctx={normalizeGender:x=>x};vm.runInNewContext(code,ctx);
 assert.equal(ctx.parentFormFrom({email:'example@gmail.com'}).email,'');assert.equal(ctx.parentFormFrom({email:' EXAMPLE@GMAIL.COM '}).email,'');assert.equal(ctx.parentFormFrom({email:'real@example.test'}).email,'real@example.test');assert.ok(source.includes('目前信箱為暫用資料'));
});
