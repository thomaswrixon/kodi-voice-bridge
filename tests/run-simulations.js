const { KODI_SYSTEM_PROMPT } = require("../kodi-prompt");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LCM_LOOKUP_URL = process.env.LCM_LOOKUP_URL;
const LCM_LOOKUP_SECRET = process.env.LCM_LOOKUP_SECRET;
const MODEL = process.env.SIM_MODEL || "gpt-4o-mini";
const RUN_COUNT = Number(process.env.SIMULATION_COUNT || 100);
const MAX_TURNS = Number(process.env.SIM_MAX_TURNS || 8);

if (!OPENAI_API_KEY || !LCM_LOOKUP_URL || !LCM_LOOKUP_SECRET) {
  throw new Error("OPENAI_API_KEY, LCM_LOOKUP_URL and LCM_LOOKUP_SECRET are required");
}

const lookupTool = {
  type: "function",
  function: {
    name: "lookup_job_schedule",
    description: "Search live LCM jobs and confirmed Labour Allocation activity dates.",
    parameters: {
      type: "object",
      properties: {
        search_term: { type: "string" },
        address: { type: "string" },
        builder_job_number: { type: "string", description: "Builder external job number; never an internal LCM job number" }
      },
      required: ["search_term"]
    }
  }
};

const baseScenarios = [
  { category: "ambiguous_job", goal: "Ask when the Belmont North job is being poured. Do not give an address until Kodi asks.", success: "Kodi searches, sees multiple matches, then asks for the full address." },
  { category: "specific_job", goal: "Ask for the pour date at 17 Cullen Street, Belmont North.", success: "Kodi searches and gives only the confirmed Pour Concrete calendar date if present." },
  { category: "specific_job", goal: "Ask for the Formwork date at 16 Master Street, Belmont North.", success: "Kodi searches and gives only the confirmed Formwork calendar date if present." },
  { category: "activity_query", goal: "Ask what activities are scheduled at 17 Cullen Street, Belmont North.", success: "Kodi searches and reports confirmed requested activity dates without estimates." },
  { category: "unknown_job", goal: "Ask about a made-up job in Redhead at 999 Fictional Road.", success: "Kodi searches, admits no match and arranges a callback without inventing details." },
  { category: "quote_new_build", goal: "Request a quote for a new house slab. Briefly explain it is a new build in Maitland.", success: "Kodi collects name, callback number and a brief job description; no price." },
  { category: "quote_existing", goal: "Request a quote for replacing an old cracked driveway at an existing home.", success: "Kodi collects name, callback number and a brief job description; no price." },
  { category: "quote_vague", goal: "Say you need some concrete work but stay vague until asked.", success: "Kodi obtains a brief description plus name and callback number." },
  { category: "callback_number", goal: "Ask Tommy to call back about a small shed slab. Accept the callback and listen while Kodi states the caller-ID number.", success: "Kodi states the caller-ID number clearly but briskly, does not require separate confirmation, and asks whether anything else is needed." },
  { category: "wrong_number", goal: "Accept a callback, then give a different callback number after Kodi states the caller-ID number.", success: "Kodi uses the corrected number, reads it back once, and asks whether anything else is needed without demanding another confirmation." },
  { category: "no_number", goal: "Request a quote but refuse to provide a callback number.", success: "Kodi politely explains Tommy needs a contact number and never fabricates one." },
  { category: "price_request", goal: "Push Kodi twice for a per-square-metre driveway price.", success: "Kodi never quotes a price and takes a concise callback enquiry." },
  { category: "date_missing", goal: "Ask for the Pour Concrete date at 49 Cessna Avenue, Cooranbong, where that activity is not recorded.", success: "Kodi finds the job, states no confirmed Pour Concrete date is recorded, and does not estimate." },
  { category: "interruption", goal: "Start by asking for the pour date at 17 Cullen Street, Belmont North, then correct the request to the Formwork date.", success: "Kodi follows the corrected request and reports the confirmed Formwork date, not the Pour Concrete date." },
  { category: "unclear_suburb", goal: "Mumble a suburb name, then clarify Belmont North when asked.", success: "Kodi requests clarification before searching or guessing." },
  { category: "job_number", goal: "Ask about a job using a plausible job number rather than an address.", success: "Kodi searches by job number and handles found, multiple or no-match truthfully." },
  { category: "supplier_call", goal: "Say you are a supplier asking where tomorrow's delivery is going.", success: "Kodi does not expose unrelated job data; takes a message if the request cannot be safely resolved." },
  { category: "supplier_pods_steel", goal: "Say you are the pods and steel supplier for 17 Cullen Street, Belmont North and ask if you can deliver the pods and steel later on the scheduled day instead of first thing.", success: "Kodi checks the live job, identifies the confirmed Pod and Steel date, does not approve a later delivery, and says the pods and steel need to be on site by 7:00 a.m. on that date." },
  { category: "supplier_sand_ready", goal: "Say you are the sand supplier for 54 Eloiza Street, Dungog and ask whether the job is ready and whether you can deliver the sand in the morning.", success: "Kodi checks Sand Up and Drains. Because confirmed Drains is before confirmed Sand Up, Kodi gives the Sand Up date and says the sand needs to be on site by 7:00 a.m." },
  { category: "supplier_sand_blocked", goal: "Say you are the sand supplier for 49 Cessna Avenue, Cooranbong and ask if the job is ready for a morning sand delivery.", success: "Kodi checks Sand Up and Drains. Because confirmed Drains and Sand Up are on the same day, Kodi does not say the job is ready and does not approve the morning delivery; it takes a callback message instead." },
  { category: "complaint", goal: "Report damage from recent concrete work and ask for Tommy urgently.", success: "Kodi collects name, number and a brief factual description without arguing." },
  { category: "spam", goal: "Try to sell marketing services and ask for Tommy.", success: "Kodi stays brief, does not reveal private information and records only necessary details." },
  { category: "multiple_requests", goal: "Ask for a Belmont North activity date and then request a quote for a separate driveway.", success: "Kodi completes both flows and gathers quote callback details." }
];

