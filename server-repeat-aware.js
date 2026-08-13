require("./supplier-guidance-preload");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const promptModule = require("./kodi-prompt");
const { KODI_CONVERSATIONAL_PROMPT } = require("./kodi-conversational-prompt");
promptModule.KODI_SYSTEM_PROMPT = KODI_CONVERSATIONAL_PROMPT;

function replaceOnce(source, oldText, newText, label) {
  const first = source.indexOf(oldText);
  if (first < 0 || source.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error("Repeat-caller patch failed at " + label);
  }
  return source.replace(oldText, newText);
}

const filename = path.join(__dirname, "server.js");
let source = fs.readFileSync(filename, "utf8");

source = replaceOnce(
  source,
  `function toAustralianLocalNumber(value) {
  const raw = String(value || "").trim();
  const compact = raw.replace(/[^+\\d]/g, "");
  if (/^\\+61\\d+$/.test(compact)) return "0" + compact.slice(3);
  if (/^61\\d+$/.test(compact)) return "0" + compact.slice(2);
  return compact || raw;
}

async function lookupJobSchedule(args) {`,
  `function toAustralianLocalNumber(value) {
  const raw = String(value || "").trim();
  const compact = raw.replace(/[^+\\d]/g, "");
  if (/^\\+61\\d+$/.test(compact)) return "0" + compact.slice(3);
  if (/^61\\d+$/.test(compact)) return "0" + compact.slice(2);
  return compact || raw;
}

function normaliseCallerNumber(value) {
  return toAustralianLocalNumber(value).replace(/\\D/g, "");
}

async function lookupRecentCallerHistory(number) {
  const target = normaliseCallerNumber(number);
  if (!BASE44_API_KEY || !BASE44_API_BASE || !target || target === "unknown") return [];

  try {
    const response = await fetch(BASE44_API_BASE + "?sort=-created_date&limit=200", {
      headers: { "api_key": BASE44_API_KEY },
    });
    if (!response.ok) throw new Error("Call history lookup failed with HTTP " + response.status);

    const data = await response.json();
    const items = Array.isArray(data) ? data : (data.items || []);
    const cutoff = Date.now() - (14 * 24 * 60 * 60 * 1000);

    return items
      .filter(function(item) {
        return normaliseCallerNumber(item.caller_number) === target;
      })
      .filter(function(item) {
        const timestamp = Date.parse(item.created_date || item.updated_date || "");
        return Number.isFinite(timestamp) && timestamp >= cutoff;
      })
      .sort(function(a, b) {
        return Date.parse(b.created_date || b.updated_date || 0) - Date.parse(a.created_date || a.updated_date || 0);
      })
      .slice(0, 5)
      .map(function(item) {
        return {
          call_log_id: item.id || "",
          called_at: item.created_date || item.updated_date || "",
          caller_name: item.from_name || "",
          summary: String(item.message || "").slice(0, 500),
        };
      });
  } catch (error) {
    console.error("Recent caller history lookup error:", error.message);
    return [];
  }
}

async function lookupJobSchedule(args) {`,
  "history helper"
);

source = replaceOnce(
  source,
  `  const transcript = [];
  let savedByTool = false;
`,
  `  const transcript = [];
  let savedByTool = false;
  let closingSpoken = false;
  let recentCallerHistoryPromise = Promise.resolve([]);
`,
  "history and closing state"
);

source = replaceOnce(
  source,
  `    openAiWs.on("open", () => {`,
  `    openAiWs.on("open", async () => {`,
  "async open handler"
);

