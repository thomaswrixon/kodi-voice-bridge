function hardenQuoteBasePrompt(prompt) {
  let out = String(prompt || "");

  const oldRepeat = '- If recent_call_history is supplied for the same caller ID and it appears to contain a matching quote or repair enquiry, follow the repeat-caller rules first. Confirm whether they are following up on that same enquiry. If yes, do not repeat the quote questionnaire; ask only whether anything has changed and collect only changed or missing details. If it is a different request, ignore the old enquiry and treat this as a new quote.';
  const newRepeat = '- If recent_call_history is supplied, REPEAT QUOTE IDENTIFICATION TAKES PRIORITY before any question about changes. If there is one plausible prior quote, identify it by work type plus location and get confirmation. If there are multiple plausible prior quotes and the caller has not identified which one, ask which quote they mean and NEVER guess one. Only after one specific prior quote is identified may you ask exactly: "Has anything changed since you last called?" If nothing changed, do not repeat the prior questionnaire. If something changed, collect and acknowledge only that changed item and do not restate unchanged old details.';

  const oldStandard = '- STANDARD RESIDENTIAL QUOTE: Collect the type of work, property suburb or full address, rough size if known, desired finish if relevant, what is currently there or what may need removal, any access or unusual site issue they mention, and their preferred timeframe. Suitable work types include driveway, shed slab, house slab, paths, alfresco, pool surrounds, crossover, kerbing, or other concrete work.';
  const newStandard = '- STANDARD RESIDENTIAL QUOTE: Use this flow ONLY for a genuinely new residential quote that is NOT an existing-job variation and NOT a builder/new-build quote. Collect the type of work, property suburb or full address, rough size if known, desired finish if relevant, what is currently there or what may need removal, any access or unusual site issue they mention, and their preferred timeframe. Suitable work types include driveway, shed slab, paths, alfresco, pool surrounds, crossover, kerbing, or other concrete work.';

  const oldVariation = '- EXISTING LCM CUSTOMER ASKING FOR EXTRA WORK OR A VARIATION: Treat this as a quote/variation request, not as a normal schedule enquiry. If needed, use lookup_job_schedule only to identify the existing job by address or job number. Then collect the extra work requested, rough size/finish if relevant, and any timing preference. Do not quote a price or promise when the extra work can be done.';
  const newVariation = '- EXISTING LCM CUSTOMER ASKING FOR EXTRA WORK OR A VARIATION: This branch OVERRIDES the standard residential quote flow. Treat it as a short quote/variation request, not a normal schedule enquiry. If needed, use lookup_job_schedule only to identify the existing job by address or job number. Collect ONLY the specific purpose/type of the extra concrete, rough size if not already stated, finish if relevant, and timing preference. The PURPOSE/TYPE is mandatory when the caller has only said something vague such as "extra concrete out the back". In that case, after identifying the existing job, ask what the extra concrete is for (for example patio, path, slab or other area) BEFORE asking about finish or timing. NEVER ask what is currently there, what needs removal, access, steepness, pumps, or unusual site conditions unless the caller independently raises that subject. Once the purpose/type, size, finish if relevant, and timing preference are known, summarise and move to callback confirmation.';

  for (const [oldText, newText, label] of [
    [oldRepeat, newRepeat, 'repeat'],
    [oldStandard, newStandard, 'standard'],
    [oldVariation, newVariation, 'variation']
  ]) {
    if (!out.includes(oldText)) throw new Error('Quote base hardening could not find ' + label + ' rule');
    out = out.replace(oldText, newText);
  }

  return out;
}

module.exports = { hardenQuoteBasePrompt };
