require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { KODI_SYSTEM_PROMPT } = require("../kodi-prompt");
const scenarios = require("./scenarios");
const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.KODI_TRAINING_MODEL || "gpt-5-mini";
const MAX_TURNS = Number(process.env.KODI_TRAINING_MAX_TURNS || 12);
if (!API_KEY) throw new Error("OPENAI_API_KEY is required");

async function complete(input, instructions) {
  const response = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` }, body: JSON.stringify({ model: MODEL, instructions, input }) });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data.output_text || "";
}

async function simulate(scenario) {
  const history = [];
  let toolIndex = 0;
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const caller = await complete(JSON.stringify({ scenario: scenario.caller, history }), "Act as the caller only. Produce the caller's next natural sentence. Do not explain or grade. Return [END] when the call is naturally finished.");
    if (caller.trim() === "[END]") break;
    history.push({ role: "caller", content: caller.trim() });
    const kodi = await complete(JSON.stringify({ history, available_tool_result: scenario.toolResults?.[toolIndex] || null }), KODI_SYSTEM_PROMPT + "\n\nThis is a text simulation. If you need lookup_job_schedule, output exactly TOOL: lookup_job_schedule followed by a JSON object. Otherwise output only Kodi's spoken reply.");
    history.push({ role: "kodi", content: kodi.trim() });
    if (kodi.startsWith("TOOL: lookup_job_schedule")) {
      history.push({ role: "tool", content: JSON.stringify(scenario.toolResults?.[toolIndex++] || { status: "lookup_error" }) });
      const afterTool = await complete(JSON.stringify({ history }), KODI_SYSTEM_PROMPT + "\n\nContinue from the tool result. Output only Kodi's next spoken reply.");
      history.push({ role: "kodi", content: afterTool.trim() });
    }
  }
  return history;
}

async function grade(scenario, history) {
  return complete(JSON.stringify({ scenario: scenario.id, expected: scenario.expected, transcript: history, pass_rules: ["Greeting and name handling follow production prompt", "Required tools are actually called", "No invented job information or dates", "Multiple matches trigger an address or job-number question", "Callback number is confirmed only after explicit confirmation", "Replies are concise and natural"] }), "You are Kodi's strict QA judge. Return valid JSON only with keys: pass (boolean), score (0-100), failures (array), suggested_prompt_change (string). Fail invented facts or missed required tools.");
}

(async () => {
  const results = [];
  for (const scenario of scenarios) {
    const transcript = await simulate(scenario);
    let evaluation;
    try { evaluation = JSON.parse(await grade(scenario, transcript)); } catch (error) { evaluation = { pass: false, score: 0, failures: ["Judge returned invalid JSON"], suggested_prompt_change: "", error: error.message }; }
    results.push({ id: scenario.id, transcript, evaluation });
    console.log(`${evaluation.pass ? "PASS" : "FAIL"} ${scenario.id} (${evaluation.score}/100)`);
  }
  const reportDir = path.join(__dirname, "reports");
  fs.mkdirSync(reportDir, { recursive: true });
  const file = path.join(reportDir, new Date().toISOString().replace(/[:.]/g, "-") + ".json");
  fs.writeFileSync(file, JSON.stringify({ generated_at: new Date().toISOString(), model: MODEL, results }, null, 2));
  const passed = results.filter(r => r.evaluation.pass).length;
  console.log(`\n${passed}/${results.length} scenarios passed. Report: ${file}`);
  process.exitCode = passed === results.length ? 0 : 1;
})().catch(error => { console.error(error); process.exitCode = 2; });
