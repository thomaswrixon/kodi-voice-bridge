const { KODI_SYSTEM_PROMPT } = require("../kodi-prompt");
const { QUOTE_FLOW_OVERRIDES } = require("../quote-flow-overrides");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.SIM_MODEL || "gpt-4o-mini";
if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");

const CALLER_ID = "0428049389";

const scenarios = [
  {
    id: 1,
    kind: "standard",
    intro: "Hi, Steve here. I am after a quote for a new driveway.",
    answers: {
      location: "It is at 12 Example Street, Cessnock.",
      size: "About 90 square metres.",
      finish: "Exposed aggregate.",
      existing: "It is gravel at the moment, with no existing concrete to remove.",
      access: "Access is easy, straight off the street.",
      timeframe: "Around October if possible.",
    }
  },
  {
    id: 2,
    kind: "crack_repair",
    intro: "Hi, Sarah here. I would like a quote to repair cracks in my driveway.",
    answers: {
      location: "The property is in Maitland.",
      extent: "There are four or five cracks across the driveway.",
      crack_size: "Most are fine, but one is about five millimetres wide.",
      movement: "No, neither side is sitting higher than the other.",
      other_issue: "No other issue that I have noticed.",
      photos: "Yes, I have photos available.",
      timeframe: "Sometime in the next month would be ideal.",
    }
  },
  {
    id: 3,
    kind: "new_build",
    intro: "Hi, Daniel here from ABC Homes. I need a quote for a new house slab.",
    answers: {
      location: "The site is 22 Example Avenue, Thornton.",
      builder: "ABC Homes.",
      work: "It is a house slab.",
      plans: "Yes, I have the plans and engineering ready.",
      size: "Roughly 220 square metres.",
      timeframe: "We are hoping for November.",
    }
  },
  {
    id: 4,
    kind: "variation",
    intro: "Hi, Michael here. You are already doing our job and I want a quote for another 30 square metres of concrete out the back.",
    answers: {
      location: "It is the existing job at 17 Cullen Street, Belmont North.",
      work: "It is an extra patio area out the back.",
      size: "About 30 square metres.",
      finish: "Plain concrete is fine.",
      timeframe: "Ideally while the main job is underway, but I understand that is only a preference.",
    }
  },
  {
    id: 5,
    kind: "repeat",
    recent: [{
      call_log_id: "call123",
      called_at: "2026-08-10T02:00:00.000Z",
      caller_name: "Steve",
      summary: "Quote request - crack repair - driveway in Maitland; four or five cracks; one about 5mm wide; no movement; photos available."
    }],
    intro: "Hi, Steve here. I am following up on the quote I called about earlier this week.",
    answers: {}
  }
];

async function chat(messages) {
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + OPENAI_API_KEY },
        body: JSON.stringify({ model: MODEL, temperature: 0.1, messages })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(response.status + " " + JSON.stringify(body).slice(0, 400));
      return body.choices[0].message.content || "";
    } catch (error) {
      last = error;
      await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    }
  }
  throw last;
}

