const { KODI_SYSTEM_PROMPT } = require('../kodi-prompt');
const { PERSONAL_CALL_OVERRIDES } = require('../personal-call-overrides');
const { PERSONAL_CALL_HARD_STOPS } = require('../personal-call-hard-stops');
const { CONVERSATION_STYLE_OVERRIDES } = require('../conversation-style-overrides');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.SIM_MODEL || 'gpt-4o-mini';
if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY required');
const SYSTEM = KODI_SYSTEM_PROMPT + PERSONAL_CALL_OVERRIDES + PERSONAL_CALL_HARD_STOPS + CONVERSATION_STYLE_OVERRIDES;

async function ask(text) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OPENAI_API_KEY },
    body: JSON.stringify({ model: MODEL, temperature: 0.4, max_tokens: 100, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: text }] }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error('OpenAI ' + r.status + ' ' + JSON.stringify(body).slice(0, 300));
  return String(body.choices?.[0]?.message?.content || '');
}

const cases = [
  {
    id: 1, label: 'Family greeting Lilly',
    prompt: 'The call just connected. known_contact_context={"name":"Lilly","is_friends_family":true,"relationship":"Family","contact_conflict":false}. current_sydney_date=Friday, 14 August 2026. Start your greeting now.',
    check: (s) => /Lilly/i.test(s) && /Kodi/i.test(s) && !/Local Concreting Mate/i.test(s) && !/who is calling/i.test(s),
  },
  {
    id: 2, label: 'Family greeting Ben',
    prompt: 'The call just connected. known_contact_context={"name":"Ben Smith","is_friends_family":true,"relationship":"Friend","contact_conflict":false}. current_sydney_date=Friday, 14 August 2026. Start your greeting now.',
    check: (s) => /Ben/i.test(s) && /Kodi/i.test(s) && !/Local Concreting Mate/i.test(s) && !/who is calling/i.test(s),
  },
  {
    id: 3, label: 'Conflicted contact gets business greeting',
    prompt: 'The call just connected. known_contact_context={"name":"Alex","is_friends_family":false,"relationship":"","contact_conflict":true}. current_sydney_date=Friday, 14 August 2026. Start your greeting now.',
    check: (s) => /Local Concreting Mate/i.test(s) && /Kodi/i.test(s),
  },
  {
    id: 4, label: 'Today date style',
    prompt: 'current_sydney_date=Friday, 14 August 2026. The confirmed Pour Concrete calendar_date is 2026-08-14. The caller asks when the pour is. Answer naturally as Kodi in one sentence.',
    check: (s) => /today/i.test(s) && !/2026/i.test(s),
  },
  {
    id: 5, label: 'Tomorrow date style',
    prompt: 'current_sydney_date=Friday, 14 August 2026. The confirmed Sand Up calendar_date is 2026-08-15. The caller asks when Sand Up is. Answer naturally as Kodi in one sentence.',
    check: (s) => /tomorrow/i.test(s) && !/2026/i.test(s),
  },
  {
    id: 6, label: 'This weekday date style',
    prompt: 'current_sydney_date=Monday, 24 August 2026. The confirmed Pour Concrete calendar_date is 2026-08-28. The caller asks when the pour is. Answer naturally as Kodi in one sentence.',
    check: (s) => /this Friday/i.test(s) && /28th of August/i.test(s) && !/2026/i.test(s),
  },
  {
    id: 7, label: 'Next weekday date style',
    prompt: 'current_sydney_date=Friday, 14 August 2026. The confirmed Pour Concrete calendar_date is 2026-08-21. The caller asks when the pour is. Answer naturally as Kodi in one sentence.',
    check: (s) => /next Friday/i.test(s) && /21st of August/i.test(s) && !/2026/i.test(s),
  },
  {
    id: 8, label: 'Later same-year date omits year',
    prompt: 'current_sydney_date=Friday, 14 August 2026. The confirmed Formwork calendar_date is 2026-08-28. The caller asks when Formwork is. Answer naturally as Kodi in one sentence.',
    check: (s) => /Friday/i.test(s) && /28th of August/i.test(s) && !/2026/i.test(s),
  },
];

(async () => {
  console.log('STYLE8_START ' + JSON.stringify({ count: cases.length, model: MODEL }));
  let passed = 0;
  for (const c of cases) {
    try {
      const response = await ask(c.prompt);
      const pass = !!c.check(response);
      if (pass) passed++;
      console.log('STYLE8_RESULT ' + JSON.stringify({ id: c.id, label: c.label, response, pass }));
    } catch (e) {
      console.log('STYLE8_RESULT ' + JSON.stringify({ id: c.id, label: c.label, error: e.message, pass: false }));
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  console.log('STYLE8_SUMMARY ' + JSON.stringify({ completed: cases.length, passed, failed: cases.length - passed }));
  if (passed !== cases.length) process.exitCode = 1;
})();
