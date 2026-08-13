function normalise(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function decideTransferEligibility({ callerText = "", isFriendsFamily = false } = {}) {
  const text = normalise(callerText);

  const isSales = /(sales offer|telemarket|marketing|switch(?:ing)? electricity|energy solutions|cold call|advertis)/i.test(text);
  if (isSales) return { allowed: false, reason: "sales_or_marketing" };

  const negativeUrgency = /(not an emergency|non[- ]?emergency|not urgent|no rush|safe for now|can wait|when he gets a chance|not sure if i need him right now|not sure.*need him.*right now|just let him know|i will try him later|i'll try him later)/i.test(text);

  // Explicit transfer intent includes natural family wording such as
  // "can you see if you can get Dad?" as well as direct "try Tommy" requests.
  const explicitTry = /(?:can|could|would|will) you (?:please )?(?:see if you can |see if you could )?(?:try|get|reach|call) (?:tommy|dad|him)|please (?:see if you can |see if you could )?(?:try|get|reach|call) (?:tommy|dad|him)|try to get (?:tommy|dad|him)|put me (?:straight )?through|can i speak (?:to|with) tommy|need to speak (?:to|with) tommy (?:now|urgently|immediately)/i.test(text);

  const urgentMatter = /(urgent|urgently|immediate|immediately|as soon as possible|asap|needs? (?:him|tommy|a parent) now|parent.*pickup|organise pickup|water pouring|still running.*water|active leak|before (?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d)(?:\s|:|\.)|until (?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d).*today|courier cutoff|cutoff is|cutoff.*(?:today|pm|am)|miss today's lodgement|miss today'?s lodgement)/i.test(text);

  const recognisedHighPriority = /(police|school|childcare|accountant|bas|truck parts|isuzu parts|starter motor|brake booster|water pouring|side fence)/i.test(text);

  // Explicit negative urgency always wins unless the caller later makes a clear
  // immediate-transfer request. A routine "call me today" is not explicitTry.
  if (negativeUrgency && !explicitTry) {
    return { allowed: false, reason: "caller_explicitly_non_urgent" };
  }

  // Confirmed friends/family may ask Kodi to try Tommy for an ordinary personal call.
  if (isFriendsFamily && explicitTry) {
    return { allowed: true, reason: "friends_family_explicit_request" };
  }

  // Non-family callers require a real priority reason, not merely claiming to know Tommy.
  if (urgentMatter && (recognisedHighPriority || explicitTry)) {
    return { allowed: true, reason: "time_critical_matter" };
  }

  return { allowed: false, reason: explicitTry ? "untrusted_nonurgent_transfer_request" : "no_immediate_transfer_need" };
}

module.exports = { decideTransferEligibility };