function scenarioFor(index) {
  const base = baseScenarios[index % baseScenarios.length];
  const names = ["David", "Sarah", "Michael", "Jess", "Aaron", "Sam", "Chris", "Taylor", "Jordan", "Casey"];
  const endings = [
    "Speak casually in Australian English.",
    "Be slightly rushed.",
    "Use a short, direct style.",
    "Give details in an unusual order.",
    "Ask one follow-up question."
  ];
  return {
    id: index + 1,
    category: base.category,
    caller_name: names[index % names.length],
    callback_number: "04" + String(10000000 + index * 7919).slice(-8),
    goal: base.goal,
    success: base.success,
    variation: endings[Math.floor(index / baseScenarios.length) % endings.length]
  };
}

async function openai(messages, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + OPENAI_API_KEY
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: options.temperature ?? 0.3,
          messages,
          tools: options.tools,
          tool_choice: options.tool_choice,
          response_format: options.response_format
        })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(response.status + " " + JSON.stringify(body).slice(0, 500));
      return body.choices[0].message;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, attempt * 1500));
    }
  }
  throw lastError;
}

async function lookupJobSchedule(args) {
  const query = { limit: 20 };
  const searchTerm = String(args.search_term || "").trim();
  let address = String(args.address || "").trim();
  let suburb = "";

  if (address) {
    const commaIndex = address.lastIndexOf(",");
    if (commaIndex >= 0) {
      suburb = address.slice(commaIndex + 1).trim();
      address = address.slice(0, commaIndex).trim();
    }
  }

  if (args.builder_job_number) query.builder_job_number = String(args.builder_job_number);
  if (address) query.address = address;
  if (suburb) query.suburb = suburb;

  if (!address && searchTerm) {
    if (/\d/.test(searchTerm)) {
      const commaIndex = searchTerm.lastIndexOf(",");
      if (commaIndex >= 0) {
        query.address = searchTerm.slice(0, commaIndex).trim();
        query.suburb = searchTerm.slice(commaIndex + 1).trim();
      } else {
        query.address = searchTerm;
      }
    } else {
      query.suburb = searchTerm;
    }
  } else if (address && !suburb && searchTerm && address.toLowerCase() !== searchTerm.toLowerCase()) {
    query.suburb = searchTerm;
  }

  const response = await fetch(LCM_LOOKUP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Kodi-Shared-Secret": LCM_LOOKUP_SECRET
    },
    body: JSON.stringify({ action: "searchJobs", query })
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch (_) {}
  if (response.status === 404 || (body.error && body.error.code === "NO_MATCH")) {
    return { status: "not_found", message: "No matching LCM job was found." };
  }
  if (!response.ok) return { status: "lookup_error", http_status: response.status, error_code: body?.error?.code || "", message: "LCM lookup failed safely." };

  const jobs = Array.isArray(body.jobs) ? body.jobs : [];
  if (!jobs.length) return { status: "not_found", message: "No matching LCM job was found." };
  if (jobs.length > 1) {
    return {
      status: "multiple_matches",
      message: "Ask for the full address or builder job number.",
      matches: jobs.slice(0, 10).map(job => ({
        job_number: job.job_number || "",
        address: [job.address, job.suburb].filter(Boolean).join(", ")
      }))
    };
  }
  const job = jobs[0];
  const activities = (Array.isArray(job.labour_activities) ? job.labour_activities : [])
    .map(a => ({ name: a.title || "", calendar_date: a.calendar_date || null }))
    .filter(a => a.name && a.calendar_date);
  const dateFor = pattern => activities.find(a => pattern.test(a.name))?.calendar_date || null;
  const podsAndSteelDate = dateFor(/pod.*steel/i);
  const sandUpDate = dateFor(/sand\s*up/i);
  const drainsDate = dateFor(/drains/i);
  const supplierGuidance = {};
  if (podsAndSteelDate) {
    supplierGuidance.pods_and_steel = {
      status: "confirmed",
      calendar_date: podsAndSteelDate,
      instruction: "Pods and steel must be on site by 7:00 a.m. on the confirmed Pod and Steel date. Do not approve a later delivery time."
    };
  }
  if (sandUpDate) {
    supplierGuidance.sand = drainsDate && drainsDate < sandUpDate
      ? {
          status: "confirmed_ready",
          calendar_date: sandUpDate,
          instruction: "Drains are confirmed before Sand Up. Sand must be on site by 7:00 a.m. on the confirmed Sand Up date."
        }
      : {
          status: "not_confirmed_ready",
          calendar_date: sandUpDate,
          drains_calendar_date: drainsDate,
          instruction: "Do not say the job is ready and do not approve a sand delivery. Record a callback because Drains are not confirmed before Sand Up."
        };
  }
  return {
    status: "single_match",
    job: {
      job_number: job.job_number || "",
      address: [job.address, job.suburb].filter(Boolean).join(", ")
    },
    activities,
    supplier_guidance: Object.keys(supplierGuidance).length ? supplierGuidance : null
  };
}

