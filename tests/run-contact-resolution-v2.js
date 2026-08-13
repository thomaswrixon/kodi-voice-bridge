const { resolveCallerContactMatch } = require('../contact-match-policy');

const cases = [
  {
    label: 'Heart-labelled contact survives stale blank ordinary duplicate',
    rows: [
      { id:'1', name:'Lilly Wrixon', phone:'0493 285 098', is_friends_family:true, relationship:'Family' },
      { id:'2', name:null, phone:'0493 285 098', is_friends_family:false },
    ],
    check: (r) => r && r.is_friends_family === true && r.contact_conflict === false && /Lilly/i.test(r.name || ''),
  },
  {
    label: 'Same person mixed old flags remains trusted',
    rows: [
      { id:'1', name:'Bek Wrixon', is_friends_family:true, relationship:'Family' },
      { id:'2', name:'Bek Wrixon', is_friends_family:false },
      { id:'3', name:null, is_friends_family:false },
    ],
    check: (r) => r && r.is_friends_family === true && r.contact_conflict === false,
  },
  {
    label: 'Name decoration does not create false identity conflict',
    rows: [
      { id:'1', name:'Ryllie Hitchcock', is_friends_family:true, relationship:'Friend' },
      { id:'2', name:'Ryllie ❣️', is_friends_family:true, relationship:'Friend' },
      { id:'3', name:null, is_friends_family:false },
    ],
    check: (r) => r && r.is_friends_family === true && r.contact_conflict === false,
  },
  {
    label: 'Different named owners on same number fail closed',
    rows: [
      { id:'1', name:'Jake Smith', is_friends_family:true, relationship:'Friend' },
      { id:'2', name:'New Owner', is_friends_family:false },
    ],
    check: (r) => r && r.is_friends_family === false && r.contact_conflict === true,
  },
  {
    label: 'Ordinary consistent contact remains ordinary',
    rows: [
      { id:'1', name:'Supplier Dave', is_friends_family:false },
      { id:'2', name:null, is_friends_family:false },
    ],
    check: (r) => r && r.is_friends_family === false && r.contact_conflict === false,
  },
];

let passed = 0;
console.log('CONTACT_RESOLUTION_V2_START ' + JSON.stringify({ count: cases.length }));
for (const c of cases) {
  const result = resolveCallerContactMatch(c.rows);
  const pass = !!c.check(result);
  if (pass) passed++;
  console.log('CONTACT_RESOLUTION_V2_RESULT ' + JSON.stringify({ label:c.label, result, pass }));
}
console.log('CONTACT_RESOLUTION_V2_SUMMARY ' + JSON.stringify({ completed:cases.length, passed, failed:cases.length-passed }));
if (passed !== cases.length) process.exitCode = 1;
