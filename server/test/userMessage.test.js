'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {test}=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../../client/shared/userMessage.js'),'utf8');
const load=()=>import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
test('business messages survive; source, SQL, JSON and exception details stay off screen',async()=>{
 const {toUserMessage:safe,humanizeApiError:clean}=await load();
 for(const value of ['請填寫扣課原因','固定手續費不可超過剩餘金額','只接受 JPG / PNG 圖片'])assert.equal(safe(value),value);
 for(const value of ['TypeError: 讀取 undefined','錯誤：SELECT id FROM students','欄位 course_sessions.completed_at 不存在','失敗 <html>伺服器錯誤</html>','{"error":"資料錯誤"}',{error:'資料錯誤'},'Cannot read properties of undefined','RAGIC_VALIDATION_ERROR'])assert.equal(safe(value,'安全提示'),'安全提示');
 const error={message:'raw',response:{status:409,data:{error:'constraint failed',code:'IDEMPOTENCY_CONFLICT',detail:'internal'}}};
 assert.equal(clean(error),error);assert.equal(error.response.status,409);assert.equal(error.response.data.code,'IDEMPOTENCY_CONFLICT');assert.match(error.message,/資料已變動/);assert.equal(error.response.data.error,error.message);
 const html={response:{status:502,data:'<html>Bad Gateway</html>'}};clean(html);assert.equal(typeof html.response.data.error,'string');assert.ok(!html.response.data.error.includes('html'));
 const timeout={message:'timeout of 10000ms exceeded'};clean(timeout);assert.match(timeout.message,/先確認操作結果/);
});
test('manual deduction result presents business labels instead of database fields',()=>{
 const page=fs.readFileSync(path.join(__dirname,'../../client/admin/src/pages/ManualDeductionPage.jsx'),'utf8');
 assert.ok(!/label="(?:course_sessions|checkin_records|manual_lesson_deductions|request_id)/.test(page));
 assert.ok(!/>scheduled_at<|>created_at<|寫入欄位對照/.test(page));
 assert.ok(page.includes('實際操作時間')&&page.includes('剩餘堂數'));
 const boundary=fs.readFileSync(path.join(__dirname,'../../client/shared/ErrorBoundary.jsx'),'utf8').split('  render() {')[1];
 assert.ok(!boundary.includes('this.state.error.message'));
});
