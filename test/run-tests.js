// ทดสอบ logic ของ Apps Script ด้วย Node (mock Google services): node test/run-tests.js
const fs = require('fs'), vm = require('vm'), path = require('path');
process.env.TZ = 'Asia/Bangkok';
const dir = path.join(__dirname, '..', 'gas');

// ---- in-memory Spreadsheet ----
const SHEET_CALLS={n:0}; const hit=()=>SHEET_CALLS.n++; // นับจำนวนครั้งที่เรียก Google Sheets
function makeSheet(name){ const data=[]; return {
  name, data, getName(){ return name; },
  getLastRow(){ return data.length; }, getLastColumn(){ return data.reduce((m,r)=>Math.max(m,r.length),0); },
  getRangeList(a1s){ return { setNumberFormat(){ hit(); return this; }, a1s }; },
  getRange(a,b,c,d){ if(typeof a==='string') return {setNumberFormat(){ hit(); return this}};
    const r=a,col=b,nr=c||1,nc=d||1; return {
    getValues(){ hit(); const out=[]; for(let i=0;i<nr;i++){const row=[];for(let j=0;j<nc;j++){const v=(data[r-1+i]||[])[col-1+j];row.push(v===undefined?'':v);}out.push(row);}return out;},
    setValues(v){ hit(); for(let i=0;i<v.length;i++){ data[r-1+i]=data[r-1+i]||[]; for(let j=0;j<v[i].length;j++) data[r-1+i][col-1+j]=v[i][j]; } return this;},
    setValue(v){ data[r-1]=data[r-1]||[]; data[r-1][col-1]=v; return this;},
    clearContent(){ for(let i=0;i<nr;i++){ if(data[r-1+i]) for(let j=0;j<nc;j++) data[r-1+i][col-1+j]=''; } return this;},
    setFontWeight(){return this}, setBackground(){return this}, setNumberFormat(){ hit(); return this}};},
  getDataRange(){ return this.getRange(1,1,Math.max(data.length,1),Math.max(this.getLastColumn(),1)); },
  appendRow(row){ data.push(row.slice()); }, deleteRow(n){ data.splice(n-1,1); }, setFrozenRows(){}, getMaxRows(){ return Math.max(data.length, 1000); }
};}
const cacheStore=new Map(); const sharedWith=[];
const spreadsheets={};
function makeSS(id){ const sh={}; const o={ id, sheets:sh, getId:()=>id, getUrl:()=>'https://sheet/'+id, getSheetByName:n=>sh[n]||null,
  insertSheet:n=>(sh[n]=makeSheet(n)), getSheets:()=>Object.values(sh), deleteSheet(x){ delete sh[x.name]; } }; spreadsheets[id]=o; return o; }
