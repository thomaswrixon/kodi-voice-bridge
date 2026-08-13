const promptModule = require("../kodi-prompt");
const { hardenQuoteBasePrompt } = require("../quote-base-hardening");
promptModule.KODI_SYSTEM_PROMPT = hardenQuoteBasePrompt(promptModule.KODI_SYSTEM_PROMPT);
require("./run-quote-10-v2");
