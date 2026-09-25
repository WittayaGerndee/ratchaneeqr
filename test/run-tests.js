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
  CacheService:{ getScriptCache:()=>({ get:()=>null, put(){} }) },
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
R("setSettingValue_('REQUIRE_ID_TOKEN','FALSE')");
const post = body => JSON.parse(R(`doPost({postData:{contents:${JSON.stringify(JSON.stringify(body))}}})`).text);
const init = post({action:'init', userId:'U1', displayName:'สมชาย'});
assert(init.ok && init.assignments.length===2, 'init returns 2 open assignments');
let r = post({action:'student', code:'STU-65001', assignmentId:'TASK-HW001', userId:'U1'});
assert(r.ok && r.student.name==='นายสมชาย ใจดี' && r.isTarget, 'lookup student by STU- QR');
r = post({action:'submit', studentId:'STU-65001', assignmentId:'HW001', userId:'U1', displayName:'สมชาย'});
assert(r.ok && r.code==='SUBMITTED', 'first submit ok '+r.dateText+' '+r.timeText);
assert(pushed.length===1, 'LINE push notify on submit');
r = post({action:'submit', studentId:'65001', assignmentId:'HW001', userId:'U1'});
assert(!r.ok && r.code==='DUPLICATE' && r.canResubmit===false, 'duplicate blocked: '+r.submittedText);
r = post({action:'submit', studentId:'65001', assignmentId:'HW001', userId:'U1', resubmit:true});
assert(!r.ok && r.code==='RESUBMIT_NOT_ALLOWED', 'resubmit denied when not allowed');
r = post({action:'submit', studentId:'65004', assignmentId:'HW002', userId:'U1'});
assert(!r.ok && r.code==='NOT_TARGET', 'class target enforced (ม.5/2 vs ม.5/1)');
r = post({action:'submit', studentId:'65002', assignmentId:'https://liff.line.me/x?task=HW002', userId:'U1'});
assert(!r.ok && r.code==='FILE_REQUIRED', 'file required enforced');
r = post({action:'submit', studentId:'65002', assignmentId:'HW002', userId:'U1', file:{name:'a.pdf',mimeType:'application/pdf',data:Buffer.from('hi').toString('base64')}});
assert(r.ok && r.fileUrl.includes('65002_สมใจ_ใบงานที่2.pdf'), 'file saved: '+files[0]);
r = post({action:'submit', studentId:'65002', assignmentId:'HW002', userId:'U1', resubmit:true, file:{name:'b.pdf',data:'aGk='}});
assert(r.ok && r.code==='RESUBMITTED' && r.attempt===2, 'resubmit allowed → attempt 2');
assert(sheets.Submissions.data.length===3, 'Submissions has 2 rows (+header), no dup rows');
r = post({action:'link', code:'STU-65003', userId:'U3'});
assert(r.ok, 'link ok');
r = post({action:'link', code:'STU-65003', userId:'U9'});
assert(!r.ok && r.code==='STUDENT_LINKED', 'link to other account blocked');
r = post({action:'myStatus', userId:'U3'});
assert(r.ok && r.items.length===2 && r.items.every(i=>i.submission_status==='ยังไม่ส่ง'), 'myStatus lists pending');
// webhook
R(`doPost({postData:{contents:${JSON.stringify(JSON.stringify({events:[{type:'message',replyToken:'rt',source:{userId:'U3'},message:{type:'text',text:'งานของฉัน'}}]}))}}})`);
assert(replies.length===1 && replies[0].messages[0].text.includes('ค้างส่ง 2'), 'webhook งานของฉัน reply');
// admin
ctx.__email='owner@x.com';
const d = R("adminDashboard('HW001')");
assert(d.selected.target===6 && d.selected.submitted===1 && d.selected.rooms.length===3, 'dashboard HW001: 1/6 across 3 rooms, rate '+d.selected.rate);
const miss = R("adminMissing('HW001','ม.5/1')");
assert(miss.students.length===2, 'missing in ม.5/1 = 2');
R("adminUpdateSubmission(adminList('Submissions')[0].submission_id,{status:'ผ่าน',score:'10',notify:true})");
assert(sheets.Submissions.data[1][9]==='ผ่าน', 'teacher sets status ผ่าน');
const imp = R("adminImportStudents('65010\\tนายใหม่ มาแล้ว\\tม.6\\t1\\n65001\\tนายสมชาย ใจดีมาก\\tม.5\\t1')");
assert(imp.added===1 && imp.updated===1, 'import students upsert');
const rep = R("adminStudentReport('')");
assert(rep.length===7, 'student report rows');
R("adminSave('Assignments',{assignment_id:'HW003',subject:'ไทย',assignment_name:'เรียงความ',class_target:'ALL',due_date:'2026-09-25T20:00',status:'open'},true)");
const a3 = R("getAssignment_('HW003')");
assert(a3 && a3.status==='OPEN' && typeof a3.due_date.getTime==='function', 'admin create assignment w/ datetime');
ctx.__email='stranger@x.com';
let denied=false; try{ R("adminDashboard('')"); }catch(e){denied=true;} assert(denied,'non-teacher denied');
// reminders
pushed.length=0; R('sendDueReminders()');
console.log('   reminder pushes:', pushed.length);
console.log(R("fmtDateTimeTH_(new Date())"), R("parseStudentCode_('STU-2026-00125')"));