const ss=makeSS('SSID'); const sheets=ss.sheets; let ssCount=0;
const props={}; const pushed=[]; const replies=[];
const pad=n=>String(n).padStart(2,'0');
const ctx = {
  console,
  SpreadsheetApp:{ getActiveSpreadsheet:()=>ss, openById:id=>spreadsheets[id]||ss, create:()=>{ const n=makeSS('NEWSS'+(++ssCount)); n.insertSheet('Sheet1'); return n; }, flush(){} },
  PropertiesService:{ getScriptProperties:()=>({ getProperty:k=>props[k]??null, setProperty:(k,v)=>{props[k]=v;} }) },
  LockService:{ getScriptLock:()=>({ tryLock:()=>true, waitLock(){}, releaseLock(){} }), getUserLock:()=>({ tryLock:()=>true, waitLock(){}, releaseLock(){} }) },
  CacheService:{ getScriptCache:()=>({ get:k=>cacheStore.has(k)?cacheStore.get(k):null, put:(k,v)=>cacheStore.set(k,v), remove:k=>cacheStore.delete(k), removeAll:ks=>ks.forEach(k=>cacheStore.delete(k)) }) },
  Session:{ getEffectiveUser:()=>({getEmail:()=>'owner@x.com'}), getActiveUser:()=>({getEmail:()=>ctx.__email}) },
  DriveApp:{ createFolder:()=>({getId:()=>'FOLDER'}), getFolderById:()=>fakeFolder(), getFileById:id=>({ moveTo(){}, setSharing(){}, addEditor(e){ sharedWith.push([id,e]); } }), Access:{ANYONE_WITH_LINK:1}, Permission:{VIEW:1} },
  ScriptApp:{ getProjectTriggers:()=>[], newTrigger:()=>{const t={timeBased:()=>t,everyHours:()=>t,everyDays:()=>t,atHour:()=>t,create:()=>t};return t;}, deleteTrigger(){} },
  Utilities:{
    formatDate(d,tz,f){ const y=d.getFullYear(); return f.replace(/yyyy/g,y).replace(/yy/g,String(y).slice(2)).replace(/MM/g,pad(d.getMonth()+1)).replace(/dd/g,pad(d.getDate())).replace(/HH/g,pad(d.getHours())).replace(/mm/g,pad(d.getMinutes())).replace(/ss/g,pad(d.getSeconds())).replace(/'T'/g,'T'); },
    parseDate(s){ return new Date(s.replace(' ','T')); },
    base64Decode:s=>Buffer.from(s,'base64'), base64Encode:b=>Buffer.from(b).toString('base64'),
    newBlob:(b,m,n)=>({b,m,n, getAs(){ return { n:'pdf', setName(x){ this.n=x; return this; } }; }}),
    computeDigest:(a,s)=>[...Buffer.from(s)], base64EncodeWebSafe:b=>Buffer.from(b).toString('base64'),
    DigestAlgorithm:{SHA_256:1}
  },
  UrlFetchApp:{ fetchAll(reqs){ return reqs.map(()=>({ getResponseCode:()=>200, getBlob:()=>({getBytes:()=>[1,2,3]}) })); }, fetch(url,opt){ opt=opt||{}; const p=JSON.parse(opt.payload||'{}'); if(url.includes('/push')) pushed.push(p); if(url.includes('/reply')) replies.push(p); if(url.includes('/multicast')) pushed.push(p);
     return { getResponseCode:()=>200, getContentText:()=>'{}', getBlob:()=>({setName(){return this}}) }; } },
  ContentService:{ createTextOutput:t=>({ setMimeType(){ return {text:t}; } }), MimeType:{JSON:'json'} },
  HtmlService:{ createTemplateFromFile:()=>({ evaluate:()=>({setTitle(){return this},addMetaTag(){return this},setXFrameOptionsMode(){return this}}) }), XFrameOptionsMode:{DEFAULT:1} },
};
const files=[]; let folderN=0; function fakeFolder(){ const id='FOLDER'+(folderN++); return { getId:()=>id, getFoldersByName:()=>({hasNext:()=>false}), createFolder:()=>fakeFolder(), getFilesByName:()=>({hasNext:()=>false}), createFile:b=>{files.push(b.n);return {getUrl:()=>'https://drive/'+b.n, getId:()=>'FILE1', setSharing(){}};}, getUrl:()=>'https://drive/f' }; }
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
r = call('importStudents', {text:'0003\tเด็กหญิงเอ\tป.4/5'});
assert(r.ok && r.added===1 && r.students.some(x=>x[0]==='0003' && x[2]==='ป.4' && x[3]==='5'), 'import "ป.4/5" in one column');
assert(R("getStudent_('65001').name")==='นายสมชาย ใจดีมาก', 'import updates name');

// leading zeros + class/room split (bug: "Cannot read properties of null (reading 'student_id')")
r = call('saveStudent', {student:{student_id:'0001', name:'ใจดี มีโชค', class:'ป.4', room:'5'}});
assert(r.ok && r.student[0]==='0001' && r.student[3]==='5', 'add student 0001 returns record (was null)');
r = call('saveStudent', {student:{student_id:'0002', name:'สมศรี ดีใจ', class:'ป.4/5', room:''}});
assert(r.ok && r.student[2]==='ป.4' && r.student[3]==='5', 'class "ป.4/5" split into class+room');
r = call('saveStudent', {student:{student_id:'1', name:'ซ้ำกับ 0001', class:'ป.4', room:'5'}});
assert(!r.ok, '"1" treated as same id as "0001"');
r = call('saveAssignment', {assignment:{subject:'ไทย', assignment_name:'ป4 งาน', class_target:'ป.4/5'}});
const p4 = r.assignment.assignment_id;
r = call('submitBatch', {items:[{cid:'z1', studentId:'STU-0001', assignmentId:p4},{cid:'z2', studentId:'2', assignmentId:p4}]});
assert(r.results.every(x=>x.ok), 'scan STU-0001 and "2" both match (leading zeros)');
r = call('bootstrap');
assert(r.students.some(x=>x[0]==='0001'), 'bootstrap keeps "0001" text');