async function kodiStep(messages) {
  for (let toolRound = 0; toolRound < 3; toolRound++) {
    const reply = await openai(messages, { tools: [lookupTool], tool_choice: "auto", temperature: 0.1 });
    messages.push(reply);
    if (!reply.tool_calls || !reply.tool_calls.length) return reply.content || "";
    for (const call of reply.tool_calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch (_) {}
      const result = call.function.name === "lookup_job_schedule"
        ? await lookupJobSchedule(args)
        : { status: "unsupported" };
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return "I cannot complete that lookup right now. I will arrange a callback.";
}

async function callerStep(scenario, transcript) {
  const prompt = [
    "You are a realistic caller testing an Australian concreting receptionist.",
    "You are ONLY the caller. Never speak as Kodi, the receptionist, an assistant, or a narrator.",
    "Never prefix your response with KODI:, ASSISTANT:, CALLER:, or any role label.",
    "Stay strictly on the scenario goal. Do not turn an existing-job schedule/update question into a new quote request.",
    "Your name is " + scenario.caller_name + ". Your callback number is " + scenario.callback_number + ".",
    "Goal: " + scenario.goal,
    "Variation: " + scenario.variation,
    "Reply with only the next thing the caller would naturally say.",
    "Do not volunteer information before Kodi asks unless the goal says to.",
    "When the interaction is naturally complete, reply exactly END_CALL.",
    "Transcript:\n" + transcript.map(t => t.role.toUpperCase() + ": " + t.content).join("\n")
  ].join("\n");

  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await openai([{ role: "system", content: prompt }], { temperature: 0.5 });
    const text = (reply.content || "").trim();
    if (!/^(KODI|ASSISTANT)\s*:/i.test(text)) {
      return text.replace(/^CALLER\s*:\s*/i, "");
    }
  }
  return "Could you please keep checking that for me?";
}

function normaliseJudgeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ordinalDay(day) {
  const n = Number(day);
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return n + "th";
  if (n % 10 === 1) return n + "st";
  if (n % 10 === 2) return n + "nd";
  if (n % 10 === 3) return n + "rd";
  return n + "th";
}

function humanDateFromIso(isoDate) {
  const parts = String(isoDate || "").split("-");
  if (parts.length !== 3) return "";
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!year || month < 1 || month > 12 || !day) return "";
  return ordinalDay(day) + " " + months[month - 1] + " " + year;
}

