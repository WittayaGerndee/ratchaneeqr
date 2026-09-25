// ทดสอบ logic ของ Apps Script ด้วย Node (mock Google services): node test/run-tests.js
const fs = require('fs'), vm = require('vm'), path = require('path');
process.env.TZ = 'Asia/Bangkok';
const dir = path.join(__dirname, '..', 'gas');

// ---- in-memory Spreadsheet ----
function makeSheet(name){ const data=[]; return {
  name, data,
  getLastRow(){ return data.length; }, getLastColumn(){ return data.reduce((m,r)=>Math.max(m,r.length),0); },
  getRange(a,b,c,d){ if(typeof a==='string') return {setNumberFormat(){return this}};
    const r=a,col=b,nr=c||1,nc=d||1; return {
    getValues(){ const out=[]; for(let i=0;i<nr;i++){const row=[];for(let j=0;j<nc;j++){const v=(data[r-1+i]||[])[col-1+j];row.push(v===undefined?'':v);}out.push(row);}return out;},
    setValues(v){ for(let i=0;i<v.length;i++){ data[r-1+i]=data[r-1+i]||[]; for(let j=0;j<v[i].length;j++) data[r-1+i][col-1+j]=v[i][j]; } return this;},
    setValue(v){ data[r-1]=data[r-1]||[]; data[r-1][col-1]=v; return this;},
    setFontWeight(){return this}, setBackground(){return this}, setNumberFormat(){return this}};},
  getDataRange(){ return this.getRange(1,1,Math.max(data.length,1),Math.max(this.getLastColumn(),1)); },
  appendRow(row){ data.push(row.slice()); }, deleteRow(n){ data.splice(n-1,1); }, setFrozenRows(){}
};}
const sheets={};
const ss={ getId:()=> 'SSID', getUrl:()=>'https://sheet', getSheetByName:n=>sheets[n]||null,
  insertSheet:n=>(sheets[n]=makeSheet(n)), getSheets:()=>Object.values(sheets), deleteSheet(){}};
const props={}; const pushed=[]; const replies=[];
const pad=n=>String(n).padStart(2,'0');
const ctx = {
  console,
  SpreadsheetApp:{ getActiveSpreadsheet:()=>ss, openById:()=>ss, create:()=>ss, flush(){} },
  PropertiesService:{ getScriptProperties:()=>({ getProperty:k=>props[k]??null, setProperty:(k,v)=>{props[k]=v;} }) },
  LockService:{ getScriptLock:()=>({ tryLock:()=>true, waitLock(){}, releaseLock(){} }) },
  CacheService:{ getScriptCache:()=>({ get:()=>null, put(){}, remove(){} }) },
  Session:{ getEffectiveUser:()=>({getEmail:()=>'owner@x.com'}), getActiveUser:()=>({getEmail:()=>ctx.__email}) },
  DriveApp:{ createFolder:()=>({getId:()=>'FOLDER'}), getFolderById:()=>fakeFolder() },
  ScriptApp:{ getProjectTriggers:()=>[], newTrigger:()=>{const t={timeBased:()=>t,everyHours:()=>t,everyDays:()=>t,atHour:()=>t,create:()=>t};return t;}, deleteTrigger(){} },
  Utilities:{
    formatDate(d,tz,f){ const y=d.getFullYear(); return f.replace(/yyyy/g,y).replace(/yy/g,String(y).slice(2)).replace(/MM/g,pad(d.getMonth()+1)).replace(/dd/g,pad(d.getDate())).replace(/HH/g,pad(d.getHours())).replace(/mm/g,pad(d.getMinutes())).replace(/ss/g,pad(d.getSeconds())).replace(/'T'/g,'T'); },
    parseDate(s){ return new Date(s.replace(' ','T')); },
    base64Decode:s=>Buffer.from(s,'base64'), newBlob:(b,m,n)=>({b,m,n}),
    computeDigest:(a,s)=>[...Buffer.from(s)], base64EncodeWebSafe:b=>Buffer.from(b).toString('base64'),
    DigestAlgorithm:{SHA_256:1}
  },
  UrlFetchApp:{ fetch(url,opt){ const p=JSON.parse(opt.payload||'{}'); if(url.includes('/push')) pushed.push(p); if(url.includes('/reply')) replies.push(p); if(url.includes('/multicast')) pushed.push(p);
     return { getResponseCode:()=>200, getContentText:()=>'{}', getBlob:()=>({setName(){return this}}) }; } },
  ContentService:{ createTextOutput:t=>({ setMimeType(){ return {text:t}; } }), MimeType:{JSON:'json'} },
  HtmlService:{ createTemplateFromFile:()=>({ evaluate:()=>({setTitle(){return this},addMetaTag(){return this},setXFrameOptionsMode(){return this}}) }), XFrameOptionsMode:{DEFAULT:1} },
};
const files=[]; function fakeFolder(){ return { getFoldersByName:()=>({hasNext:()=>false}), createFolder:()=>fakeFolder(), getFilesByName:()=>({hasNext:()=>false}), createFile:b=>{files.push(b.n);return {getUrl:()=>'https://drive/'+b.n};}, getUrl:()=>'https://drive/f' }; }
vm.createContext(ctx);
for (const f of fs.readdirSync(dir).filter(f=>f.endsWith('.gs'))) vm.runInContext(fs.readFileSync(path.join(dir,f),'utf8'), ctx, {filename:f});
const R = code => vm.runInContext(code, ctx);
const assert=(c,m)=>{ if(!c){ console.error('❌ FAIL', m); process.exitCode=1;} else console.log('✅', m); };

