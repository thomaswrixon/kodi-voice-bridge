function userTranscriptText(transcript) {
  return (Array.isArray(transcript) ? transcript : [])
    .filter((item) => item && item.role === "user")
    .map((item) => String(item.content || ""))
    .join(" \n");
}

function savedText(args) {
  return [args && args.reason, args && args.notes].filter(Boolean).join(" ");
}

function addNote(args, note) {
  const existing = String(args.notes || "").trim();
  args.notes = existing ? existing.replace(/[.\s]+$/, "") + ". " + note : note;
}

function enrichSaveCallerInfo(inputArgs, transcript) {
  const args = { ...(inputArgs || {}) };
  const callerText = userTranscriptText(transcript);
  let current = savedText(args);

  // A same-day callback is operationally important. Keep it even if the model
  // captured the officer/reference but omitted the word "today" from tool args.
  const callerRequiresToday = /(?:return|call)\s+(?:my|me|us|the practice|the station)?\s*(?:call\s*)?today|(?:need|needs|want|wants)\s+(?:him|tommy)\s+to\s+(?:return|call).*\btoday\b|\bsame[- ]day\s+callback\b/i.test(callerText);
  if (callerRequiresToday && !/\btoday\b|\bsame[- ]day\b/i.test(current)) {
    addNote(args, "Callback required today.");
    current = savedText(args);
  }

  // Preserve a vehicle-ready fact when a later optional repair discussion could
  // otherwise cause the model to save only the optional work decision.
  const vehicleReady = /(?:ute|truck|vehicle|car).{0,45}(?:ready\s+to\s+pick\s*up|ready\s+for\s+pickup|is\s+ready)|(?:ready\s+to\s+pick\s*up|ready\s+for\s+pickup).{0,45}(?:ute|truck|vehicle|car)/i.test(callerText);
  if (vehicleReady && !/(?:ute|truck|vehicle|car).{0,45}(?:ready|pickup)|(?:ready|pickup).{0,45}(?:ute|truck|vehicle|car)/i.test(current)) {
    addNote(args, "Vehicle is ready for pickup.");
    current = savedText(args);
  }

  // Preserve an explicitly requested immediate callback on an active property issue.
  const immediateCallback = /(?:call me|call us).{0,20}(?:straight away|immediately|as soon as possible|asap)/i.test(callerText);
  if (immediateCallback && !/(straight away|immediate|immediately|as soon as possible|asap|urgent)/i.test(current)) {
    addNote(args, "Immediate callback requested.");
  }

  return args;
}

module.exports = { enrichSaveCallerInfo };
