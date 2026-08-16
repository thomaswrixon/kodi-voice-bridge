function applySecurityPatches(source, replaceOnce) {
  source = replaceOnce(
    source,
    'const { decideTransferEligibility } = require("./transfer-eligibility");',
    'const { decideTransferEligibility } = require("./transfer-eligibility");\nconst { createCallerTransferRateLimit } = require("./caller-transfer-rate-limit");\nconst tryTommyCallerRateLimit = createCallerTransferRateLimit({ windowMs: 5 * 60 * 1000 });',
    "transfer rate limit runtime"
  );

  source = replaceOnce(
    source,
    `              transcription: {
                model: "gpt-4o-mini-transcribe",
                language: "en",
                prompt: "Australian English phone call for Local Concreting Mate. Expected names include Tommy and Kodi.",
              },`,
    `              transcription: {
                model: "gpt-4o-mini-transcribe",
                language: "en",
              },`,
    "remove transcription prompt leakage"
  );

  source = replaceOnce(
    source,
    `              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 700,
              },`,
    `              turn_detection: {
                type: "semantic_vad",
                eagerness: "auto",
                create_response: true,
                interrupt_response: true,
              },`,
    "native semantic turn taking"
  );

  source = replaceOnce(
    source,
    `  let lastSavedCallerName = "";
  let lastSavedReason = "";
`,
    `  let lastSavedCallerName = "";
  let lastSavedReason = "";
  let initialGreetingStarted = false;
`,
    "startup response state"
  );

  source = replaceOnce(
    source,
    `      if (msg.type === "input_audio_buffer.speech_started" || msg.type === "input_audio_buffer.speech_stopped") {
        console.log("OpenAI event: " + msg.type);
      }
`,
    `      if (msg.type === "response.output_audio.delta" || msg.type === "response.audio.delta") {
        if (!initialGreetingStarted) {
          initialGreetingStarted = true;
          console.log("Kodi greeting started; microphone open for natural interruption");
        }
      }
      if (msg.type === "input_audio_buffer.speech_started" || msg.type === "input_audio_buffer.speech_stopped") {
        console.log("OpenAI event: " + msg.type);
      }
`,
    "open natural conversation when greeting starts"
  );

  source = replaceOnce(
    source,
    `      if (msg.type === "conversation.item.input_audio_transcription.completed") {
        transcript.push({ role: "user", content: msg.transcript });
      }
`,
    `      if (msg.type === "conversation.item.input_audio_transcription.completed") {
        const callerTranscript = String(msg.transcript || "").trim();
        const leakedTranscriptionPrompt = /Australian English phone call for Local Concreting Mate|Expected names include Tommy and Kodi/i.test(callerTranscript);
        if (callerTranscript && !leakedTranscriptionPrompt) {
          transcript.push({ role: "user", content: callerTranscript });
        } else if (leakedTranscriptionPrompt) {
          console.log("Discarded transcription guidance leakage");
        }
      }
`,
    "filter transcription guidance leakage"
  );

  source = replaceOnce(
    source,
    `      const recentCalls = direction === "inbound" ? await recentCallerHistoryPromise : [];
      const knownContact = direction === "inbound" ? await callerContactPromise : null;
      const recentCommunicationContext = direction === "inbound" ? await recentCommunicationPromise : [];
`,
    `      const withinGreetingDeadline = function(promise, fallback) {
        return Promise.race([
          promise,
          new Promise(function(resolve) {
            setTimeout(function() { resolve(fallback); }, 2000);
          }),
        ]);
      };
      const greetingContext = direction === "inbound"
        ? await Promise.all([
            withinGreetingDeadline(callerContactPromise, null),
            withinGreetingDeadline(recentCallerHistoryPromise, []),
            withinGreetingDeadline(recentCommunicationPromise, []),
          ])
        : [null, [], []];
      const knownContact = greetingContext[0];
      const recentCalls = !(knownContact && knownContact.is_owner === true) ? greetingContext[1] : [];
      const recentCommunicationContext = !(knownContact && knownContact.is_owner === true) ? greetingContext[2] : [];
`,
    "suppress polluted owner context"
  );

  source = replaceOnce(
    source,
    `      const recentCommunicationInstruction = recentCommunicationContext.length`,
    `      const currentSydneyDate = new Intl.DateTimeFormat("en-AU", {
        timeZone: "Australia/Sydney",
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(new Date());
      const currentSydneyDateInstruction = " current_sydney_date=" + currentSydneyDate + ".";
      const recentCommunicationInstruction = recentCommunicationContext.length`,
    "current Sydney date context"
  );

  source = replaceOnce(
    source,
    `+ recentHistoryInstruction + knownContactInstruction + recentCommunicationInstruction + resumeInstruction;`,
    `+ recentHistoryInstruction + knownContactInstruction + recentCommunicationInstruction + currentSydneyDateInstruction + resumeInstruction;`,
    "append current Sydney date context"
  );

  source = replaceOnce(
    source,
    `      recentCommunicationPromise = direction === "inbound"
        ? callerContactPromise.then(function(contact) { return lookupRecentCommunicationContext(contact); }).catch(function() { return []; })
        : Promise.resolve([]);`,
    `      recentCommunicationPromise = direction === "inbound"
        ? callerContactPromise.then(function(contact) {
            if (contact && (contact.contact_conflict === true || contact.is_owner === true)) return [];
            return lookupRecentCommunicationContext(contact);
          }).catch(function() { return []; })
        : Promise.resolve([]);`,
    "suppress communication context for untrusted or owner identity"
  );

  source = replaceOnce(
    source,
    `          const gate = decideTransferEligibility({
            callerText: userTranscriptText(transcript),
            isFriendsFamily: !!(knownContact && knownContact.is_friends_family === true),
          });`,
    `          const gate = knownContact && knownContact.is_owner === true
            ? { allowed: false, reason: "owner_self_transfer" }
            : decideTransferEligibility({
                callerText: userTranscriptText(transcript),
                isFriendsFamily: !!(knownContact && knownContact.is_friends_family === true),
                knownContactName: String((knownContact && knownContact.name) || ""),
              });`,
    "trusted identity and owner self-transfer gate"
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

  source = replaceOnce(
    source,
    `      for (const payload of audioBuffer) {
        openAiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload }));
      }
      audioBuffer = [];
`,
    `      // The greeting is a closed introduction. Discard anything heard before it
      // finishes so background voices are not transcribed or stored.
      audioBuffer = [];
      console.log("Discarded pre-greeting inbound audio");
`,
    "discard pre-greeting buffered audio"
  );

  source = replaceOnce(
    source,
    "If a callback is needed, read this local-format number back digit by digit, beginning with 0 rather than +61, and ask the caller to confirm it.",
    "If the caller accepts a callback, state the local-format caller-ID number clearly but briskly using natural grouping, then ask only whether there is anything else. Do not require confirmation. If the caller gives a different number, use that instead.",
    "caller ID callback acceptance"
  );

  source = replaceOnce(
    source,
    'description: "MANDATORY: Save caller name, reason, and callback number. You MUST call this on every inbound call before hang_up. Use the inbound caller ID as the default callback number when available, confirm it by reading it back digit by digit, and only ask for a different number if caller ID is unavailable or the caller requests another number.",',
    'description: "MANDATORY: Save caller name, reason, and callback number. You MUST call this on every inbound call before hang_up. Use inbound caller ID as the callback number when available. The caller does not need to confirm it: accepting the callback is sufficient. State it clearly and briskly, then ask whether there is anything else. Use a different number only if the caller supplies one.",',
    "callback tool acceptance"
  );

  source = replaceOnce(
    source,
    'callback_number_confirmed: { type: "boolean", description: "True only when Kodi read the number digit by digit and the caller explicitly confirmed it." },',
    'callback_number_confirmed: { type: "boolean", description: "Set true when the caller accepted a callback using the stated caller-ID number, or supplied a different callback number. A separate yes/no number confirmation is not required." },',
    "callback accepted field"
  );

  source = replaceOnce(
    source,
    `    if (msg.event === "media") {
      const payload = msg.media.payload;
      console.log("Twilio inbound media: payloadLength=" + (payload ? payload.length : 0));
      if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload }));
      } else {
        audioBuffer.push(payload);
      }
    }
`,
    `    if (msg.event === "media") {
      const payload = msg.media.payload;
      if (!initialGreetingStarted) {
        // Do not listen to, transcribe, or store voices before Kodi begins the introduction.
        return;
      }
      if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload }));
      } else {
        audioBuffer.push(payload);
      }
    }
`,
    "startup-only microphone gate"
  );

  source = replaceOnce(
    source,
    `        console.log("OpenAI event: response.output_audio.delta");
        console.log("Response audio base64 length: " + msg.delta.length + " bytes");
        try {
          const decodedPrefix = Buffer.from(msg.delta, "base64").slice(0, 6).toString("hex");
          console.log("Decoded audio prefix (hex): " + decodedPrefix);
        } catch (hexErr) {
          console.error("Failed to decode audio prefix:", hexErr.message);
        }
        console.log("Twilio media event: event=media streamSid=" + streamSid + " payloadLength=" + msg.delta.length);
`,
    "",
    "remove per-packet outbound audio logging"
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
