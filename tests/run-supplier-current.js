const { KODI_SYSTEM_PROMPT } = require("../kodi-prompt");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LCM_LOOKUP_URL = process.env.LCM_LOOKUP_URL;
const LCM_LOOKUP_SECRET = process.env.LCM_LOOKUP_SECRET;
const MODEL = process.env.SIM_MODEL || "gpt-4o-mini";

if (!OPENAI_API_KEY || !LCM_LOOKUP_URL || !LCM_LOOKUP_SECRET) {
  throw new Error("OPENAI_API_KEY, LCM_LOOKUP_URL and LCM_LOOKUP_SECRET are required");
}

const lookupTool = {
  type: "function",
  function: {
    name: "lookup_job_schedule",
    description: "Search live LCM jobs and all confirmed Labour Allocation and supplier-critical activity dates.",
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

const scenarios = [
  { id: 1, category: "pods_late", kind: "pods", activity: "Pod and Steel", later: true, utterance: "Hi, Marcus from Hunter Pods. For 17 Cullen Street, Belmont North, can we bring the pods and steel out later on the booked day?" },
  { id: 2, category: "pods_ready", kind: "pods", activity: "Pod and Steel", utterance: "Hi, Marcus from Hunter Pods. Is the pods and steel job at 17 Cullen Street, Belmont North ready, and what time do you need us there?" },
  { id: 3, category: "pods_second_stage", kind: "pods", activity: "Pod and Steel 2", utterance: "Hi, Marcus from Hunter Pods. When do you need the second pods and steel delivery at 16 Master Street, Belmont North?" },
  { id: 4, category: "sand_ready_chisholm", kind: "sand_safe", utterance: "Hi, Bruce from Mulbring Valley. Is 22 Plumegrass Avenue, Chisholm ready for sand, and can I deliver it in the morning?" },
  { id: 5, category: "sand_ready_belmont", kind: "sand_safe", utterance: "Hi, Bruce from Mulbring Valley. Is 17 Cullen Street, Belmont North ready for sand, and when do you need it?" },
  { id: 6, category: "sand_date_wyee", kind: "sand_safe", utterance: "Hi, Bruce from Mulbring Valley. What day do you need the sand at 63 Kearney Way, Wyee?" },
  { id: 7, category: "pods_time", kind: "pods", activity: "Pod and Steel", utterance: "Hi, Marcus from Hunter Pods. What time do the pods need to be on site at 17 Cullen Street, Belmont North?" },
  { id: 8, category: "sand_early_chisholm", kind: "sand_safe", utterance: "Hi, Bruce from Mulbring Valley. Can I drop the sand first thing at 22 Plumegrass Avenue, Chisholm?" },
  { id: 9, category: "pods_late_other_job", kind: "pods", activity: "Pod and Steel", later: true, utterance: "Hi, Marcus from Hunter Pods. Can we deliver later for the pods and steel at 16 Master Street, Belmont North?" },
  { id: 10, category: "sand_blocked_same_day", kind: "sand_blocked", utterance: "Hi, Bruce from Mulbring Valley. Is 49 Cessna Avenue, Cooranbong ready for a morning sand delivery?" }
];

function norm(v) {
  return String(v || "").toLowerCase().replace(/\bof\b/g, " ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function ordinal(n) {
  n = Number(n);
  const m = n % 100;
  if (m >= 11 && m <= 13) return n + "th";
  if (n % 10 === 1) return n + "st";
  if (n % 10 === 2) return n + "nd";
  if (n % 10 === 3) return n + "rd";
  return n + "th";
}

function humanDate(iso) {
  const [y, m, d] = String(iso || "").split("-").map(Number);
  const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  return y && m && d ? ordinal(d) + " " + months[m - 1] + " " + y : "";
}

function hasDate(text, iso) {
  const t = norm(text);
  const h = humanDate(iso);
  return t.includes(norm(iso)) || t.includes(norm(h)) || t.includes(norm(h.replace(/(st|nd|rd|th)/, "")));
}

function hasSeven(text) {
  const t = String(text || "").toLowerCase();
  return /7\s*:?\s*00\s*a\.?m\.?/.test(t) || /7\s*a\.?m\.?/.test(t) || /seven\s*(o'?clock)?\s*(in the )?morning/.test(t);
}

async function openai(messages) {
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + OPENAI_API_KEY },
        body: JSON.stringify({ model: MODEL, temperature: 0.1, messages, tools: [lookupTool], tool_choice: "auto" })
      });
      const body = await r.json();
      if (!r.ok) throw new Error(r.status + " " + JSON.stringify(body).slice(0, 400));
      return body.choices[0].message;
    } catch (e) {
      last = e;
      await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    }
  }
  throw last;
}

