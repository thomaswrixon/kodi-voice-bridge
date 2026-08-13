const { decideTransferEligibility } = require("../transfer-eligibility");

const originalFetch = global.fetch;
global.fetch = async function gatedFetch(url, options = {}) {
  try {
    if (String(url).includes("/v1/chat/completions") && options.body) {
      const body = JSON.parse(options.body);
      const hasTryTool = Array.isArray(body.tools) && body.tools.some((tool) => tool?.function?.name === "try_tommy");
      if (hasTryTool && Array.isArray(body.messages)) {
        const systemText = body.messages.filter((m) => m.role === "system").map((m) => String(m.content || "")).join("\n");
        const isFriendsFamily = /known_contact_context\s*=\s*\{[^}]*"is_friends_family"\s*:\s*true/i.test(systemText);
        const callerText = body.messages
          .filter((m) => m.role === "user")
          .map((m) => String(m.content || ""))
          .filter((text) => !/^\[Caller /i.test(text))
          .join("\n");
        const gate = decideTransferEligibility({ callerText, isFriendsFamily });
        const gateMessage = gate.allowed
          ? `STRUCTURED_TRANSFER_GATE: ALLOWED (${gate.reason}). try_tommy is available. Before using it, obey all personal-call rules, including acknowledging matched email item/deadline first when recent_communication_context matches.`
          : `STRUCTURED_TRANSFER_GATE: BLOCKED (${gate.reason}). try_tommy is NOT available for this turn. Do not say you will try, call, reach, transfer to, or get Tommy. Continue listening, answer what you can, or record the useful callback/message instead.`;
        body.messages.splice(1, 0, { role: "system", content: gateMessage });
        if (!gate.allowed) {
          body.tools = body.tools.filter((tool) => tool?.function?.name !== "try_tommy");
        }
        options = { ...options, body: JSON.stringify(body) };
      }
    }
  } catch (error) {
    console.error("TRANSFER_GATE_WRAPPER_ERROR", error.message);
  }
  return originalFetch(url, options);
};

const personalModule = require("../personal-call-overrides");
const { PERSONAL_CALL_HARD_STOPS } = require("../personal-call-hard-stops");
personalModule.PERSONAL_CALL_OVERRIDES += PERSONAL_CALL_HARD_STOPS;
require("./run-personal-20-v2");
