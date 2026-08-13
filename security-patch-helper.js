function applySecurityPatches(source, replaceOnce) {
  source = replaceOnce(
    source,
    'const { decideTransferEligibility } = require("./transfer-eligibility");',
    'const { decideTransferEligibility } = require("./transfer-eligibility");\nconst { createCallerTransferRateLimit } = require("./caller-transfer-rate-limit");\nconst tryTommyCallerRateLimit = createCallerTransferRateLimit({ windowMs: 5 * 60 * 1000 });',
    "transfer rate limit runtime"
  );

  source = replaceOnce(
    source,
    `      recentCommunicationPromise = direction === "inbound"
        ? callerContactPromise.then(function(contact) { return lookupRecentCommunicationContext(contact); }).catch(function() { return []; })
        : Promise.resolve([]);`,
    `      recentCommunicationPromise = direction === "inbound"
        ? callerContactPromise.then(function(contact) {
            if (contact && contact.contact_conflict === true) return [];
            return lookupRecentCommunicationContext(contact);
          }).catch(function() { return []; })
        : Promise.resolve([]);`,
    "suppress communication context for conflicted identity"
  );

  source = replaceOnce(
    source,
    `          const gate = decideTransferEligibility({
            callerText: userTranscriptText(transcript),
            isFriendsFamily: !!(knownContact && knownContact.is_friends_family === true),
          });`,
    `          const gate = decideTransferEligibility({
            callerText: userTranscriptText(transcript),
            isFriendsFamily: !!(knownContact && knownContact.is_friends_family === true),
            knownContactName: String((knownContact && knownContact.name) || ""),
          });`,
    "trusted number identity mismatch gate"
  );

  source = replaceOnce(
    source,
    `          let toolOutput = "";
          if (tryAttempted) {`,
    `          const rateLimitCheck = gate.allowed && !tryAttempted
            ? tryTommyCallerRateLimit.check(callerNumber)
            : { allowed: true };
          let toolOutput = "";
          if (tryAttempted) {`,
    "cross call transfer rate limit check"
  );

  source = replaceOnce(
    source,
    `          } else if (!gate.allowed) {
            toolOutput = "BLOCKED: This call is not eligible for an immediate transfer (" + gate.reason + "). Do not say you are trying Tommy. Continue helping the caller or record the callback/message.";
          } else {
            tryAttempted = true;`,
    `          } else if (!gate.allowed) {
            toolOutput = "BLOCKED: This call is not eligible for an immediate transfer (" + gate.reason + "). Do not say you are trying Tommy. Continue helping the caller or record the callback/message.";
          } else if (!rateLimitCheck.allowed) {
            toolOutput = "BLOCKED: Tommy was already attempted recently for this caller. Do not try again right now. Offer to take a message.";
          } else {
            tryTommyCallerRateLimit.record(callerNumber);
            tryAttempted = true;`,
    "enforce cross call transfer rate limit"
  );

  source = replaceOnce(
    source,
    `              tryTommySessions.delete(callSid);
              toolOutput = "NO_ANSWER: I could not get a hold of Tommy. Offer to take a message.";`,
    `              tryTommySessions.delete(callSid);
              tryTommyCallerRateLimit.clear(callerNumber);
              toolOutput = "NO_ANSWER: I could not get a hold of Tommy. Offer to take a message.";`,
    "clear rate limit when transfer could not start"
  );

  return source;
}

function installSecurityPatchWrapper() {
  const personalPatches = require("./personal-patch-helper");
  if (personalPatches.__validatedSecurityWrapperInstalled) return;
  const originalApplyPersonalPatches = personalPatches.applyPersonalPatches;
  personalPatches.applyPersonalPatches = function validatedPersonalPatches(source, replaceOnce) {
    return applySecurityPatches(originalApplyPersonalPatches(source, replaceOnce), replaceOnce);
  };
  personalPatches.__validatedSecurityWrapperInstalled = true;
}

module.exports = { applySecurityPatches, installSecurityPatchWrapper };