function callerReply(scenario, assistantText, state) {
  const t = String(assistantText || "").toLowerCase();

  if (scenario.kind === "repeat") {
    if (!state.confirmedSame && /(same|following up|earlier|previous|crack repair)/.test(t)) {
      state.confirmedSame = true;
      return "Yes, it is the same crack repair quote.";
    }
    if (state.confirmedSame && !state.changedAnswered && /(changed|anything different|anything new)/.test(t)) {
      state.changedAnswered = true;
      return "No, nothing has changed since I called.";
    }
    if (/(0\s*[, ]\s*4|callback number|is that correct)/.test(t)) return "Yes, that number is correct.";
    return "No, nothing else has changed.";
  }

  const a = scenario.answers;
  const rules = [
    ["location", /(suburb|address|property|site address|where is|where's)/],
    ["builder", /(builder|company)/],
    ["plans", /(plans|engineering|engineer)/],
    ["extent", /(how many|one or two|several|extent|across|larger area|where.*crack|where.*damage)/],
    ["crack_size", /(hairline|wide|width|millimet|open crack|small crack)/],
    ["movement", /(higher|movement|moved|lifted|one side)/],
    ["other_issue", /(crumbling|water|trip|steel|sinking|other issue|anything else.*damage)/],
    ["photos", /(photo|picture)/],
    ["size", /(square metre|size|big|area|dimensions|length|width|scope)/],
    ["finish", /(finish|plain|colou|exposed|stencil)/],
    ["existing", /(currently|existing|remove|removal|gravel|dirt|grass|what is there|what's there)/],
    ["access", /(access|steep|tight|pump|unusual)/],
    ["timeframe", /(timeframe|when.*hop|timing|when.*done|when.*start|particular time|next month)/],
    ["work", /(what.*work|type of work|what are you looking|what is it|extra|additional)/],
  ];

  for (const [key, re] of rules) {
    if (a[key] && !state.used[key] && re.test(t)) {
      state.used[key] = true;
      return a[key];
    }
  }

  if (/(0\s*[, ]\s*4|callback number|is that correct)/.test(t)) return "Yes, that number is correct.";
  if (/(anything else|is that all|does that sound right|have i got that right|is that correct)/.test(t)) return "Yes, that is all correct.";

  for (const key of Object.keys(a)) {
    if (!state.used[key]) {
      state.used[key] = true;
      return a[key];
    }
  }
  return "Yes, that is correct.";
}

function noPrice(text) {
  return !/(\$\s*\d|\b\d+\s*dollars?\b|per square metre|per m2|around \$|roughly \$)/i.test(text);
}

function judge(scenario, transcript, state) {
  const assistantTurns = transcript.filter(x => x.role === "assistant").map(x => x.content);
  const assistant = assistantTurns.join(" ");
  const common = noPrice(assistant) && !/(we can fit you in|we can start|book you in|definitely repair|definitely fix)/i.test(assistant);
  const noRedundantHelpQuestion = !assistantTurns.slice(1, 3).some(t => /what can i help you with today/i.test(t));

  if (scenario.kind === "standard") {
    const fields = ["location", "size", "finish", "existing", "timeframe"];
    const collected = fields.every(k => state.used[k]);
    const noScheduleLookupLanguage = !/(check the live lcm schedule|look up the job schedule)/i.test(assistant);
    return { pass: common && collected && noScheduleLookupLanguage && noRedundantHelpQuestion, checks: { common, collected, noScheduleLookupLanguage, noRedundantHelpQuestion, used: state.used } };
  }

  if (scenario.kind === "crack_repair") {
    const fields = ["location", "extent", "crack_size", "movement", "photos"];
    const collected = fields.every(k => state.used[k]);
    const noDiagnosis = !/(structural|epoxy|polyurethane|definitely repair|definitely fix|cause is)/i.test(assistant);
    return { pass: common && collected && noDiagnosis && noRedundantHelpQuestion, checks: { common, collected, noDiagnosis, noRedundantHelpQuestion, used: state.used } };
  }

  if (scenario.kind === "new_build") {
    const fields = ["location", "plans", "size", "timeframe"];
    const collected = fields.every(k => state.used[k]);
    const noResidentialDrift = !/(preferred finish|what.*finish|currently on the site.*remove|needs? removal|access issues|unusual site conditions)/i.test(assistant);
    return { pass: common && collected && noResidentialDrift && noRedundantHelpQuestion, checks: { common, collected, noResidentialDrift, noRedundantHelpQuestion, used: state.used } };
  }

  if (scenario.kind === "variation") {
    const collected = state.used.location && state.used.size && (state.used.work || /extra|additional|variation|patio/i.test(assistant));
    const noFalseRepeat = !/(following up on the same enquiry|same enquiry.*new request)/i.test(assistant);
    return { pass: common && collected && noFalseRepeat && noRedundantHelpQuestion, checks: { common, collected, noFalseRepeat, noRedundantHelpQuestion, used: state.used } };
  }

  if (scenario.kind === "repeat") {
    const confirmsSame = state.confirmedSame;
    const asksChanged = state.changedAnswered;
    const sameIndex = transcript.findIndex(x => x.role === "user" && /same crack repair/i.test(x.content));
    const afterSame = transcript.slice(sameIndex + 1).filter(x => x.role === "assistant").map(x => x.content).join(" ").toLowerCase();
    const didNotRepeat = !/(how wide|hairline|one side|photos|how many cracks|what suburb|what address)/i.test(afterSame);
    const changedBeforeCallback = sameIndex >= 0 && transcript.slice(sameIndex + 1).some((x, i, arr) => {
      if (x.role !== "assistant" || !/has anything changed since you last called/i.test(x.content)) return false;
      const callbackIndex = arr.findIndex(y => y.role === "assistant" && /(callback number|0\s*[, ]\s*4)/i.test(y.content));
      return callbackIndex < 0 || i < callbackIndex;
    });
    return { pass: common && confirmsSame && asksChanged && didNotRepeat && changedBeforeCallback, checks: { common, confirmsSame, asksChanged, didNotRepeat, changedBeforeCallback } };
  }

  return { pass: false, checks: {} };
}

async function runScenario(scenario) {
  const recentInstruction = scenario.recent
    ? "\nRecent_call_history for this caller ID from the last 14 days is: " + JSON.stringify(scenario.recent) + "."
    : "\nThere is no recent_call_history for this caller ID in the last 14 days.";

  const messages = [
    { role: "system", content: KODI_SYSTEM_PROMPT + QUOTE_FLOW_OVERRIDES + "\nTEXT SIMULATION RULE: Do not call save_caller_info or hang_up and do not write data. Continue the natural quote intake conversation instead." + recentInstruction + "\nThe inbound caller ID is " + CALLER_ID + "." },
    { role: "user", content: "The call just connected. Start with the mandatory greeting." }
  ];
  const transcript = [];
  const greeting = await chat(messages);
  messages.push({ role: "assistant", content: greeting });
  transcript.push({ role: "assistant", content: greeting });
  messages.push({ role: "user", content: scenario.intro });
  transcript.push({ role: "user", content: scenario.intro });

  const state = { used: {}, confirmedSame: false, changedAnswered: false };
  for (let turn = 0; turn < 14; turn++) {
    const reply = await chat(messages);
    messages.push({ role: "assistant", content: reply });
    transcript.push({ role: "assistant", content: reply });

    if (scenario.kind === "repeat" && state.changedAnswered && /(callback|0\s*[, ]\s*4|anything else|pass.*tommy|follow-up|save your information)/i.test(reply)) break;
    const expectedKeys = Object.keys(scenario.answers || {});
    const allUsed = expectedKeys.length && expectedKeys.every(k => state.used[k]);
    if (allUsed && /(callback|0\s*[, ]\s*4|anything else|summary|pass.*tommy|have i got|is that correct)/i.test(reply)) break;

    const user = callerReply(scenario, reply, state);
    messages.push({ role: "user", content: user });
    transcript.push({ role: "user", content: user });
  }

  return { transcript, state, judgment: judge(scenario, transcript, state) };
}

async function main() {
  console.log("QUOTE_INTAKE_START " + JSON.stringify({ count: scenarios.length, model: MODEL, timestamp: new Date().toISOString() }));
  const results = [];
  for (const scenario of scenarios) {
    try {
      const run = await runScenario(scenario);
      results.push({ scenario: { id: scenario.id, kind: scenario.kind }, ...run });
      console.log("QUOTE_INTAKE_RESULT " + JSON.stringify(results[results.length - 1]));
    } catch (error) {
      const row = { scenario: { id: scenario.id, kind: scenario.kind }, judgment: { pass: false, error: error.message } };
      results.push(row);
      console.log("QUOTE_INTAKE_RESULT " + JSON.stringify(row));
    }
  }
  console.log("QUOTE_INTAKE_SUMMARY " + JSON.stringify({
    completed: results.length,
    passed: results.filter(r => r.judgment && r.judgment.pass).length,
    failed: results.filter(r => !r.judgment || !r.judgment.pass).length,
    timestamp: new Date().toISOString()
  }));
}

main().catch(error => { console.error("QUOTE_INTAKE_FATAL " + error.stack); process.exit(1); });
