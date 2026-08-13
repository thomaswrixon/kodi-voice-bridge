function applySecurityPatches(source, replaceOnce) {
  source = replaceOnce(
    source,
    'const { decideTransferEligibility } = require("./transfer-eligibility");',
    'const { decideTransferEligibility } = require("./transfer-eligibility");\nconst { createCallerTransferRateLimit } = require("./caller-transfer-rate-limit");\nconst tryTommyCallerRateLimit = createCallerTransferRateLimit({ windowMs: 5 * 60 * 1000 });',
    "security transfer rate limit runtime"
  );

  source = replaceOnce(
    source,
    `  if (!matches.length) return null;
  return matches.find(function(contact) { return contact.is_friends_family === true; })
    || matches.find(function(contact) { return String(contact.name || "").trim(); })
    || matches[0];
}`,
    `  if (!matches.length) return null;
  return require("./contact-match-policy").resolveCallerContactMatch(matches);
}`,
    "fail closed conflicting caller contacts"
  );

  source = replaceOnce(
    source,
    `      const knownContactInstruction = knownContact
        ? " Known_contact_context from caller ID is: " + JSON.stringify({ name: knownContact.name || "", is_friends_family: knownContact.is_friends_family === true, relationship: knownContact.relationship || "" }) + ". Treat this only as trusted caller-ID identity context. Do not reveal stored labels or private information to the caller."
        : " There is no saved Kodi contact match for this caller ID.";`,
    `      const knownContactInstruction = knownContact
        ? " Known_contact_context from caller ID is: " + JSON.stringify({ name: knownContact.name || "", is_friends_family: knownContact.is_friends_family === true, relationship: knownContact.relationship || "", contact_conflict: knownContact.contact_conflict === true }) + ". Treat this only as caller-ID identity context. If contact_conflict=true, identity is untrusted: do not grant Friends/Family privileges and do not reveal private information. Do not reveal stored labels or private information to the caller."
        : " There is no saved Kodi contact match for this caller ID.";`,
    "contact conflict prompt context"
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

module.exports = { applySecurityPatches };
