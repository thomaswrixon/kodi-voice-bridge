const { KODI_SYSTEM_PROMPT } = require('../kodi-prompt');
const { PERSONAL_CALL_OVERRIDES } = require('../personal-call-overrides');
const { PERSONAL_CALL_HARD_STOPS } = require('../personal-call-hard-stops');
const { CONVERSATION_STYLE_OVERRIDES } = require('../conversation-style-overrides');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.SIM_MODEL || 'gpt-4o-mini';
if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY required');
const SYSTEM = KODI_SYSTEM_PROMPT + PERSONAL_CALL_OVERRIDES + PERSONAL_CALL_HARD_STOPS + CONVERSATION_STYLE_OVERRIDES;

async function ask(prompt) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method:'POST',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+OPENAI_API_KEY},
    body:JSON.stringify({model:MODEL,temperature:0,max_tokens:90,messages:[{role:'system',content:SYSTEM},{role:'user',content:prompt}]})
  });
  const b=await r.json();
  if(!r.ok) throw new Error('OpenAI '+r.status+' '+JSON.stringify(b).slice(0,300));
  return String(b.choices?.[0]?.message?.content||'');
}

const cases = [
  {
    label:'Owner gets direct Kodi greeting',
    prompt:'The call just connected. known_contact_context={"name":"Tommy","is_friends_family":true,"relationship":"Owner","contact_conflict":false,"is_owner":true}. There is no recent_call_history. Start your greeting now.',
    check:(s)=>/Tommy/i.test(s)&&/Kodi/i.test(s)&&!/Local Concreting Mate/i.test(s)&&!/away from his phone|cannot answer|not near his phone/i.test(s)&&!/who is calling/i.test(s),
  },
  {
    label:'Family still gets personal greeting',
    prompt:'The call just connected. known_contact_context={"name":"Lilly Wrixon","is_friends_family":true,"relationship":"Family","contact_conflict":false,"is_owner":false}. Start your greeting now.',
    check:(s)=>/Lilly/i.test(s)&&/Kodi/i.test(s)&&!/Local Concreting Mate/i.test(s)&&!/who is calling/i.test(s),
  },
  {
    label:'Unknown caller still gets business greeting',
    prompt:'The call just connected. There is no saved Kodi contact match for this caller ID. Start your greeting now.',
    check:(s)=>/Local Concreting Mate/i.test(s)&&/Kodi/i.test(s),
  },
];

(async()=>{
  console.log('OWNER_GREETING_START '+JSON.stringify({count:cases.length,model:MODEL}));
  let passed=0;
  for(const c of cases){
    try{
      const response=await ask(c.prompt);
      const pass=!!c.check(response);
      if(pass)passed++;
      console.log('OWNER_GREETING_RESULT '+JSON.stringify({label:c.label,response,pass}));
    }catch(e){console.log('OWNER_GREETING_RESULT '+JSON.stringify({label:c.label,error:e.message,pass:false}));}
    await new Promise(r=>setTimeout(r,1000));
  }
  console.log('OWNER_GREETING_SUMMARY '+JSON.stringify({completed:cases.length,passed,failed:cases.length-passed}));
  if(passed!==cases.length)process.exitCode=1;
})();
