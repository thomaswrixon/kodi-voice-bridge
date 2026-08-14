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
                eagerness: "low",
                create_response: false,
                interrupt_response: false,
              },`,
    "single startup response gate"
  );

  source = replaceOnce(
    source,
    `  let lastSavedCallerName = "";
  let lastSavedReason = "";
`,
    `  let lastSavedCallerName = "";
  let lastSavedReason = "";
  let initialGreetingComplete = false;
  let pendingCallerTurnDuringGreeting = false;
  let responseActive = false;
`,
    "startup response state"
  );

  source = replaceOnce(
    source,
    `      if (msg.type === "input_audio_buffer.speech_started" || msg.type === "input_audio_buffer.speech_stopped") {
        console.log("OpenAI event: " + msg.type);
      }
`,
    `      if (msg.type === "response.created") {
        responseActive = true;
      }
      if (msg.type === "response.done") {
        responseActive = false;
      }
      if (msg.type === "input_audio_buffer.speech_started" || msg.type === "input_audio_buffer.speech_stopped") {
        console.log("OpenAI event: " + msg.type);
        if (msg.type === "input_audio_buffer.speech_started") {
          if (streamSid) {
            twilioWs.send(JSON.stringify({ event: "clear", streamSid: streamSid }));
            console.log("Cleared queued Kodi audio so caller has the floor");
          }
          if (responseActive) {
            pendingCallerTurnDuringGreeting = true;
            openAiWs.send(JSON.stringify({ type: "response.cancel" }));
            console.log("Cancelled active Kodi response for caller interruption");
          }
        }
        if (msg.type === "input_audio_buffer.speech_stopped") {
          if (responseActive) {
            pendingCallerTurnDuringGreeting = true;
          } else {
            responseActive = true;
            console.log("Creating one response for completed caller turn");
            openAiWs.send(JSON.stringify({ type: "response.create" }));
          }
        }
      }
`,
    "remember caller turn during greeting"
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
    `      if (msg.type === "response.function_call_arguments.done") {`,
    `      if (msg.type === "response.done") {
        if (!initialGreetingComplete) initialGreetingComplete = true;
        if (pendingCallerTurnDuringGreeting) {
          pendingCallerTurnDuringGreeting = false;
          responseActive = true;
          console.log("Creating deferred response for interrupted caller turn");
          openAiWs.send(JSON.stringify({ type: "response.create" }));
        }
      }

      if (msg.type === "response.function_call_arguments.done") {`,
    "enable normal responses after greeting"
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
            setTimeout(function() { resolve(fallback); }, 800);
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
      if (!initialGreetingComplete) {
        // Do not listen, transcribe, interrupt, or log voices before Kodi's intro ends.
        return;
      }
      console.log("Twilio inbound media: payloadLength=" + (payload ? payload.length : 0));
      if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload }));
      } else {
        audioBuffer.push(payload);
      }
    }
`,
    "open microphone after greeting"
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