// scores: sheet made before max_score column existed → column added on save
const aHs = sheets.Assignments.data[0]; const msIdx = aHs.indexOf('max_score'); aHs.splice(msIdx, 1); R("_headersMemo = {}");
r = call('saveAssignment', {assignment:{subject:'ไทย', assignment_name:'ใบงานมีคะแนน', class_target:'ป.4/5', max_score:'10'}});
const SC = r.assignment.assignment_id;
assert(r.ok && r.assignment.max_score===10 && sheets.Assignments.data[0].includes('max_score'), 'assignment with max_score (column auto-added)');
r = call('saveAssignment', {assignment:{subject:'ไทย', assignment_name:'x', max_score:'-1'}});
assert(!r.ok, 'max_score must be positive');
r = call('submitBatch', {items:[
  {cid:'s1', studentId:'0001', assignmentId:SC, score:8},
  {cid:'s2', studentId:'0002', assignmentId:SC},
  {cid:'s3', studentId:'0002', assignmentId:SC, scoreOnly:true, score:'9.5'},
  {cid:'s4', studentId:'0003', assignmentId:SC, scoreOnly:true, score:5},
  {cid:'s5', studentId:'0001', assignmentId:SC, scoreOnly:true, score:11}
]});
const sb = Object.fromEntries(r.results.map(x=>[x.cid,x]));
assert(sb.s1.ok && sb.s1.score===8 && sb.s2.ok && sb.s3.ok && sb.s3.code==='SCORED' && sb.s3.score===9.5, 'submit with score + score new row in same batch');
assert(sb.s4.code==='NOT_SUBMITTED' && sb.s5.code==='BAD_SCORE', 'scoreOnly needs submission; score over max rejected');
r = call('submitBatch', {items:[{cid:'s6', studentId:'0001', assignmentId:SC, scoreOnly:true, score:7}, {cid:'s7', studentId:'0002', assignmentId:SC, score:''}]});
assert(r.results[0].ok && r.results[1].code==='DUPLICATE', 'rescore existing row / duplicate with cleared score');
const subRow = id => R(`readTable_('Submissions').filter(function(x){return x.student_id==='${id}' && x.assignment_id==='${SC}'})[0]`);
assert(subRow('0001').score===7 && subRow('0001').status==='ครูตรวจแล้ว' && subRow('0001').checked_by, 'score saved to sheet, status ครูตรวจแล้ว');
assert(subRow('0002').score==='', 'score cleared');
r = call('bootstrap');
assert(r.subs[SC]['0001'][3]===7 && r.subs[SC]['0002'][3]==='', 'bootstrap subs include score');
r = call('gradebook');
assert(r.ok && r.assignments.some(a=>a.assignment_id===SC && a.max_score===10) && r.scores[SC]['0001'][0]===7, 'gradebook returns scores');
// subjects: old sheet without Subjects → created + filled from existing assignments
delete sheets.Subjects; R("_headersMemo = {}; _ssMemo = null");
r = call('bootstrap');
const subjNames = r.subjects.map(x=>x.name);
assert(sheets.Subjects && subjNames.includes('ไทย') && subjNames.includes('คอมพิวเตอร์') && new Set(subjNames).size===subjNames.length, 'subjects auto-imported from assignments (no duplicates)');
r = call('saveSubject', {subject:{name:'ศิลปะ', class_target:'ป.4/5'}});
assert(r.ok && /^SJ\d{3}$/.test(r.subject.subject_id) && r.subject.class_target==='ป.4/5', 'add subject');
const ART = r.subject.subject_id;
r = call('saveSubject', {subject:{name:' ศิลปะ '}});
assert(!r.ok, 'duplicate subject name rejected');
r = call('saveAssignment', {assignment:{subject:'ศิลปะ', assignment_name:'วาดภาพ', class_target:'ป.4/5'}});
const artTask = r.assignment.assignment_id;
r = call('saveSubject', {subject:{subject_id:ART, name:'ศิลปะและการออกแบบ'}});
assert(r.ok && r.renamed && R(`getAssignment_('${artTask}').subject`)==='ศิลปะและการออกแบบ', 'rename subject updates its assignments');
r = call('deleteSubject', {subjectId:ART});
assert(!r.ok && /ใบงาน/.test(r.message), 'cannot delete subject that has assignments');
r = call('saveSubject', {subject:{name:'ลบได้'}});
r = call('deleteSubject', {subjectId:r.subject.subject_id});
assert(r.ok && !r.subjects.some(x=>x.name==='ลบได้'), 'delete unused subject');
r = call('saveAssignment', {assignment:{subject:'วิชาใหม่จากใบงาน', assignment_name:'x'}});
assert(call('bootstrap').subjects.some(x=>x.name==='วิชาใหม่จากใบงาน'), 'assignment with unknown subject adds it to subjects');
call('saveAssignment', {assignment:{assignment_id:SC, subject:'ไทย', assignment_name:'ใบงานมีคะแนน', class_target:'ป.4/5', status:'CLOSED'}});
r = call('submitBatch', {items:[{cid:'s8', studentId:'0001', assignmentId:SC, scoreOnly:true, score:6}]});
assert(r.results[0].ok && subRow('0001').score===6, 'can score after assignment closed');
// รหัสนักเรียนอัตโนมัติ + เลขที่ (ห้องเดียวกันห้ามซ้ำ, ต่างห้องซ้ำได้)
assert(R("nextStudentId_([{student_id:'0009'},{student_id:'65001'},{student_id:'abc'}])")==='65002' && R("nextStudentId_([{student_id:'0009'}])")==='0010' && R("nextStudentId_([])")==='1001', 'nextStudentId_');
r = call('saveStudent', {student:{name:'อัตโนมัติ หนึ่ง', class:'ป.2', room:'1', number:'1'}});
const auto1 = r.student[0];
assert(r.ok && /^\d+$/.test(auto1) && r.student[4]==='1', 'new student gets auto id '+auto1+' + number');
r = call('saveStudent', {student:{name:'อัตโนมัติ สอง', class:'ป.2', room:'1', number:'01'}});
assert(!r.ok && /เลขที่ 1 ห้อง ป.2\/1/.test(r.message), 'same number in same room rejected');
r = call('saveStudent', {student:{name:'อัตโนมัติ สอง', class:'ป.2', room:'2', number:'1'}});
assert(r.ok && Number(r.student[0])===Number(auto1)+1, 'same number in another room ok, next id');
r = call('saveStudent', {student:{name:'อัตโนมัติ หนึ่ง (แก้)', class:'ป.2', room:'1', number:'1'}, oldId:auto1});
assert(r.ok && r.student[0]===auto1, 'edit keeps own number and id');
r = call('saveStudent', {student:{name:'x', class:'ป.2', room:'1', number:'a'}});
assert(!r.ok, 'number must be digits');
r = call('importStudents', {format:'number', text:'เลขที่\tชื่อ\tชั้น\tห้อง\n2\tนำเข้า ก\tป.2\t1\n1\tอัตโนมัติ หนึ่ง ชื่อใหม่\tป.2\t1\n3\tนำเข้า ข\tป.2/2\n\tไม่มีเลขที่\tป.2\t1'});
assert(r.ok && r.added===3 && r.updated===1 && r.skipped===1, 'import by number: 3 added, 1 updated (room+number), header skipped');
const pStu2 = R("readTable_('Students').filter(function(x){return x.class==='ป.2'}).map(function(x){return [x.student_id,x.name,x.room,String(x.number)]})");
assert(pStu2.some(x=>x[0]===auto1 && x[1]==='อัตโนมัติ หนึ่ง ชื่อใหม่') && new Set(pStu2.map(x=>x[0])).size===pStu2.length, 'import updates by room+number, all ids unique');
// ตรวจบัค: แก้ใบงานที่ถูกลบไปแล้ว ต้องไม่สร้างใบงานใหม่แทน
r = call('saveAssignment', {assignment:{assignment_id:'HW999', subject:'ไทย', assignment_name:'ผี'}});
assert(!r.ok && !R("getAssignment_('HW999')"), 'editing a deleted assignment is rejected (not re-created)');
// ตรวจบัค: ค่าส่วนกลางของบัญชีย่อยจำไว้ต่อการทำงาน และไม่ทำให้ header ของบัญชีสลับกัน
R("_globalMemo = {}"); const hmBefore = R("JSON.stringify(_headersMemo)"); R("mainSetting_('QR_STUDENT_PREFIX','STU-')");
assert(R("_globalMemo.QR_STUDENT_PREFIX")==='STU-' && R("JSON.stringify(_headersMemo)")===hmBefore, 'mainSetting_ memoizes and restores header memo');
// Array Batch: ให้คะแนนย้อนหลังหลายคน อ่าน/เขียน Sheets ไม่กี่ครั้ง และค่าถูกต้อง
assert(R("colLetter_(1)")==='A' && R("colLetter_(26)")==='Z' && R("colLetter_(27)")==='AA' && R("colLetter_(52)")==='AZ', 'colLetter_');
r = call('saveAssignment', {assignment:{subject:'คณิต', assignment_name:'batch', class_target:'ALL', max_score:'10'}});
const BT = r.assignment.assignment_id;
const ids = R("readTable_('Students').filter(isStudentActive_).map(function(s){return String(s.student_id)})");
call('submitBatch', {items: ids.map((id,i)=>({cid:'bt'+i, studentId:id, assignmentId:BT}))});
const noteBefore = R(`readTable_('Submissions').filter(function(x){return x.assignment_id==='${BT}'}).map(function(x){return x.name})`);
SHEET_CALLS.n = 0;
r = call('submitBatch', {items: ids.map((id,i)=>({cid:'bs'+i, studentId:id, assignmentId:BT, scoreOnly:true, score:(i%10)+0.5}))});
const scoreCalls = SHEET_CALLS.n;
const after = R(`readTable_('Submissions').filter(function(x){return x.assignment_id==='${BT}'})`);
assert(r.results.every(x=>x.ok) && after.every((x,i)=>x.score===(ids.indexOf(String(x.student_id))%10)+0.5 && x.status==='ครูตรวจแล้ว' && x.checked_by), 'batch rescore '+ids.length+' students: values correct');
assert(JSON.stringify(after.map(x=>x.name))===JSON.stringify(noteBefore), 'batch rescore keeps other columns intact');
assert(scoreCalls <= 12, 'batch rescore uses few Sheets calls ('+scoreCalls+')');
SHEET_CALLS.n = 0;
call('saveStudent', {student:{student_id:'0777', name:'เลขศูนย์', class:'ป.4', room:'5'}});
assert(R("getStudent_('0777').student_id")==='0777', 'text format still keeps leading zero (RangeList)');
// delete assignment with submissions: needs force, removes its submissions only
const beforeSubs = R("readTable_('Submissions').length");
const scCount = R(`readTable_('Submissions').filter(function(x){return x.assignment_id==='${SC}'}).length`);
r = call('deleteAssignment', {assignmentId:SC});
assert(!r.ok && r.code==='HAS_SUBMISSIONS' && r.count===scCount, 'delete used assignment needs confirmation (count '+scCount+')');
r = call('deleteAssignment', {assignmentId:SC, force:true});
assert(r.ok && r.removedSubmissions===scCount && !R(`getAssignment_('${SC}')`) && R("readTable_('Submissions').length")===beforeSubs-scCount, 'forced delete removes assignment + its submissions only');
r = call('saveSettings', {settings:{SCHOOL_NAME:'โรงเรียนอนุบาลศรีสุทโธ', ADMIN_NAME:'ครูรัชนี', EVIL:'x'}});
assert(r.ok && r.school==='โรงเรียนอนุบาลศรีสุทโธ' && r.adminName==='ครูรัชนี' && !R("findOne_('Settings','key','EVIL')"), 'admin saves settings (whitelisted keys)');
r = call('bootstrap');
assert(r.user.teacherName==='ครูรัชนี' && r.school==='โรงเรียนอนุบาลศรีสุทโธ' && r.user.isAdmin, 'header shows school + teacher name');