R('setup()'); R('seedSampleData()');
props.LINE_CHANNEL_ACCESS_TOKEN='tok';
R("setSettingValue_('REQUIRE_ID_TOKEN','FALSE')"); R("setSettingValue_('ADMIN_LINE_ID','U1')");
const post = body => JSON.parse(R(`doPost({postData:{contents:${JSON.stringify(JSON.stringify(body))}}})`).text);
ctx.__email='owner@x.com';
const T = {userId:'U1', displayName:'ครูทดสอบ'};
const call = (action, extra) => post(Object.assign({action}, T, extra||{}));
let r = call('bootstrap');
assert(r.ok && r.user.isTeacher && r.students.length===6 && r.assignments.length===2 && typeof r.students[0][0]==='string', 'bootstrap: 6 students, 2 assignments');
r = post({action:'bootstrap', userId:'U_STUDENT'});
assert(r.ok && !r.user.isTeacher && r.userId==='U_STUDENT' && !r.students, 'non-teacher bootstrap returns userId only');
r = post({action:'submitBatch', userId:'U_STUDENT', items:[{cid:'x', studentId:'65001', assignmentId:'HW001'}]});
assert(!r.ok && r.code==='NOT_TEACHER', 'non-teacher cannot submit');

// batch submit: ok, ok, duplicate in same batch, not found, wrong class, closed-by-target
const ts = new Date(Date.now()-60000).toISOString();
r = call('submitBatch', {items:[
  {cid:'a', studentId:'STU-65001', assignmentId:'HW001', ts},
  {cid:'b', studentId:'65002', assignmentId:'HW001', ts},
  {cid:'c', studentId:'65001', assignmentId:'HW001', ts},
  {cid:'d', studentId:'99999', assignmentId:'HW001', ts},
  {cid:'e', studentId:'65004', assignmentId:'HW002', ts}
]});
const by = Object.fromEntries(r.results.map(x=>[x.cid,x]));
assert(by.a.ok && by.b.ok && by.a.submission_id!==by.b.submission_id, 'batch: 2 recorded with distinct ids');
assert(by.c.code==='DUPLICATE' && by.d.code==='STUDENT_NOT_FOUND' && by.e.code==='NOT_TARGET', 'batch: dup / not found / wrong class');
assert(sheets.Submissions.data.length===3, 'one setValues wrote exactly 2 rows');
assert(new Date(sheets.Submissions.data[1][1]).toISOString()===ts, 'uses scan time from phone');
assert(pushed.length===0, 'no LINE push per scan');
r = call('submitBatch', {items:[{cid:'f', studentId:'65001', assignmentId:'HW001'}]});
assert(r.results[0].code==='DUPLICATE' && r.results[0].submittedText, 'duplicate across batches: '+r.results[0].submittedText);
r = call('bootstrap');
assert(r.subs.HW001 && r.subs.HW001['65001'] && r.subs.HW001['65002'] && Object.keys(r.subs.HW001).length===2, 'bootstrap returns subs map');

// undo
r = call('undo', {submissionId: by.b.submission_id});
assert(r.ok && sheets.Submissions.data.length===2, 'undo deletes row');