async function lookup(args) {
  const query = { limit: 20 };
  const searchTerm = String(args.search_term || "").trim();
  let address = String(args.address || "").trim();
  let suburb = "";
  if (address) {
    const i = address.lastIndexOf(",");
    if (i >= 0) { suburb = address.slice(i + 1).trim(); address = address.slice(0, i).trim(); }
  }
  if (args.job_number) query.job_number = String(args.job_number);
  if (address) query.address = address;
  if (suburb) query.suburb = suburb;
  if (!address && searchTerm) {
    if (/\d/.test(searchTerm)) {
      const i = searchTerm.lastIndexOf(",");
      if (i >= 0) { query.address = searchTerm.slice(0, i).trim(); query.suburb = searchTerm.slice(i + 1).trim(); }
      else query.address = searchTerm;
    } else query.suburb = searchTerm;
  } else if (address && !suburb && searchTerm && norm(address) !== norm(searchTerm) && !/\d/.test(searchTerm)) {
    query.suburb = searchTerm;
  }

  const r = await fetch(LCM_LOOKUP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Kodi-Shared-Secret": LCM_LOOKUP_SECRET },
    body: JSON.stringify({ action: "searchJobs", query })
  });
  const text = await r.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch (_) {}
  if (r.status === 404 || body?.error?.code === "NO_MATCH") return { status: "not_found" };
  if (!r.ok) return { status: "lookup_error", http_status: r.status };
  const jobs = Array.isArray(body.jobs) ? body.jobs : [];
  if (!jobs.length) return { status: "not_found" };
  if (jobs.length > 1) return { status: "multiple_matches", matches: jobs.map(j => ({ job_number: j.job_number, address: [j.address,j.suburb].filter(Boolean).join(", ") })).slice(0,10) };
  const job = jobs[0];
  return {
    status: "single_match",
    job: { job_number: job.job_number || "", address: [job.address, job.suburb].filter(Boolean).join(", ") },
    activities: (Array.isArray(job.labour_activities) ? job.labour_activities : []).map(a => ({ name: norm(a.title) === "internal drains" ? "Drains" : (a.title || ""), calendar_date: a.calendar_date || null })).filter(a => a.name && a.calendar_date)
  };
}

async function runKodi(utterance) {
  const messages = [
    { role: "system", content: KODI_SYSTEM_PROMPT + "\n\nTEXT SIMULATION RULE: Do not call save_caller_info or hang_up. Do not write data." },
    { role: "user", content: "The call just connected. Start with the mandatory greeting." }
  ];
  const greeting = await openai(messages);
  messages.push(greeting);
  messages.push({ role: "user", content: utterance });
  const events = [];
  const turns = [];
  for (let round = 0; round < 6; round++) {
    const reply = await openai(messages);
    messages.push(reply);
    if (reply.tool_calls?.length) {
      for (const call of reply.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || "{}"); } catch (_) {}
        const result = await lookup(args);
        events.push({ args, result });
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
      continue;
    }
    turns.push(reply.content || "");
    if (!events.length && round < 2) {
      messages.push({ role: "user", content: "Please check the live LCM schedule now and give me the confirmed answer." });
      continue;
    }
    break;
  }
  return { greeting: greeting.content || "", answer: turns.join(" "), tool_events: events };
}

