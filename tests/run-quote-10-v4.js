const promptModule = require("../kodi-prompt");
const { hardenQuoteBasePrompt } = require("../quote-base-hardening");
promptModule.KODI_SYSTEM_PROMPT = hardenQuoteBasePrompt(promptModule.KODI_SYSTEM_PROMPT);

const fs = require("fs");
const path = require("path");
const Module = require("module");
const filename = path.join(__dirname, "run-quote-10-v2.js");
let source = fs.readFileSync(filename, "utf8");

const oldLine = '  const hist=s.recent?"Recent_call_history for this caller ID from the last 14 days is: "+JSON.stringify(s.recent)+".":"There is no recent_call_history for this caller ID in the last 14 days.";';
const newLine = `  const candidateCount = Array.isArray(s.recent) ? s.recent.length : 0;
  const structuredState = candidateCount > 1
    ? " STRUCTURED_RECENT_QUOTE_STATE: MULTIPLE. There are multiple plausible recent quote enquiries. If the caller says they are following up but does not identify which one, you MUST ask which recent quote they mean. You are forbidden from guessing or asking about only one candidate."
    : candidateCount === 1
      ? " STRUCTURED_RECENT_QUOTE_STATE: ONE. There is exactly one plausible recent quote enquiry. Identify it by work type plus location before asking what changed."
      : " STRUCTURED_RECENT_QUOTE_STATE: NONE.";
  const hist=s.recent?"Recent_call_history for this caller ID from the last 14 days is: "+JSON.stringify(s.recent)+"."+structuredState:"There is no recent_call_history for this caller ID in the last 14 days."+structuredState;`;

if (!source.includes(oldLine)) throw new Error("Could not inject structured recent quote state");
source = source.replace(oldLine, newLine);

const patched = new Module(filename, module);
patched.filename = filename;
patched.paths = Module._nodeModulePaths(__dirname);
patched._compile(source, filename);