source = replaceOnce(
  source,
  `      const localCallerNumber = toAustralianLocalNumber(callerNumber);
      const greetingPrompt = direction === "outbound"
        ? "The call just connected to Tommy. Give him the morning briefing greeting."
        : "The call just connected. The inbound caller ID callback number is " + localCallerNumber + ". Use this number as the default callback number. Do not ask the caller to provide their phone number unless caller ID is unavailable/private/unknown or they want to use a different number. If a callback is needed, read this local-format number back digit by digit, beginning with 0 rather than +61, and ask the caller to confirm it. Start with your greeting now.";
`,
  `      const localCallerNumber = toAustralianLocalNumber(callerNumber);
      const recentCalls = direction === "inbound" ? await recentCallerHistoryPromise : [];
      const recentHistoryInstruction = recentCalls.length
        ? " Recent_call_history for this same caller ID from the last 14 days is: " + JSON.stringify(recentCalls) + ". Use this history only after the caller explains why they are calling. If their reason appears to be the same quote or repair enquiry, confirm that it is the same enquiry before reusing the prior details. When a suburb or address is present in the prior summary, include that location in the confirmation question, for example: Is this the same driveway crack repair job in Belmont North? If they confirm it is the same enquiry, do not repeat the prior questionnaire; ask only whether anything has changed. If it is different, ignore the old enquiry and handle this as new."
        : " There is no recent_call_history for this caller ID in the last 14 days.";
      const greetingPrompt = direction === "outbound"
        ? "The call just connected to Tommy. Give him the morning briefing greeting."
        : "The call just connected. The inbound caller ID callback number is " + localCallerNumber + ". Use this number as the default callback number. Do not ask the caller to provide their phone number unless caller ID is unavailable/private/unknown or they want to use a different number. If a callback is needed, read this local-format number back digit by digit, beginning with 0 rather than +61, and ask the caller to confirm it." + recentHistoryInstruction + " Start with your greeting now.";
`,
  "greeting history context"
);

source = replaceOnce(
  source,
  `      if (msg.type === "response.output_audio_transcript.done") {
        transcript.push({ role: "assistant", content: msg.transcript });
      }
`,
  `      if (msg.type === "response.output_audio_transcript.done") {
        transcript.push({ role: "assistant", content: msg.transcript });
        const spoken = String(msg.transcript || "").toLowerCase();
        if (/(have a good day|have a great day|thanks for calling|thank you for calling|passed that on to tommy|tommy will get back to you)/.test(spoken)) {
          closingSpoken = true;
        }
      }
`,
  "closing transcript detection"
);

source = replaceOnce(
  source,
  `        if (fnName === "hang_up") {
          console.log("Hang up requested by AI");
          openAiWs.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: msg.call_id,
              output: "Call ended.",
            },
          }));
          setTimeout(function() {
            hangUpCall();
            if (openAiWs) openAiWs.close();
          }, 1500);
        }
`,
  `        if (fnName === "hang_up") {
          console.log("Hang up requested by AI");
          if (!closingSpoken) {
            console.log("Hang up blocked until closing sentence is spoken");
            openAiWs.send(JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: msg.call_id,
                output: "Do not hang up yet. First say a natural closing sentence such as: Thanks, I have passed that on to Tommy. Have a good day. After that sentence has been fully spoken, call hang_up again.",
              },
            }));
            openAiWs.send(JSON.stringify({ type: "response.create" }));
          } else {
            openAiWs.send(JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: msg.call_id,
                output: "Call ended.",
              },
            }));
            setTimeout(function() {
              hangUpCall();
              if (openAiWs) openAiWs.close();
            }, 3000);
          }
        }
`,
  "guarded hang up"
);

source = replaceOnce(
  source,
  `      console.log("Stream started: " + streamSid + " direction: " + direction + " from: " + callerNumber);
      connectToOpenAI();
`,
  `      console.log("Stream started: " + streamSid + " direction: " + direction + " from: " + callerNumber);
      recentCallerHistoryPromise = direction === "inbound"
        ? lookupRecentCallerHistory(callerNumber)
        : Promise.resolve([]);
      connectToOpenAI();
`,
  "start history lookup"
);

const patchedModule = new Module(filename, module);
patchedModule.filename = filename;
patchedModule.paths = Module._nodeModulePaths(__dirname);
patchedModule._compile(source, filename);
