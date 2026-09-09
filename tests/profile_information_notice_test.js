const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const req = require('node:module').createRequire(path.resolve('client/liff/package.json'));
const React = req('react');
const { renderToStaticMarkup } = req('react-dom/server');
const { transformSync } = req('esbuild');
const code = transformSync(fs.readFileSync('client/liff/src/pages/ProfilePage.jsx', 'utf8'), {loader:'jsx', format:'cjs'}).code;
const complete = {id:'fixture', name:'測試學員', id_number:'A123456789', birth_date:'2015-01-15', gender:'生理男'};
function render(student) {
  const parent = {name:'測試家長', students:[student]};
  const module = {exports:{}};
  vm.runInNewContext(code, {module, exports:module.exports, require(name) {
    if (name === 'react') return React;
    if (name.includes('AuthContext')) return {useAuth:()=>({parent})};
    if (name.includes('ToastContext')) return {useToast:()=>({})};
    if (name.includes('utils/format')) return {formatPlainDate:v=>v||'', normalizeGender:v=>v||''};
    if (name.includes('Collapsible')) return ({children})=>React.createElement('div',null,children);
    if (name.includes('ConfirmModal') || name.includes('DateTimePicker')) return ()=>null;
    if (name.includes('api/')) return {};
    throw new Error(name);
  }});
  return renderToStaticMarkup(React.createElement(module.exports.default));
}
for (const patch of [{name:''},{name:'   '},{id_number:''},{id_number:'invalid'},{birth_date:''},{gender:''}]) {
  const html=render({...complete,...patch});
  assert.match(html,/不影響您既有的課程與權益/,'Incomplete student needs a nonblocking reminder');
  assert.match(html,/補填學員資料/);
}
assert.match(render({...complete,name:''}),/待補姓名/);
assert.doesNotMatch(render(complete),/不影響您既有的課程與權益/);
assert.doesNotMatch(render({...complete,name:'',is_active:false}),/不影響您既有的課程與權益/);
console.log('PASS incomplete/blank student reminder, complete and inactive students excluded');