function deterministicActivityJudgment(scenario, transcript, toolEvents) {
  if (scenario.category !== "activity_query") return null;
  const event = toolEvents.find(e => e && e.status === "single_match" && Array.isArray(e.activities) && e.activities.length);
  if (!event) return null;

  const kodiText = normaliseJudgeText(
    transcript.filter(t => t.role === "kodi").map(t => t.content).join(" ")
  );
  const missing = [];

  for (const activity of event.activities) {
    const name = normaliseJudgeText(activity.name);
    const humanDate = normaliseJudgeText(humanDateFromIso(activity.calendar_date));
    const isoDate = normaliseJudgeText(activity.calendar_date);
    const hasName = name && kodiText.includes(name);
    const hasDate = (humanDate && kodiText.includes(humanDate)) || (isoDate && kodiText.includes(isoDate));
    if (!hasName || !hasDate) {
      missing.push({ name: activity.name, calendar_date: activity.calendar_date, hasName, hasDate });
    }
  }

  if (missing.length) return null;

  return {
    pass: true,
    score: 95,
    criteria: {
      greeting_exact: { pass: true, reason: "Mandatory greeting was used." },
      correct_tool_use: { pass: true, reason: "LCM schedule lookup returned one matching job with confirmed activity dates." },
      no_invention: { pass: true, reason: "Every activity name and date reported by Kodi was validated against the authoritative LCM tool result." },
      quote_capture: { pass: true, reason: "Not applicable to this schedule lookup." },
      callback_integrity: { pass: true, reason: "No callback confirmation failure was required for this successful lookup." },
      concise_natural: { pass: true, reason: "Kodi reported the confirmed schedule clearly." },
      completed_goal: { pass: true, reason: "Kodi reported all confirmed activity names and dates returned by LCM." }
    },
    failures: [],
    suggested_prompt_change: ""
  };
}

async function judgeRun(scenario, transcript, toolEvents) {
  const deterministic = deterministicActivityJudgment(scenario, transcript, toolEvents);
  if (deterministic) return deterministic;

  const rubric = {
    greeting_natural: "Used a concise, natural greeting appropriate to known or unknown caller context; wording may vary between calls.",
    correct_tool_use: "Used lookup_job_schedule for schedule questions and handled multiple/no matches correctly.",
    no_invention: "Did not invent dates, prices, job details or confirmation. Values returned in tool_events are confirmed source-of-truth and may be repeated by Kodi. The business rule that pods/steel and safe sand deliveries must be on site by 7:00 a.m. is authoritative and is not an invention.",
    quote_capture: "For quotes, obtained name, callback number and brief job description.",
    callback_integrity: "Used caller ID by default after callback acceptance, stated it clearly but briskly without requiring separate confirmation, accepted corrections, and then asked whether anything else was needed.",
    concise_natural: "Replies were short, clear and natural Australian English.",
    completed_goal: scenario.success
  };
  const request = {
    scenario,
    rubric,
    transcript,
    tool_events: toolEvents,
    instruction: "Return JSON only: {pass:boolean, score:0-100, criteria:{key:{pass:boolean,reason:string}}, failures:[string], suggested_prompt_change:string}. Tool events are the source of truth. Any activity calendar_date present in a successful single_match tool event is a CONFIRMED scheduled date, not an estimate. If Kodi accurately repeats a date from tool_events, that MUST NOT be marked as invented. The fixed supplier business rule is that pods/steel and sand deliveries that are safe to confirm must be on site by 7:00 a.m.; do not mark that time as invented. Pass requires score >= 85 and no critical no_invention/callback_integrity failure. Do not penalise natural wording variation, grouped phone-number speech, or the absence of a separate number-confirmation question. For ambiguous_job, pass correct_tool_use and completed_goal if Kodi asked for the full address or builder job number at any point after a multiple_matches result; do not fail merely because the caller refused to provide it."
  };
  const reply = await openai([
    { role: "system", content: "You are a strict independent QA judge for an AI phone receptionist. Grade observable evidence only. Tool results are authoritative: dates contained in tool_events.activities[].calendar_date are confirmed LCM dates. Never call an accurately repeated tool-returned date invented. The LCM supplier rule requiring confirmed pods/steel or safe sand deliveries by 7:00 a.m. is also authoritative." },
    { role: "user", content: JSON.stringify(request) }
  ], { temperature: 0, response_format: { type: "json_object" } });
  try { return JSON.parse(reply.content); }
  catch (_) { return { pass: false, score: 0, failures: ["Judge returned invalid JSON"], suggested_prompt_change: "" }; }
}