// assignments
r = call('saveAssignment', {assignment:{subject:'ไทย', assignment_name:'เรียงความ', class_target:'ม.5/2', due_date:'2026-10-01T16:00'}});
assert(r.ok && /^HW\d{3}$/.test(r.assignment.assignment_id) && r.assignment.status==='OPEN', 'create assignment');
const HW3=r.assignment.assignment_id;
let rr1 = call('saveAssignment', {reqId:'retry-1', assignment:{subject:'ไทย', assignment_name:'ทดสอบส่งซ้ำ'}});
let rr2 = call('saveAssignment', {reqId:'retry-1', assignment:{subject:'ไทย', assignment_name:'ทดสอบส่งซ้ำ'}});
assert(rr1.ok && rr2.assignment.assignment_id===rr1.assignment.assignment_id && R("readTable_('Assignments').filter(a=>a.assignment_name==='ทดสอบส่งซ้ำ').length")===1, 'retry with same reqId does not create twice');
R("deleteRecord_('Assignments','"+rr1.assignment.assignment_id+"')");
r = call('saveAssignment', {assignment:{assignment_id:HW3, subject:'ไทย', assignment_name:'เรียงความ', class_target:'ม.5/2', status:'CLOSED'}});
assert(r.ok && r.assignment.status==='CLOSED', 'close assignment');
r = call('submitBatch', {items:[{cid:'g', studentId:'65004', assignmentId:HW3}]});
assert(r.results[0].code==='ASSIGNMENT_CLOSED', 'closed assignment rejects scans');
r = call('deleteAssignment', {assignmentId:'HW001'});
assert(!r.ok, 'cannot delete assignment with submissions');
r = call('deleteAssignment', {assignmentId:HW3});
assert(r.ok, 'delete unused assignment');

