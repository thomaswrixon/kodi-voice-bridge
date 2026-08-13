const { KODI_SYSTEM_PROMPT } = require("../kodi-prompt");
const { QUOTE_FLOW_OVERRIDES } = require("../quote-flow-overrides");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.SIM_MODEL || "gpt-4o-mini";
const CALLER_ID = "0428049389";
if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");

const scenarios = [
  {
    id: 1,
    kind: "standard",
    label: "new driveway",
    intro: "Hi, Steve here. I am after a quote for a new driveway.",
    answers: {
      location: "It is at 12 Example Street, Cessnock.",
      size: "About 90 square metres.",
      finish: "Exposed aggregate.",
      existing: "It is gravel at the moment, with no concrete to remove.",
      access: "Access is easy, straight off the street.",
      timeframe: "Around October if possible."
    },
    required: ["location", "size", "finish", "existing", "timeframe"]
  },
  {
    id: 2,
    kind: "repair",
    label: "driveway crack repair",
    intro: "Hi, Sarah here. I would like a quote to repair cracks in my driveway.",
    answers: {
      location: "The driveway is in Belmont North.",
      extent: "There are four or five cracks across the driveway.",
      crack_size: "Most are fine, but one is about five millimetres wide.",
      movement: "No, neither side is sitting higher than the other.",
      other_issue: "No other issue that I have noticed.",
      photos: "Yes, I have photos available.",
      timeframe: "Sometime in the next month would be ideal."
    },
    required: ["location", "extent", "crack_size", "movement", "photos"]
  },
  {
    id: 3,
    kind: "new_build",
    label: "builder house slab",
    intro: "Hi, Daniel here from ABC Homes. I need a quote for a new house slab.",
    answers: {
      location: "The site is 22 Example Avenue, Thornton.",
      builder: "ABC Homes.",
      work: "It is a house slab.",
      plans: "Yes, I have the plans and engineering ready.",
      size: "Roughly 220 square metres.",
      timeframe: "We are hoping for November."
    },
    required: ["location", "plans", "size", "timeframe"]
  },
  {
    id: 4,
    kind: "variation",
    label: "existing-job patio variation",
    intro: "Hi, Michael here. You are already doing our job and I want a quote for another 30 square metres of concrete out the back.",
    answers: {
      location: "It is the existing job at 17 Cullen Street, Belmont North.",
      work: "It is an extra patio area out the back.",
      size: "About 30 square metres.",
      finish: "Plain concrete is fine.",
      timeframe: "Ideally while the main job is underway, but I understand that is only a preference."
    },
    required: ["location", "work", "size", "finish", "timeframe"]
  },
  {
    id: 5,
    kind: "repeat_no_change",
    label: "repeat crack repair Belmont North",
    recent: [{
      call_log_id: "call-belmont-cracks",
      called_at: "2026-08-10T02:00:00.000Z",
      caller_name: "Paul",
      summary: "Quote request - driveway crack repair in Belmont North; four or five cracks; one about 5mm wide; no movement; photos available."
    }],
    intro: "Hi, Paul here. I am following up on the repair quote I called about earlier this week."
  },
  {
    id: 6,
    kind: "repeat_changed",
    label: "repeat driveway Cessnock with changed finish",
    recent: [{
      call_log_id: "call-cessnock-driveway",
      called_at: "2026-08-09T03:00:00.000Z",
      caller_name: "Lisa",
      summary: "Quote request - driveway in Cessnock; approximately 75 square metres; plain concrete; gravel base; easy access."
    }],
    intro: "Hi, Lisa here. I am following up on the driveway quote from last week.",
    changedReply: "Yes. We want exposed aggregate now instead of plain concrete."
  },
  {
    id: 7,
    kind: "standard_unknown_size",
    label: "pool surround unknown size",
    intro: "Hi, Rachel here. I am looking for a quote for a concrete pool surround.",
    answers: {
      location: "The property is in Merewether.",
      size: "I honestly do not know the square metres yet.",
      finish: "A light broom finish would be fine.",
      existing: "It is mostly bare ground around the pool at the moment.",
      timeframe: "There is no rush, sometime before summer would be nice."
    },
    required: ["location", "size", "finish", "timeframe"]
  },
  {
    id: 8,
    kind: "repair",
    label: "garage slab crumbling repair",
    intro: "Hi, Andrew here. I want a quote to repair a section of concrete that is crumbling on my garage slab.",
    answers: {
      location: "The property is in Charlestown.",
      extent: "It is one area near the front corner of the garage slab.",
      crack_size: "There is a small open crack beside the crumbling section.",
      movement: "No, I cannot see any height difference or lifting.",
      other_issue: "There is a little bit of exposed steel in the damaged area.",
      photos: "Yes, I can provide photos.",
      timeframe: "Within the next few weeks would be good."
    },
    required: ["location", "extent", "movement", "other_issue", "photos"]
  },
  {
    id: 9,
    kind: "existing_new_request",
    label: "past customer new path quote",
    intro: "Hi, Karen here. You did my driveway last year, but I am calling about a new concrete path I want quoted.",
    answers: {
      location: "The new path is at my place in Warners Bay.",
      work: "It is a side path from the front gate to the backyard.",
      size: "Roughly 25 square metres.",
      finish: "Plain broom finish.",
      existing: "It is grass there now.",
      timeframe: "No fixed date, just when you can quote it."
    },
    required: ["location", "size", "finish", "timeframe"]
  },
  {
    id: 10,
    kind: "multiple_recent",
    label: "two prior quotes require disambiguation",
    recent: [
      {
        call_log_id: "call-a",
        called_at: "2026-08-10T01:00:00.000Z",
        caller_name: "Tom",
        summary: "Quote request - driveway crack repair in Belmont North; photos available."
      },
      {
        call_log_id: "call-b",
        called_at: "2026-08-08T01:00:00.000Z",
        caller_name: "Tom",
        summary: "Quote request - new driveway in Cessnock; exposed aggregate; approximately 80 square metres."
      }
    ],
    intro: "Hi, Tom here. I am following up on one of the quotes I called about recently."
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
      if (!response.ok) throw new Error(response.status + " " + JSON.stringify(body).slice(0, 500));
      return body.choices[0].message.content || "";
    } catch (error) {
      last = error;
      await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    }
  }
  throw last;
}