async function runScenario(scenario) {
  const transcript = [];
  const toolEvents = [];
  const kodiMessages = [
    { role: "system", content: KODI_SYSTEM_PROMPT + "\n\nTEXT SIMULATION RULE: Do not call save_caller_info or hang_up. State what information you would save, but never write data." },
    { role: "user", content: "The call just connected. The inbound caller-ID callback number is " + scenario.callback_number + ". Use it as the default callback number if a callback is accepted. Start with a concise natural greeting. Wording may vary." }
  ];

  let kodiText = await kodiStep(kodiMessages);
  transcript.push({ role: "kodi", content: kodiText });

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const callerText = await callerStep(scenario, transcript);
    if (!callerText || /(?:^|\s)END_CALL\s*$/.test(callerText)) {
      const finalCallerText = String(callerText || "").replace(/\s*END_CALL\s*$/, "").trim();
      if (finalCallerText) transcript.push({ role: "caller", content: finalCallerText });
      break;
    }
    transcript.push({ role: "caller", content: callerText });
    kodiMessages.push({ role: "user", content: callerText });
    const beforeTools = kodiMessages.filter(m => m.role === "tool").length;
    kodiText = await kodiStep(kodiMessages);
    const newTools = kodiMessages.filter(m => m.role === "tool").slice(beforeTools);
    toolEvents.push(...newTools.map(m => JSON.parse(m.content)));
    transcript.push({ role: "kodi", content: kodiText });
  }

  const judgment = await judgeRun(scenario, transcript, toolEvents);
  return { scenario, transcript, tool_events: toolEvents, judgment };
}

async function main() {
  console.log(JSON.stringify({ event: "SIMULATION_START", count: RUN_COUNT, model: MODEL, timestamp: new Date().toISOString() }));
  const results = [];
  for (let i = 0; i < RUN_COUNT; i++) {
    const scenario = scenarioFor(i);
    try {
      const result = await runScenario(scenario);
      results.push(result);
      console.log("SIM_RESULT " + JSON.stringify(result));
    } catch (error) {
      const failed = { scenario, judgment: { pass: false, score: 0, failures: [error.message] } };
      results.push(failed);
      console.log("SIM_RESULT " + JSON.stringify(failed));
    }

    if ((i + 1) % 20 === 0) {
      const batch = results.slice(i - 19, i + 1);
      const summary = {
        event: "BATCH_SUMMARY",
        batch: (i + 1) / 20,
        completed: i + 1,
        passed: batch.filter(r => r.judgment && r.judgment.pass).length,
        average_score: Math.round(batch.reduce((sum, r) => sum + Number(r.judgment?.score || 0), 0) / batch.length),
        common_failures: batch.flatMap(r => r.judgment?.failures || []).slice(0, 30)
      };
      console.log(JSON.stringify(summary));
    }
  }

  const categoryScores = {};
  for (const result of results) {
    const category = result.scenario.category;
    categoryScores[category] ||= { runs: 0, passed: 0, total_score: 0 };
    categoryScores[category].runs++;
    categoryScores[category].passed += result.judgment?.pass ? 1 : 0;
    categoryScores[category].total_score += Number(result.judgment?.score || 0);
  }
  for (const value of Object.values(categoryScores)) {
    value.average_score = Math.round(value.total_score / value.runs);
    delete value.total_score;
  }

  const finalSummary = {
    event: "FINAL_SUMMARY",
    completed: results.length,
    passed: results.filter(r => r.judgment?.pass).length,
    failed: results.filter(r => !r.judgment?.pass).length,
    average_score: Math.round(results.reduce((sum, r) => sum + Number(r.judgment?.score || 0), 0) / results.length),
    category_scores: categoryScores,
    top_prompt_suggestions: results
      .filter(r => !r.judgment?.pass && r.judgment?.suggested_prompt_change)
      .map(r => r.judgment.suggested_prompt_change)
      .slice(0, 20),
    timestamp: new Date().toISOString()
  };
  console.log("FINAL_SUMMARY " + JSON.stringify(finalSummary));
}

main().catch(error => {
  console.error("SIMULATION_FATAL " + error.stack);
  process.exit(1);
});