// webhook
R(`doPost({postData:{contents:${JSON.stringify(JSON.stringify({events:[{type:'message',replyToken:'rt',source:{userId:'U1'},message:{type:'text',text:'สรุป'}}]}))}}})`);
assert(replies.length===1 && replies[0].messages[0].text.includes('สรุปการส่งงาน'), 'webhook สรุป for teacher');
R(`doPost({postData:{contents:${JSON.stringify(JSON.stringify({events:[{type:'message',replyToken:'rt2',source:{userId:'UX'},message:{type:'text',text:'สรุป'}}]}))}}})`);
assert(replies[1].messages[0].altText.includes('ยังไม่มีบัญชี'), 'webhook: non-teacher gets request-access button');
// ---------------- บัญชีแยก: ผู้ดูแลระบบสร้างบัญชีให้ ----------------
R("setSettingValue_('ADMIN_LINE_ID','U1')");
const NEWU='U'+'a'.repeat(32), T2='U'+'b'.repeat(32), OUT='U'+'c'.repeat(32);
const as = (uid, action, extra) => post(Object.assign({action, userId:uid, displayName:'x'}, extra||{}));
const mainStudentsBefore = as('U1','bootstrap').students.length;
r = as(NEWU,'bootstrap');
assert(r.ok && r.registered===false && r.userId===NEWU && !r.students && r.adminName==='', 'unknown user sees request-access (no MAIN info leaked)');
r = as(NEWU,'register',{school:'x', teacherName:'y'});
assert(!r.ok, 'self sign-up no longer possible');
r = as(NEWU,'saveStudent',{student:{student_id:'1', name:'x', class:'ป.1', room:'1'}});
assert(!r.ok && r.code==='NOT_TEACHER', 'unregistered cannot write');
pushed.length=0;
r = as(NEWU,'requestAccess',{email:'new.teacher@gmail.com', name:'ครูใหม่', school:'โรงเรียนใหม่'});
assert(r.ok && pushed.length===1 && pushed[0].to==='U1' && pushed[0].messages[0].text.includes(NEWU) && pushed[0].messages[0].text.includes('new.teacher@gmail.com'), 'request sends LINE ID + email to admin');
assert(pushed[0].messages[1].template.actions[0].uri.includes('mode=accounts'), 'request message has prefilled create-account link');
r = as(NEWU,'requestAccess',{email:'bad'});
assert(r.ok && r.already, 'request rate-limited (no spam)');
r = as('U1','bootstrap');
assert(r.user.isSuper, 'MAIN admin is super admin');
r = as(T2,'createAccount',{lineUserId:NEWU, email:'x@gmail.com', school:'s', teacherName:'t'});
assert(!r.ok, 'non-admin cannot create accounts');
pushed.length=0;
r = as('U1','createAccount',{lineUserId:NEWU, email:'New.Teacher@gmail.com', school:'โรงเรียนใหม่', teacherName:'ครูใหม่'});
assert(r.ok && r.created && r.shared && /docs\.google\.com\/spreadsheets\/d\/NEWSS1/.test(r.sheet_url), 'admin creates account + shares sheet');
assert(sharedWith.some(x=>x[0]==='NEWSS1' && x[1]==='new.teacher@gmail.com'), 'sheet shared to user email (lowercased)');
assert(pushed.some(p=>p.to===NEWU), 'user notified on LINE');
assert(r.accounts.some(a=>a.tenant_id!=='MAIN' && a.email==='new.teacher@gmail.com' && a.members.length===1), 'account list shows email + member');
r = as('U1','createAccount',{lineUserId:NEWU, email:'x@gmail.com', school:'อีก', teacherName:'x'});
assert(!r.ok && /มีบัญชีอยู่แล้ว/.test(r.message) && ssCount===1, 'no duplicate account for same LINE ID');
r = as('U1','createAccount',{lineUserId:'U123', email:'x@gmail.com', school:'s', teacherName:'t'});
assert(!r.ok && /LINE ID ไม่ถูกต้อง/.test(r.message), 'invalid LINE ID rejected');
r = as(NEWU,'bootstrap');
assert(r.registered && r.school==='โรงเรียนใหม่' && r.user.teacherName==='ครูใหม่' && r.user.isAdmin && !r.user.isSuper && r.students.length===0, 'new user now has own empty account');
assert(Object.keys(spreadsheets).includes('NEWSS1') && spreadsheets.NEWSS1.sheets.Students && !spreadsheets.NEWSS1.sheets.Sheet1, 'new Google Sheet with all tabs');
r = as(NEWU,'accounts');
assert(!r.ok, 'account admin is not super admin');
r = as(NEWU,'saveStudent',{student:{student_id:'0001', name:'นักเรียนบัญชีใหม่', class:'ป.1', room:'1'}});
assert(r.ok && spreadsheets.NEWSS1.sheets.Students.data.length===2, 'student saved into the new account sheet');
assert(as('U1','bootstrap').students.length===mainStudentsBefore && !as('U1','bootstrap').students.some(x=>x[1]==='นักเรียนบัญชีใหม่'), 'MAIN account does not see new account data');
r = as(NEWU,'saveAssignment',{assignment:{subject:'คณิต', assignment_name:'แบบฝึก 1', class_target:'ALL'}});
const na = r.assignment.assignment_id;
r = as(NEWU,'submitBatch',{items:[{cid:'n1', studentId:'1', assignmentId:na}]});
assert(r.results[0].ok && spreadsheets.NEWSS1.sheets.Submissions.data.length===2, 'scan saved into new account');
r = as('U1','submitBatch',{items:[{cid:'n2', studentId:'0001', assignmentId:na}]});
assert(!r.results[0].ok, 'MAIN teacher cannot scan into another account');
const tid = as('U1','accounts').accounts.find(a=>a.tenant_id!=='MAIN').tenant_id;
r = as('U1','createAccount',{lineUserId:T2, email:'helper@gmail.com', teacherName:'ครูผู้ช่วย', tenantId:tid, role:'teacher'});
assert(r.ok && !r.created && r.shared, 'admin adds co-teacher to existing account + shares sheet');
r = as(T2,'bootstrap');
assert(r.registered && r.school==='โรงเรียนใหม่' && r.students.length===1 && !r.user.isAdmin, 'co-teacher sees same account (not admin)');
r = as(T2,'saveSettings',{settings:{SCHOOL_NAME:'แฮก'}});
assert(!r.ok, 'co-teacher cannot change settings');
const MAINT='U'+'d'.repeat(32);
R("useTenant_(null); appendRow_('Teachers',{teacher_id:'T009',name:'ครูบัญชีหลัก',line_user_id:'"+MAINT+"',role:'teacher',status:'active'}); invalidateTableCache_('Teachers')");
r = as('U1','createAccount',{lineUserId:MAINT, email:'', teacherName:'x', tenantId:tid});
assert(!r.ok && /มีบัญชีอยู่แล้ว/.test(r.message), 'cannot move a MAIN teacher into another account');
r = as('U1','removeAccountMember',{tenantId:tid, lineUserId:T2});
assert(r.ok && as(T2,'bootstrap').registered===false, 'admin removes user → loses access');
r = as('U1','setAccountStatus',{tenantId:tid, status:'disabled'});
assert(r.ok && as(NEWU,'bootstrap').registered===false, 'disabled account cannot sign in');
r = as('U1','setAccountStatus',{tenantId:tid, status:'active'});
assert(as(NEWU,'bootstrap').registered===true, 're-enabled account works again');
r = as(NEWU,'qrPdf',{classFilter:'ป.1/1', size:38});
assert(r.ok && r.count===1 && /drive\.google\.com\/file\/d\//.test(r.url) && r.sentToLine, 'QR PDF created + link pushed to LINE');
replies.length=0;
R(`doPost({postData:{contents:${JSON.stringify(JSON.stringify({events:[{type:'message',replyToken:'rt9',source:{userId:NEWU},message:{type:'text',text:'สรุป'}}]}))}}})`);
assert(replies[0] && replies[0].messages[0].text.includes('แบบฝึก 1') && !replies[0].messages[0].text.includes('ใบงานที่ 2'), 'webhook summary uses own account');
replies.length=0;
R(`doPost({postData:{contents:${JSON.stringify(JSON.stringify({events:[{type:'message',replyToken:'rt8',source:{userId:OUT},message:{type:'text',text:'myid'}}]}))}}})`);
assert(replies[0].messages[0].text===OUT && replies[0].messages.length===3, 'myid: LINE ID alone (easy copy) + instructions + request button');
R("useTenant_(null)");
assert(R("getSetting_('SCHOOL_NAME')")==='โรงเรียนอนุบาลศรีสุทโธ', 'MAIN settings untouched');

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
assert(rep.length===R("readTable_('Students').filter(isStudentActive_).length"), 'student report rows');
const soon = new Date(Date.now()+2*3600e3); const p2=n=>String(n).padStart(2,'0');
const soonStr = `${soon.getFullYear()}-${p2(soon.getMonth()+1)}-${p2(soon.getDate())}T${p2(soon.getHours())}:${p2(soon.getMinutes())}`;
R(`adminSave('Assignments',{assignment_id:'HW099',subject:'ไทย',assignment_name:'เรียงความ',class_target:'ALL',due_date:'${soonStr}',status:'open'},true)`);
const a3 = R("getAssignment_('HW099')");
assert(a3 && a3.status==='OPEN' && typeof a3.due_date.getTime==='function', 'admin create assignment w/ datetime');
ctx.__email='stranger@x.com';
let denied=false; try{ R("adminDashboard('')"); }catch(e){denied=true;} assert(denied,'non-teacher denied');
// reminders
pushed.length=0; R('sendDueReminders()');
assert(pushed.length===1 && pushed[0].to.includes('U1') && pushed[0].messages[0].text.includes('ยังไม่ส่ง'), 'due reminder → teachers with missing list');
R("PropertiesService.getScriptProperties().setProperty('MIGRATION_VERSION','0')"); R("setSettingValue_('SCHOOL_NAME','โรงเรียนตัวอย่าง')"); R('runMigrations_()');
assert(R("getSetting_('SCHOOL_NAME')")==='โรงเรียนอนุบาลศรีสุทโธ', 'migration sets school name');
console.log(R("fmtDateTimeTH_(new Date())"), R("parseStudentCode_('STU-2026-00125')"));