function isCallbackQuestion(text) {
  const t = String(text || "").toLowerCase();
  return /callback number/.test(t) || /0\s*,\s*4\s*,\s*2\s*,\s*8/.test(t);
}

function hasDigitByDigitCallback(text) {
  const t = String(text || "");
  const full = /0\s*,\s*4\s*,\s*2\s*,\s*8\s*,\s*0\s*,\s*4\s*,\s*9\s*,\s*3\s*,\s*8\s*,\s*9/.test(t);
  const noGrouped = !/0428\s*049\s*389/.test(t) && !/\+61/.test(t);
  return full && noGrouped;
}

function callerReply(s, assistantText, state) {
  const t = String(assistantText || "").toLowerCase();

  if (s.kind === "multiple_recent") {
    if (!state.disambiguated) {
      const presentsChoice = /(which|which one|belmont north.*cessnock|cessnock.*belmont north|driveway.*crack|crack.*driveway)/i.test(assistantText);
      if (presentsChoice) {
        state.disambiguated = true;
        return "I mean the new driveway quote in Cessnock.";
      }
      if (/(same|following up)/.test(t) && (t.includes("belmont north") || t.includes("cessnock"))) {
        state.guessedPrior = true;
        return "I mean the new driveway quote in Cessnock.";
      }
      return "It was one of two quotes I asked about recently.";
    }
    if (!state.confirmedSame && /(same|cessnock|driveway)/.test(t)) {
      state.confirmedSame = true;
      return "Yes, that is the Cessnock driveway quote.";
    }
    if (state.confirmedSame && !state.changedAnswered && /has anything changed since you last called/.test(t)) {
      state.changedAnswered = true;
      return "No, nothing has changed.";
    }
  }

  if (s.kind === "repeat_no_change" || s.kind === "repeat_changed") {
    if (!state.confirmedSame && /(same|following up|earlier|previous|quote)/.test(t)) {
      state.confirmedSame = true;
      state.repeatQuestion = assistantText;
      return s.kind === "repeat_no_change"
        ? "Yes, it is the same driveway crack repair job in Belmont North."
        : "Yes, it is the same driveway quote in Cessnock.";
    }
    if (state.confirmedSame && !state.changedAnswered && /has anything changed since you last called/.test(t)) {
      state.changedAnswered = true;
      return s.kind === "repeat_changed" ? s.changedReply : "No, nothing has changed since I called.";
    }
  }

  if (isCallbackQuestion(assistantText)) {
    state.callbackAsked = true;
    state.callbackText = assistantText;
    state.callbackConfirmed = true;
    return "Yes, that number is correct.";
  }

  if (s.answers) {
    const a = s.answers;
    const rules = [
      ["location", /(suburb|address|property|site address|where.*work|where.*property|where.*located|location)/],
      ["builder", /(builder|client|company)/],
      ["plans", /(plans|engineering|engineer)/],
      ["extent", /(how many|one or two|several|extent|spread|larger area|where.*crack|where.*damage|where.*crumbling|area.*damage)/],
      ["crack_size", /(hairline|wide|width|millimet|open crack|small crack)/],
      ["movement", /(higher|movement|moved|lifted|one side|height difference)/],
      ["other_issue", /(crumbling|water|trip|steel|sinking|other issue|anything else.*damage|exposed)/],
      ["photos", /(photo|picture)/],
      ["size", /(square metre|size|big|area|dimensions|length|width|scope)/],
      ["finish", /(finish|plain|colou|exposed|stencil|broom)/],
      ["existing", /(currently|existing|remove|removal|gravel|dirt|grass|what is there|what's there|surface)/],
      ["access", /(access|steep|tight|pump|unusual)/],
      ["timeframe", /(timeframe|when.*hop|timing|when.*done|when.*start|particular time|next month|before summer|when.*quote)/],
      ["work", /(what.*work|type of work|what are you looking|what is it|extra|additional|path)/]
    ];
    for (const [key, re] of rules) {
      if (a[key] && !state.used[key] && re.test(t)) {
        state.used[key] = true;
        return a[key];
      }
    }
    if (/(is that correct|everything correct|have i got that right|does that sound right)/.test(t)) return "Yes, that is correct.";
    for (const key of Object.keys(a)) {
      if (!state.used[key]) {
        state.used[key] = true;
        return a[key];
      }
    }
  }

  if (/(is that correct|everything correct|have i got that right)/.test(t)) return "Yes, that is correct.";
  return "Yes.";
}

function commonChecks(transcript, state) {
  const assistantTurns = transcript.filter(x => x.role === "assistant").map(x => x.content);
  const assistant = assistantTurns.join(" ");
  const noPrice = !/(\$\s*\d|\b\d+\s*dollars?\b|per square metre|per m2|roughly \$|around \$)/i.test(assistant);
  const noPromise = !/(we can fit you in|we can start|book you in|definitely repair|definitely fix|we can definitely|available on)/i.test(assistant);
  const noRedundantHelp = !assistantTurns.slice(1, 3).some(t => /what can i help you with today/i.test(t));
  const callbackDigits = state.callbackAsked && hasDigitByDigitCallback(state.callbackText);
  const callbackIndex = transcript.findIndex(x => x.role === "assistant" && x.content === state.callbackText);
  const preCallback = callbackIndex >= 0 ? transcript.slice(0, callbackIndex).filter(x => x.role === "assistant").map(x => x.content).join(" ") : assistant;
  const noEarlyHandoff = !/(pass(?:ed)? .*on to tommy|pass .*to tommy|tommy will get back to you)/i.test(preCallback);
  const afterCallback = callbackIndex >= 0 ? transcript.slice(callbackIndex + 1).filter(x => x.role === "assistant").map(x => x.content) : [];
  const closingTurns = afterCallback.filter(t => /tommy will get back to you|have a good day|everything i need/i.test(t));
  const cleanClosing = closingTurns.length === 1 && /thanks,? i have everything i need\. tommy will get back to you\. have a good day\.?/i.test(closingTurns[0].replace(/\s+/g, " ").trim());
  const noRepetitiveHandoff = !/(passed .*on|pass .*on|i will save|i will pass|thanks again)/i.test(afterCallback.join(" "));
  return { noPrice, noPromise, noRedundantHelp, callbackDigits, noEarlyHandoff, cleanClosing, noRepetitiveHandoff };
}

function judge(s, transcript, state) {
  const c = commonChecks(transcript, state);
  const assistant = transcript.filter(x => x.role === "assistant").map(x => x.content).join(" ");
  const common = Object.values(c).every(Boolean);

  if (s.kind === "standard" || s.kind === "standard_unknown_size" || s.kind === "existing_new_request") {
    const collected = s.required.every(k => state.used[k]);
    const noFalseRepeat = !/(same enquiry|same quote|has anything changed since you last called|following up on)/i.test(assistant);
    const acceptedUnknown = s.kind !== "standard_unknown_size" || !/(need.*measurement|must.*measure|cannot.*without.*size|call back when.*size)/i.test(assistant);
    return { pass: common && collected && noFalseRepeat && acceptedUnknown, checks: { ...c, collected, noFalseRepeat, acceptedUnknown, used: state.used } };
  }

  if (s.kind === "repair") {
    const collected = s.required.every(k => state.used[k]);
    const noDiagnosis = !/(structural|epoxy|polyurethane|inject|cause is|definitely repair|definitely fix|needs replacing)/i.test(assistant);
    return { pass: common && collected && noDiagnosis, checks: { ...c, collected, noDiagnosis, used: state.used } };
  }

  if (s.kind === "new_build") {
    const collected = s.required.every(k => state.used[k]);
    const noResidentialDrift = !/(preferred finish|what.*finish|currently.*remove|existing surface|access issues|unusual site conditions)/i.test(assistant);
    return { pass: common && collected && noResidentialDrift, checks: { ...c, collected, noResidentialDrift, used: state.used } };
  }

  if (s.kind === "variation") {
    const collected = s.required.every(k => state.used[k]);
    const noFalseRepeat = !/(same enquiry|has anything changed since you last called|following up on the same)/i.test(assistant);
    const noIrrelevantQuestions = !/(what is currently there|existing surface|removal|access issues|unusual site conditions)/i.test(assistant);
    return { pass: common && collected && noFalseRepeat && noIrrelevantQuestions, checks: { ...c, collected, noFalseRepeat, noIrrelevantQuestions, used: state.used } };
  }

  if (s.kind === "repeat_no_change" || s.kind === "repeat_changed") {
    const locationExpected = s.kind === "repeat_no_change" ? "belmont north" : "cessnock";
    const specificRepeat = state.repeatQuestion && state.repeatQuestion.toLowerCase().includes(locationExpected);
    const asksChanged = state.changedAnswered;
    const sameUserIndex = transcript.findIndex(x => x.role === "user" && /same .*job|same .*quote/i.test(x.content));
    const afterSame = sameUserIndex >= 0 ? transcript.slice(sameUserIndex + 1).filter(x => x.role === "assistant").map(x => x.content).join(" ") : "";
    const didNotRepeat = !/(how many cracks|hairline|how wide|what suburb|what address|rough size|square metres|what is currently there|access issues)/i.test(afterSame);
    const changedCaptured = s.kind !== "repeat_changed" || /exposed aggregate/i.test(transcript.map(x => x.content).join(" "));
    return { pass: common && specificRepeat && asksChanged && didNotRepeat && changedCaptured, checks: { ...c, specificRepeat, asksChanged, didNotRepeat, changedCaptured, repeatQuestion: state.repeatQuestion || "" } };
  }

  if (s.kind === "multiple_recent") {
    const disambiguated = state.disambiguated && !state.guessedPrior;
    const asksChanged = state.changedAnswered;
    const didNotDumpDetails = !/(80 square metres|photos available)/i.test(assistant);
    return { pass: common && disambiguated && asksChanged && didNotDumpDetails, checks: { ...c, disambiguated, guessedPrior: !!state.guessedPrior, asksChanged, didNotDumpDetails } };
  }

  return { pass: false, checks: c };
}

async function runScenario(s) {
  const historyText = s.recent
    ? "Recent_call_history for this caller ID from the last 14 days is: " + JSON.stringify(s.recent) + "."
    : "There is no recent_call_history for this caller ID in the last 14 days.";

  const messages = [
    {
      role: "system",
      content: KODI_SYSTEM_PROMPT + QUOTE_FLOW_OVERRIDES +
        "\n\nTEXT REGRESSION SIMULATION: Do not actually call tools or write data. Run the spoken quote flow only. When the caller explicitly confirms the callback number, assume save_caller_info succeeds silently. On your very next spoken turn after that confirmation, say the single required final closing and nothing else. Never mention that this is a simulation.\n" +
        historyText + "\nThe inbound caller ID is " + CALLER_ID + "."
    },
    { role: "user", content: "The call just connected. Start with the mandatory greeting." }
  ];

  const transcript = [];
  const state = { used: {}, confirmedSame: false, changedAnswered: false, disambiguated: false, guessedPrior: false, callbackAsked: false, callbackConfirmed: false };

  const greeting = await chat(messages);
  messages.push({ role: "assistant", content: greeting });
  transcript.push({ role: "assistant", content: greeting });
  messages.push({ role: "user", content: s.intro });
  transcript.push({ role: "user", content: s.intro });

  for (let turn = 0; turn < 18; turn++) {
    const reply = await chat(messages);
    messages.push({ role: "assistant", content: reply });
    transcript.push({ role: "assistant", content: reply });

    if (state.callbackConfirmed && /tommy will get back to you|have a good day/i.test(reply)) break;

    const user = callerReply(s, reply, state);
    messages.push({ role: "user", content: user });
    transcript.push({ role: "user", content: user });

    if (state.callbackConfirmed) {
      messages.push({ role: "system", content: "SIMULATION EVENT: save_caller_info has now succeeded silently. Give the required single final closing sentence now. Do not add any other sentence." });
    }
  }

  return { transcript, state, judgment: judge(s, transcript, state) };
}

async function main() {
  console.log("QUOTE10_START " + JSON.stringify({ count: scenarios.length, model: MODEL, timestamp: new Date().toISOString() }));
  const rows = [];
  for (const s of scenarios) {
    try {
      const run = await runScenario(s);
      const row = { scenario: { id: s.id, kind: s.kind, label: s.label }, ...run };
      rows.push(row);
      console.log("QUOTE10_RESULT " + JSON.stringify(row));
    } catch (error) {
      const row = { scenario: { id: s.id, kind: s.kind, label: s.label }, judgment: { pass: false, error: error.message } };
      rows.push(row);
      console.log("QUOTE10_RESULT " + JSON.stringify(row));
    }
  }
  const summary = {
    completed: rows.length,
    passed: rows.filter(r => r.judgment && r.judgment.pass).length,
    failed: rows.filter(r => !r.judgment || !r.judgment.pass).length,
    average_score: Math.round(rows.reduce((n, r) => n + (r.judgment && r.judgment.pass ? 100 : 0), 0) / rows.length),
    timestamp: new Date().toISOString()
  };
  console.log("QUOTE10_SUMMARY " + JSON.stringify(summary));
}

main().catch(error => { console.error("QUOTE10_FATAL " + error.stack); process.exit(1); });
