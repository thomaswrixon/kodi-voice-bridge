const { KODI_SYSTEM_PROMPT } = require("../kodi-prompt");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LCM_LOOKUP_URL = process.env.LCM_LOOKUP_URL;
const LCM_LOOKUP_SECRET = process.env.LCM_LOOKUP_SECRET;
const MODEL = process.env.SIM_MODEL || "gpt-4o-mini";
const SUITE = String(process.env.TARGET_SUITE || "dates").toLowerCase();

if (!OPENAI_API_KEY || !LCM_LOOKUP_URL || !LCM_LOOKUP_SECRET) {
  throw new Error("OPENAI_API_KEY, LCM_LOOKUP_URL and LCM_LOOKUP_SECRET are required");
}

const lookupTool = {
  type: "function",
  function: {
    name: "lookup_job_schedule",
    description: "Search live LCM jobs and all confirmed Labour Allocation activity dates.",
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

const dateScenarios = [
  { id: 1, category: "pour_date", caller: "Sarah", utterance: "Hi, it is Sarah. What date are you pouring 17 Cullen Street, Belmont North?", activity: "Pour Concrete" },
  { id: 2, category: "formwork_date", caller: "Michael", utterance: "Hi, Michael here. When are you doing the formwork at 17 Cullen Street, Belmont North?", activity: "Formwork" },
  { id: 3, category: "sand_up_date", caller: "Jess", utterance: "Hi, it is Jess. When are you sanding up 17 Cullen Street, Belmont North?", activity: "Sand Up" },
  { id: 4, category: "site_start", caller: "David", utterance: "Hi, David here. When are you starting on site at 17 Cullen Street, Belmont North?", site_start: true },
  { id: 5, category: "pod_steel_date", caller: "Aaron", utterance: "Hi, it is Aaron. When are you doing pods and steel at 17 Cullen Street, Belmont North?", activity: "Pod and Steel" },
  { id: 6, category: "pre_pour_date", caller: "Chris", utterance: "Hi, Chris here. What day is the pre-pour check at 17 Cullen Street, Belmont North?", activity: "Pre-Pour Check" },
  { id: 7, category: "drop_edge_date", caller: "Taylor", utterance: "Hi, it is Taylor. When is the drop edge booked at 17 Cullen Street, Belmont North?", activity: "Build Drop Edge" },
  { id: 8, category: "strip_date", caller: "Jordan", utterance: "Hi, Jordan here. When is the patio strip booked at 17 Cullen Street, Belmont North?", activity: "Strip Type 1 Patio" },
  { id: 9, category: "formwork_other_job", caller: "Casey", utterance: "Hi, it is Casey. What date is formwork at 16 Master Street, Belmont North?", activity: "Formwork" },
  { id: 10, category: "pod_steel_second_stage", caller: "Sam", utterance: "Hi, Sam here. What date is the second pods and steel stage at 16 Master Street, Belmont North?", activity: "Pod and Steel 2" }
];

const supplierScenarios = [
  { id: 1, category: "pods_late", utterance: "Hi, Marcus from Hunter Pods. For 17 Cullen Street, Belmont North, can we bring the pods and steel out later on the booked day?" },
  { id: 2, category: "pods_ready", utterance: "Hi, Marcus from Hunter Pods. Is the pods and steel job at 17 Cullen Street, Belmont North ready, and what time do you need us there?" },
  { id: 3, category: "pods_second_stage", utterance: "Hi, Marcus from Hunter Pods. When do you need the second pods and steel delivery at 16 Master Street, Belmont North?" },
  { id: 4, category: "sand_ready", utterance: "Hi, Bruce from Mulbring Valley. Is 54 Eloiza Street, Dungog ready for sand, and can I deliver it in the morning?" },
  { id: 5, category: "sand_blocked", utterance: "Hi, Bruce from Mulbring Valley. Is 49 Cessna Avenue, Cooranbong ready for a morning sand delivery?" },
  { id: 6, category: "sand_date", utterance: "Hi, Bruce from Mulbring Valley. What day do you need the sand at 54 Eloiza Street, Dungog?" },
  { id: 7, category: "pods_time", utterance: "Hi, Marcus from Hunter Pods. What time do the pods need to be on site at 17 Cullen Street, Belmont North?" },
  { id: 8, category: "sand_early", utterance: "Hi, Bruce from Mulbring Valley. Can I drop the sand first thing at 54 Eloiza Street, Dungog?" },
  { id: 9, category: "pods_late_other_job", utterance: "Hi, Marcus from Hunter Pods. Can we deliver later for the pods and steel at 16 Master Street, Belmont North?" },
  { id: 10, category: "sand_blocked_reworded", utterance: "Hi, Bruce from Mulbring Valley. If I come in the morning to 49 Cessna Avenue, Cooranbong, will the job be ready for sand?" }
];

function normalise(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\bof\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ordinal(day) {
  const n = Number(day);
  const m = n % 100;
  if (m >= 11 && m <= 13) return n + "th";
  if (n % 10 === 1) return n + "st";
  if (n % 10 === 2) return n + "nd";
  if (n % 10 === 3) return n + "rd";
  return n + "th";
}

function humanDate(iso) {
  const [y, m, d] = String(iso || "").split("-").map(Number);
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  if (!y || !m || !d) return "";
  return ordinal(d) + " " + months[m - 1] + " " + y;
}

function answerHasDate(answer, iso) {
  const a = normalise(answer);
  return a.includes(normalise(iso)) || a.includes(normalise(humanDate(iso))) || a.includes(normalise(humanDate(iso).replace(/(st|nd|rd|th)/, "")));
}

async function openai(messages, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + OPENAI_API_KEY },
        body: JSON.stringify({
          model: MODEL,
          temperature: options.temperature ?? 0.1,
          messages,
          tools: options.tools,
          tool_choice: options.tool_choice
        })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(response.status + " " + JSON.stringify(body).slice(0, 400));
      return body.choices[0].message;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
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
    const comma = address.lastIndexOf(",");
    if (comma >= 0) {
      suburb = address.slice(comma + 1).trim();
      address = address.slice(0, comma).trim();
    }
  }
  if (args.job_number) query.job_number = String(args.job_number);
  if (address) query.address = address;
  if (suburb) query.suburb = suburb;

  if (!address && searchTerm) {
    if (/\d/.test(searchTerm)) {
      const comma = searchTerm.lastIndexOf(",");
      if (comma >= 0) {
        query.address = searchTerm.slice(0, comma).trim();
        query.suburb = searchTerm.slice(comma + 1).trim();
      } else query.address = searchTerm;
    } else query.suburb = searchTerm;
  } else if (address && !suburb && searchTerm && normalise(address) !== normalise(searchTerm)) {
    query.suburb = searchTerm;
  }

  const response = await fetch(LCM_LOOKUP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Kodi-Shared-Secret": LCM_LOOKUP_SECRET },
    body: JSON.stringify({ action: "searchJobs", query })
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch (_) {}
  if (response.status === 404 || body?.error?.code === "NO_MATCH") return { status: "not_found", message: "No matching LCM job was found." };
  if (!response.ok) return { status: "lookup_error", http_status: response.status, error_code: body?.error?.code || "" };
  const jobs = Array.isArray(body.jobs) ? body.jobs : [];
  if (!jobs.length) return { status: "not_found", message: "No matching LCM job was found." };
  if (jobs.length > 1) return { status: "multiple_matches", matches: jobs.slice(0, 10).map(j => ({ job_number: j.job_number || "", address: [j.address, j.suburb].filter(Boolean).join(", ") })) };
  const job = jobs[0];
  return {
    status: "single_match",
    job: { job_number: job.job_number || "", address: [job.address, job.suburb].filter(Boolean).join(", ") },
    activities: (Array.isArray(job.labour_activities) ? job.labour_activities : []).map(a => ({ name: a.title || "", calendar_date: a.calendar_date || null })).filter(a => a.name && a.calendar_date)
  };
}

async function kodiReply(userText) {
  const messages = [
    { role: "system", content: KODI_SYSTEM_PROMPT + "\n\nTEXT SIMULATION RULE: Do not call save_caller_info or hang_up. Do not write data." },
    { role: "user", content: "The call just connected. Start with the mandatory greeting." }
  ];
  const greeting = await openai(messages, { tools: [lookupTool], tool_choice: "auto" });
  messages.push(greeting);
  messages.push({ role: "user", content: userText });
  const toolEvents = [];

  for (let round = 0; round < 4; round++) {
    const reply = await openai(messages, { tools: [lookupTool], tool_choice: "auto" });
    messages.push(reply);
    if (!reply.tool_calls || !reply.tool_calls.length) {
      return { greeting: greeting.content || "", answer: reply.content || "", tool_events: toolEvents };
    }
    for (const call of reply.tool_calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch (_) {}
      const result = await lookupJobSchedule(args);
      toolEvents.push({ args, result });
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return { greeting: greeting.content || "", answer: "", tool_events: toolEvents };
}

function judgeDateScenario(scenario, run) {
  const single = run.tool_events.map(e => e.result).find(r => r && r.status === "single_match");
  const greetingPass = run.greeting.trim().startsWith("Hi, Local Concreting Mate, Kodi speaking. Can I ask who is calling?");
  if (!single) return { pass: false, score: 0, failure: "No single matching live LCM job returned." };

  let expected;
  if (scenario.site_start) {
    const candidates = single.activities.filter(a => ["pre-site check", "sand up"].includes(normalise(a.name)));
    candidates.sort((a, b) => String(a.calendar_date).localeCompare(String(b.calendar_date)));
    expected = candidates[0];
  } else {
    expected = single.activities.find(a => normalise(a.name) === normalise(scenario.activity));
  }
  if (!expected) return { pass: false, score: 20, failure: "Expected confirmed activity was not present in live LCM data." };

  const datePass = answerHasDate(run.answer, expected.calendar_date);
  const noLookupError = !run.tool_events.some(e => e.result?.status === "lookup_error");
  const pass = greetingPass && datePass && noLookupError;
  return {
    pass,
    score: pass ? 100 : 60,
    expected: { activity: scenario.site_start ? "SITE START" : expected.name, calendar_date: expected.calendar_date },
    checks: { greeting: greetingPass, expected_date_spoken: datePass, no_lookup_error: noLookupError },
    failure: pass ? "" : "Kodi did not cleanly report the confirmed expected date."
  };
}

async function judgeSupplierScenario(scenario, run) {
  const request = {
    scenario,
    transcript: [{ role: "kodi", content: run.greeting }, { role: "caller", content: scenario.utterance }, { role: "kodi", content: run.answer }],
    tool_events: run.tool_events,
    rules: [
      "Tool activity calendar_date values are authoritative.",
      "Pods and steel must be on site by 7:00 a.m. on the confirmed Pod and Steel date; later delivery is not approved.",
      "Sand is safe to confirm only when confirmed Drains is strictly before confirmed Sand Up; safe sand must be on site by 7:00 a.m.",
      "If Drains is same day as Sand Up, after it, missing, or unclear, do not confirm readiness or morning delivery."
    ]
  };
  const reply = await openai([
    { role: "system", content: "You are a strict QA judge. Return only compact JSON {pass:boolean,score:number,reason:string}. Grade against the supplied authoritative tool events and business rules." },
    { role: "user", content: JSON.stringify(request) }
  ]);
  try { return JSON.parse(reply.content); } catch (_) { return { pass: false, score: 0, reason: "Invalid judge JSON" }; }
}

async function main() {
  const scenarios = SUITE === "suppliers" ? supplierScenarios : dateScenarios;
  console.log("TARGETED_START " + JSON.stringify({ suite: SUITE, count: scenarios.length, model: MODEL, timestamp: new Date().toISOString() }));
  const results = [];
  for (const scenario of scenarios) {
    try {
      const run = await kodiReply(scenario.utterance);
      const judgment = SUITE === "suppliers" ? await judgeSupplierScenario(scenario, run) : judgeDateScenario(scenario, run);
      const result = { scenario, ...run, judgment };
      results.push(result);
      console.log("TARGETED_RESULT " + JSON.stringify(result));
    } catch (error) {
      const result = { scenario, judgment: { pass: false, score: 0, failure: error.message } };
      results.push(result);
      console.log("TARGETED_RESULT " + JSON.stringify(result));
    }
  }
  const summary = {
    event: "TARGETED_SUMMARY",
    suite: SUITE,
    completed: results.length,
    passed: results.filter(r => r.judgment?.pass).length,
    failed: results.filter(r => !r.judgment?.pass).length,
    average_score: Math.round(results.reduce((s, r) => s + Number(r.judgment?.score || 0), 0) / results.length),
    timestamp: new Date().toISOString()
  };
  console.log("TARGETED_SUMMARY " + JSON.stringify(summary));
}

main().catch(error => {
  console.error("TARGETED_FATAL " + error.stack);
  process.exit(1);
});