function activity(result, names) {
  const wanted = names.map(norm);
  return (result.activities || []).find(a => wanted.includes(norm(a.name)));
}

function judge(s, run) {
  const single = run.tool_events.map(e => e.result).find(r => r?.status === "single_match");
  const greeting = run.greeting.trim().startsWith("Hi, Local Concreting Mate, Kodi speaking. Can I ask who is calling?");
  if (!single) return { pass: false, score: 0, reason: "No single live LCM job returned." };
  const answer = run.answer;
  const lower = answer.toLowerCase();

  if (s.kind === "pods") {
    const a = activity(single, [s.activity]);
    if (!a) return { pass: false, score: 20, reason: "Expected Pod and Steel activity missing." };
    const dateOk = hasDate(answer, a.calendar_date);
    const sevenOk = hasSeven(answer);
    const lateOk = !s.later || /(cannot|can not|do not|must|need to be|by 7)/i.test(answer);
    const pass = greeting && dateOk && sevenOk && lateOk;
    return { pass, score: pass ? 100 : 60, expected: { activity: a.name, calendar_date: a.calendar_date, by: "07:00" }, checks: { greeting, dateOk, sevenOk, lateOk } };
  }

  const drains = activity(single, ["Drains", "Internal Drains"]);
  const sand = activity(single, ["Sand Up"]);
  if (s.kind === "sand_safe") {
    const sourceSafe = !!drains && !!sand && String(drains.calendar_date) < String(sand.calendar_date);
    const dateOk = !!sand && hasDate(answer, sand.calendar_date);
    const sevenOk = hasSeven(answer);
    const noRefusal = !/(cannot approve|does not let|callback|call back|not enough confirmed)/i.test(lower);
    const pass = greeting && sourceSafe && dateOk && sevenOk && noRefusal;
    return { pass, score: pass ? 100 : 50, expected: { drains: drains?.calendar_date || null, sand_up: sand?.calendar_date || null, by: "07:00", status: "SAFE" }, checks: { greeting, sourceSafe, dateOk, sevenOk, noRefusal } };
  }

  const sourceBlocked = !drains || !sand || String(drains.calendar_date) >= String(sand.calendar_date);
  const noSeven = !hasSeven(answer);
  const refused = /(cannot approve|does not let|callback|call back|not enough confirmed)/i.test(lower);
  const pass = greeting && sourceBlocked && noSeven && refused;
  return { pass, score: pass ? 100 : 50, expected: { drains: drains?.calendar_date || null, sand_up: sand?.calendar_date || null, status: "BLOCKED" }, checks: { greeting, sourceBlocked, noSeven, refused } };
}

async function main() {
  console.log("SUPPLIER_CURRENT_START " + JSON.stringify({ count: scenarios.length, model: MODEL, timestamp: new Date().toISOString() }));
  const results = [];
  for (const scenario of scenarios) {
    try {
      const run = await runKodi(scenario.utterance);
      const judgment = judge(scenario, run);
      const row = { scenario, ...run, judgment };
      results.push(row);
      console.log("SUPPLIER_CURRENT_RESULT " + JSON.stringify(row));
    } catch (e) {
      const row = { scenario, judgment: { pass: false, score: 0, reason: e.message } };
      results.push(row);
      console.log("SUPPLIER_CURRENT_RESULT " + JSON.stringify(row));
    }
  }
  const summary = {
    event: "SUPPLIER_CURRENT_SUMMARY",
    completed: results.length,
    passed: results.filter(r => r.judgment?.pass).length,
    failed: results.filter(r => !r.judgment?.pass).length,
    average_score: Math.round(results.reduce((sum, r) => sum + Number(r.judgment?.score || 0), 0) / results.length),
    timestamp: new Date().toISOString()
  };
  console.log("SUPPLIER_CURRENT_SUMMARY " + JSON.stringify(summary));
}

main().catch(e => { console.error("SUPPLIER_CURRENT_FATAL " + e.stack); process.exit(1); });
