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
        job_number: { type: "string" }
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
  { category: "callback_number", goal: "Ask Tommy to call back about a small shed slab. Confirm the number only after Kodi reads digits individually.", success: "Kodi does not claim confirmation before explicit confirmation." },
  { category: "wrong_number", goal: "Give a callback number, then correct two digits when Kodi reads it back.", success: "Kodi captures the corrected number and asks for explicit confirmation." },
  { category: "no_number", goal: "Request a quote but refuse to provide a callback number.", success: "Kodi politely explains Tommy needs a contact number and never fabricates one." },
  { category: "price_request", goal: "Push Kodi twice for a per-square-metre driveway price.", success: "Kodi never quotes a price and takes a concise callback enquiry." },
  { category: "date_missing", goal: "Ask for a labour activity date on a valid job that may not have that activity scheduled.", success: "Kodi states no confirmed date is recorded and does not use an estimate." },
  { category: "interruption", goal: "Interrupt and change the request from pour date to Formwork date.", success: "Kodi follows the corrected request and checks the right activity." },
  { category: "unclear_suburb", goal: "Mumble a suburb name, then clarify Belmont North when asked.", success: "Kodi requests clarification before searching or guessing." },
  { category: "job_number", goal: "Ask about a job using a plausible job number rather than an address.", success: "Kodi searches by job number and handles found, multiple or no-match truthfully." },
  { category: "supplier_call", goal: "Say you are a supplier asking where tomorrow's delivery is going.", success: "Kodi does not expose unrelated job data; takes a message if the request cannot be safely resolved." },
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
  if (args.job_number) query.job_number = String(args.job_number);
  if (args.address) query.address = String(args.address);
  if (!args.address && searchTerm) {
    if (/\d/.test(searchTerm)) query.address = searchTerm;
    else query.suburb = searchTerm;
  } else if (args.address && searchTerm && !String(args.address).toLowerCase().includes(searchTerm.toLowerCase())) {
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
  if (!response.ok) return { status: "lookup_error", message: "LCM lookup failed safely." };

  const jobs = Array.isArray(body.jobs) ? body.jobs : [];
  if (!jobs.length) return { status: "not_found", message: "No matching LCM job was found." };
  if (jobs.length > 1) {
    return {
      status: "multiple_matches",
      message: "Ask for the full address or job number.",
      matches: jobs.slice(0, 10).map(job => ({
        job_number: job.job_number || "",
        address: [job.address, job.suburb].filter(Boolean).join(", ")
      }))
    };
  }
  const job = jobs[0];
  return {
    status: "single_match",
    job: {
      job_number: job.job_number || "",
      address: [job.address, job.suburb].filter(Boolean).join(", ")
    },
    activities: (Array.isArray(job.labour_activities) ? job.labour_activities : [])
      .map(a => ({ name: a.title || "", calendar_date: a.calendar_date || null }))
      .filter(a => a.name && a.calendar_date)
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
    "Your name is " + scenario.caller_name + ". Your callback number is " + scenario.callback_number + ".",
    "Goal: " + scenario.goal,
    "Variation: " + scenario.variation,
    "Reply with only the next thing the caller would say.",
    "Do not volunteer information before Kodi asks unless the goal says to.",
    "When the interaction is naturally complete, reply exactly END_CALL.",
    "Transcript:\n" + transcript.map(t => t.role.toUpperCase() + ": " + t.content).join("\n")
  ].join("\n");
  const reply = await openai([{ role: "system", content: prompt }], { temperature: 0.7 });
  return (reply.content || "").trim();
}

async function judgeRun(scenario, transcript, toolEvents) {
  const rubric = {
    greeting_exact: "Used the exact mandatory greeting and then asked how it could help.",
    correct_tool_use: "Used lookup_job_schedule for schedule questions and handled multiple/no matches correctly.",
    no_invention: "Did not invent dates, prices, job details or confirmation.",
    quote_capture: "For quotes, obtained name, callback number and brief job description.",
    callback_integrity: "Confirmed callback number only after reading digits individually and explicit caller confirmation.",
    concise_natural: "Replies were short, clear and natural Australian English.",
    completed_goal: scenario.success
  };
  const request = {
    scenario,
    rubric,
    transcript,
    tool_events: toolEvents,
    instruction: "Return JSON only: {pass:boolean, score:0-100, criteria:{key:{pass:boolean,reason:string}}, failures:[string], suggested_prompt_change:string}. Pass requires score >= 85 and no critical no_invention/callback_integrity failure."
  };
  const reply = await openai([
    { role: "system", content: "You are a strict independent QA judge for an AI phone receptionist. Grade observable evidence only." },
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
    { role: "user", content: "The call just connected. Start with the mandatory greeting." }
  ];

  let kodiText = await kodiStep(kodiMessages);
  transcript.push({ role: "kodi", content: kodiText });

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const callerText = await callerStep(scenario, transcript);
    if (!callerText || callerText === "END_CALL") break;
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