// students CRUD
r = call('saveStudent', {student:{student_id:'65020', name:'นายใหม่ เอี่ยม', class:'ม.5', room:'2'}});
assert(r.ok && r.student[0]==='65020', 'add student');
r = call('saveStudent', {student:{student_id:'65020', name:'ซ้ำ', class:'ม.5', room:'2'}});
assert(!r.ok && /มีอยู่แล้ว/.test(r.message), 'add duplicate id rejected');
r = call('saveStudent', {student:{student_id:'65021', name:'นายใหม่ แก้ชื่อ', class:'ม.5', room:'3'}, oldId:'65020'});
assert(r.ok && R("getStudent_('65021').name")==='นายใหม่ แก้ชื่อ' && !R("getStudent_('65020')"), 'edit student incl. id change');
r = call('deleteStudent', {studentId:'65021'});
assert(r.ok && !R("getStudent_('65021')"), 'delete student');
r = call('importStudents', {text:'รหัส\tชื่อ\tชั้น\tห้อง\n65030\tนางสาวเอ บี\tม.6\t1\n65001\tนายสมชาย ใจดีมาก\tม.5\t1\n\n'});
assert(r.ok && r.added===1 && r.updated===1 && r.skipped===1 && r.students.length===7, 'import: 1 added, 1 updated, header skipped');
assert(R("getStudent_('65001').name")==='นายสมชาย ใจดีมาก', 'import updates name');

// assignments
r = call('saveAssignment', {assignment:{subject:'ไทย', assignment_name:'เรียงความ', class_target:'ม.5/2', due_date:'2026-10-01T16:00'}});
assert(r.ok && r.assignment.assignment_id==='HW003' && r.assignment.status==='OPEN', 'create assignment HW003');
r = call('saveAssignment', {assignment:{assignment_id:'HW003', subject:'ไทย', assignment_name:'เรียงความ', class_target:'ม.5/2', status:'CLOSED'}});
assert(r.ok && r.assignment.status==='CLOSED', 'close assignment');
r = call('submitBatch', {items:[{cid:'g', studentId:'65004', assignmentId:'HW003'}]});
assert(r.results[0].code==='ASSIGNMENT_CLOSED', 'closed assignment rejects scans');
r = call('deleteAssignment', {assignmentId:'HW001'});
assert(!r.ok, 'cannot delete assignment with submissions');
r = call('deleteAssignment', {assignmentId:'HW003'});
assert(r.ok, 'delete unused assignment');

// webhook
R(`doPost({postData:{contents:${JSON.stringify(JSON.stringify({events:[{type:'message',replyToken:'rt',source:{userId:'U1'},message:{type:'text',text:'สรุป'}}]}))}}})`);
assert(replies.length===1 && replies[0].messages[0].text.includes('สรุปการส่งงาน'), 'webhook สรุป for teacher');
R(`doPost({postData:{contents:${JSON.stringify(JSON.stringify({events:[{type:'message',replyToken:'rt2',source:{userId:'UX'},message:{type:'text',text:'สรุป'}}]}))}}})`);
assert(replies[1].messages[0].text.includes('สำหรับครูเท่านั้น'), 'webhook blocks non-teacher');
// admin
ctx.__email='owner@x.com';
const d = R("adminDashboard('HW001')");
assert(d.selected.target===6 && d.selected.submitted===1 && d.selected.rooms.length===3, 'dashboard HW001: 1/6 across 3 rooms');
const miss = R("adminMissing('HW001','ม.5/1')");
assert(miss.students.length===2, 'missing in ม.5/1 = 2');
R("adminUpdateSubmission(adminList('Submissions')[0].submission_id,{status:'ผ่าน',score:'10',notify:true})");
assert(sheets.Submissions.data[1][9]==='ผ่าน', 'teacher sets status ผ่าน');
const imp = R("adminImportStudents('65010\\tนายใหม่ มาแล้ว\\tม.6\\t1\\n65001\\tนายสมชาย ใจดีมาก\\tม.5\\t1')");
assert(imp.added===1 && imp.updated===1, 'import students upsert');
const rep = R("adminStudentReport('')");
assert(rep.length===8, 'student report rows');
const soon = new Date(Date.now()+2*3600e3); const p2=n=>String(n).padStart(2,'0');
const soonStr = `${soon.getFullYear()}-${p2(soon.getMonth()+1)}-${p2(soon.getDate())}T${p2(soon.getHours())}:${p2(soon.getMinutes())}`;
R(`adminSave('Assignments',{assignment_id:'HW003',subject:'ไทย',assignment_name:'เรียงความ',class_target:'ALL',due_date:'${soonStr}',status:'open'},true)`);
const a3 = R("getAssignment_('HW003')");
assert(a3 && a3.status==='OPEN' && typeof a3.due_date.getTime==='function', 'admin create assignment w/ datetime');
ctx.__email='stranger@x.com';
let denied=false; try{ R("adminDashboard('')"); }catch(e){denied=true;} assert(denied,'non-teacher denied');
// reminders
pushed.length=0; R('sendDueReminders()');
assert(pushed.length===1 && pushed[0].to.includes('U1') && pushed[0].messages[0].text.includes('ยังไม่ส่ง'), 'due reminder → teachers with missing list');
console.log(R("fmtDateTimeTH_(new Date())"), R("parseStudentCode_('STU-2026-00125')"));
