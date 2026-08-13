const fs = require("fs");
const path = require("path");
const Module = require("module");
const promptModule = require("./kodi-prompt");
const { hardenQuoteBasePrompt } = require("./quote-base-hardening");

// Harden the base quote branches before the existing repeat-aware server appends
// the priority quote overrides.
promptModule.KODI_SYSTEM_PROMPT = hardenQuoteBasePrompt(promptModule.KODI_SYSTEM_PROMPT);

const filename = path.join(__dirname, "server-repeat-aware.js");
let source = fs.readFileSync(filename, "utf8");

const startMarker = "      const recentHistoryInstruction =";
const endMarker = "      const greetingPrompt =";
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);
if (start < 0 || end < 0) {
  throw new Error("Could not patch structured recent quote state into repeat-aware server");
}

const replacement = `      let recentQuoteCandidates = recentCalls.filter(function(item) {
        const summary = String(item.summary || "");
        if (/^Repeat follow-up on existing quote enquiry/i.test(summary)) return false;
        return /(quote request|request[^.]{0,80}quote|quote[^.]{0,80}request|crack repair[^.]{0,80}quote|concrete repair[^.]{0,80}quote)/i.test(summary);
      });
      if (!recentQuoteCandidates.length) {
        recentQuoteCandidates = recentCalls.filter(function(item) {
          return /^Repeat follow-up on existing quote enquiry/i.test(String(item.summary || ""));
        }).slice(0, 1);
      }
      const recentQuoteState = recentQuoteCandidates.length > 1
        ? " STRUCTURED_RECENT_QUOTE_STATE: MULTIPLE. There are multiple plausible recent quote enquiries. If the caller says they are following up but does not identify which one, you MUST ask which recent quote they mean. You are forbidden from guessing or asking about only one candidate."
        : recentQuoteCandidates.length === 1
          ? " STRUCTURED_RECENT_QUOTE_STATE: ONE. There is exactly one plausible recent quote enquiry. Identify it by work type plus location before asking what changed."
          : " STRUCTURED_RECENT_QUOTE_STATE: NONE.";
      const recentHistoryInstruction = recentCalls.length
        ? " Recent_call_history for this same caller ID from the last 14 days is: " + JSON.stringify(recentCalls) + ". Use this history only after the caller explains why they are calling. If their reason appears to be the same quote or repair enquiry, follow the structured recent quote state and confirm the exact enquiry before reusing prior details. If they confirm it is the same enquiry, do not repeat the prior questionnaire; ask only whether anything has changed. If it is different, ignore the old enquiry and handle this as new." + recentQuoteState
        : " There is no recent_call_history for this caller ID in the last 14 days." + recentQuoteState;
`;

source = source.slice(0, start) + replacement + source.slice(end);

const patchedModule = new Module(filename, module);
patchedModule.filename = filename;
patchedModule.paths = Module._nodeModulePaths(__dirname);
patchedModule._compile(source, filename);
