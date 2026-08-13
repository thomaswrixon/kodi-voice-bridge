function applyPersonalPatches(source, replaceOnce) {
  source = replaceOnce(
    source,
    'const BASE44_CONTACTS_BASE = BASE44_ENTITIES_BASE + "/Contact";',
    'const BASE44_CONTACTS_BASE = BASE44_ENTITIES_BASE + "/Contact";\nconst BASE44_COMMUNICATIONS_BASE = BASE44_ENTITIES_BASE + "/Communication";\nconst BASE44_TRANSCRIPT_EMAIL_URL = "https://base44.app/api/apps/" + BASE44_APP_ID + "/functions/callTranscriptEmail";\nconst KODI_TRANSCRIPT_EMAIL_SECRET = process.env.KODI_TRANSCRIPT_EMAIL_SECRET || "";\nconst TOMMY_MOBILE = process.env.TOMMY_MOBILE || "+61428049389";\nconst { decideTransferEligibility } = require("./transfer-eligibility");\nconst { enrichSaveCallerInfo } = require("./personal-save-enrichment");\nconst tryTommySessions = new Map();',
    "personal runtime constants"
  );

  const helpers = `function userTranscriptText(turns) {
  return (Array.isArray(turns) ? turns : [])
    .filter(function(item) { return item && item.role === "user"; })
    .map(function(item) { return String(item.content || ""); })
    .join(" ");
}

async function lookupRecentCommunicationContext(contact) {
  if (!BASE44_API_KEY || !BASE44_COMMUNICATIONS_BASE || !contact) return [];
  const contactEmail = String(contact.email || "").trim().toLowerCase();
  const contactId = String(contact.id || "").trim();
  if (!contactEmail && !contactId) return [];
  try {
    const response = await fetch(BASE44_COMMUNICATIONS_BASE + "?sort=-received_at&limit=120", {
      headers: { "api_key": BASE44_API_KEY },
    });
    if (!response.ok) throw new Error("Communication lookup failed with HTTP " + response.status);
    const data = await response.json();
    const items = Array.isArray(data) ? data : (data.items || []);
    const cutoff = Date.now() - (14 * 24 * 60 * 60 * 1000);
    return items
      .filter(function(item) { return item && item.source === "outlook_email"; })
      .filter(function(item) {
        const byId = contactId && String(item.related_contact_id || "") === contactId;
        const byEmail = contactEmail && String(item.sender_contact || "").trim().toLowerCase() === contactEmail;
        return byId || byEmail;
      })
      .filter(function(item) {
        const ts = Date.parse(item.received_at || item.created_date || "");
        return !Number.isFinite(ts) || ts >= cutoff;
      })
      .slice(0, 5)
      .map(function(item) {
        return {
          source: "outlook_email",
          received_at: item.received_at || "",
          subject: String(item.subject || "").slice(0, 240),
          summary: String(item.ai_summary || item.body_preview || "").slice(0, 700),
          response_deadline: item.response_deadline || "",
        };
      });
  } catch (error) {
    console.error("Recent communication lookup error:", error.message);
    return [];
  }
}

async function sendTranscriptEmail(payload) {
  if (!KODI_TRANSCRIPT_EMAIL_SECRET) {
    console.error("Transcript email skipped: KODI_TRANSCRIPT_EMAIL_SECRET missing");
    return false;
  }
  try {
    const response = await fetch(BASE44_TRANSCRIPT_EMAIL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api_key": BASE44_API_KEY,
        "x-kodi-transcript-secret": KODI_TRANSCRIPT_EMAIL_SECRET,
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) {
      console.error("Transcript email failed: HTTP " + response.status + " " + text.slice(0, 300));
      return false;
    }
    console.log("Transcript email sent for call " + String(payload.call_sid || "unknown"));
    return true;
  } catch (error) {
    console.error("Transcript email error:", error.message);
    return false;
  }
}

async function saveAnsweredTransferCall(callSid, state) {
  const transcriptForSave = Array.isArray(state.transcript) ? state.transcript.slice() : [];
  transcriptForSave.push({ role: "system_note", content: "Caller was connected to Tommy. The direct caller-to-Tommy conversation after connection was not transcribed by Kodi." });
  if (!state.savedByTool) {
    try {
      const response = await fetch(BASE44_API_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json", "api_key": BASE44_API_KEY },
        body: JSON.stringify({
          call_sid: callSid || "",
          caller_number: state.callerNumber || "unknown",
          from_name: state.callerName || "",
          message: "Transferred to Tommy - answered" + (state.reason ? " - " + state.reason : ""),
          channel: "call",
          status: "completed",
          history: JSON.stringify(transcriptForSave),
          briefed: false,
        }),
      });
      if (!response.ok) console.error("Answered transfer CallLog save failed HTTP " + response.status);
    } catch (error) {
      console.error("Answered transfer CallLog save error:", error.message);
    }
  }
  await sendTranscriptEmail({
    call_sid: callSid || "",
    caller_number: state.callerNumber || "unknown",
    caller_name: state.callerName || "",
    completed_at: new Date().toISOString(),
    transfer_outcome: "Connected to Tommy",
    transcript: transcriptForSave,
  });
}

`;

  source = replaceOnce(
    source,
    "async function lookupJobSchedule(args) {",
    helpers + "async function lookupJobSchedule(args) {",
    "personal helpers"
  );

  const transferRoutes = `app.post("/try-tommy-result", async (req, res) => {
  const callSid = String(req.body.CallSid || "");
  const dialStatus = String(req.body.DialCallStatus || "").toLowerCase();
  const state = tryTommySessions.get(callSid) || null;
  console.log("Try Tommy result: call=" + callSid + " status=" + dialStatus);

  if (dialStatus === "completed" || dialStatus === "answered") {
    if (state) {
      tryTommySessions.delete(callSid);
      await saveAnsweredTransferCall(callSid, state);
    }
    const vr = new twilio.twiml.VoiceResponse();
    vr.hangup();
    res.type("text/xml").send(vr.toString());
    return;
  }

  const caller = state && state.callerNumber ? state.callerNumber : (req.body.From || "unknown");
  if (state) {
    state.transferOutcome = dialStatus || "no-answer";
    tryTommySessions.set(callSid, state);
  }
  const wsUrl = BASE_URL.replace("https://", "wss://").replace("http://", "ws://");
  const vr = new twilio.twiml.VoiceResponse();
  const connect = vr.connect();
  const stream = connect.stream({ url: wsUrl + "/stream" });
  stream.parameter({ name: "callSid", value: callSid });
  stream.parameter({ name: "callerNumber", value: caller });
  stream.parameter({ name: "direction", value: "inbound" });
  stream.parameter({ name: "resumeReason", value: "NO_ANSWER" });
  res.type("text/xml").send(vr.toString());
});

`;

  source = replaceOnce(
    source,
    'const path = require("path");',
    transferRoutes + 'const path = require("path");',
    "try Tommy result route"
  );

  source = replaceOnce(
    source,
    `  let callerContactPromise = Promise.resolve(null);
`,
    `  let callerContactPromise = Promise.resolve(null);
  let recentCommunicationPromise = Promise.resolve([]);
  let transferInProgress = false;
  let tryAttempted = false;
  let resumeReason = "";
  let resumeState = null;
  let transferOutcome = "";
  let emailSent = false;
  let lastSavedCallerName = "";
  let lastSavedReason = "";
`,
    "personal connection state"
  );

  const localEmailHelper = `  async function sendTranscriptEmailOnce(outcome) {
    if (emailSent || transferInProgress || !transcript.length) return;
    emailSent = true;
    await sendTranscriptEmail({
      call_sid: callSid || "",
      caller_number: callerNumber || "unknown",
      caller_name: lastSavedCallerName || (resumeState && resumeState.callerName) || "",
      completed_at: new Date().toISOString(),
      transfer_outcome: outcome || transferOutcome || "Completed",
      transcript: transcript,
    });
  }

`;
  source = replaceOnce(
    source,
    "  function connectToOpenAI() {",
    localEmailHelper + "  function connectToOpenAI() {",
    "transcript email helper"
  );

  source = replaceOnce(
    source,
    `      const knownContact = direction === "inbound" ? await callerContactPromise : null;
`,
    `      const knownContact = direction === "inbound" ? await callerContactPromise : null;
      const recentCommunicationContext = direction === "inbound" ? await recentCommunicationPromise : [];
`,
    "communication lookup result"
  );

  source = replaceOnce(
    source,
    `      const greetingPrompt = direction === "outbound"`,
    `      const recentCommunicationInstruction = recentCommunicationContext.length
        ? " Recent_communication_context for this matched caller is: " + JSON.stringify(recentCommunicationContext) + ". Use it only if the caller's stated reason clearly matches it. Never reveal unrelated communications."
        : " There is no matching recent_communication_context for this caller.";
      const resumeInstruction = resumeReason === "NO_ANSWER"
        ? " This is a resumed call after one attempt to reach Tommy returned NO_ANSWER. Do not greet again and never try Tommy a second time. Prior conversation before the attempt was: " + JSON.stringify(transcript.slice(-24)) + ". Your first spoken sentence now must be: I could not get a hold of him, but I can take a message if you want."
        : " Start with your greeting now.";
      const greetingPrompt = direction === "outbound"`,
    "personal greeting instructions"
  );

  source = replaceOnce(
    source,
    `+ recentHistoryInstruction + knownContactInstruction + " Start with your greeting now.";`,
    `+ recentHistoryInstruction + knownContactInstruction + recentCommunicationInstruction + resumeInstruction;`,
    "append communication and resume context"
  );

  const tryTool = `            {
              type: "function",
              name: "try_tommy",
              description: "Attempt to reach Tommy immediately. Use only for a confirmed Friends/Family caller who explicitly asks, or a genuinely urgent/time-critical caller under the personal-call rules. The server enforces eligibility and permits one attempt maximum.",
              parameters: {
                type: "object",
                properties: {
                  reason: { type: "string", description: "Short factual reason Tommy is needed now, including any deadline or urgency" },
                  caller_name: { type: "string", description: "Caller name if known" },
                },
                required: ["reason"],
              },
            },
`;
  source = replaceOnce(
    source,
    `            {
              type: "function",
              name: "hang_up",`,
    tryTool + `            {
              type: "function",
              name: "hang_up",`,
    "try Tommy tool"
  );

  source = replaceOnce(
    source,
    `        try { fnArgs = JSON.parse(msg.arguments || "{}"); } catch (err) {}

        if (fnName === "lookup_job_schedule") {`,
    `        try { fnArgs = JSON.parse(msg.arguments || "{}"); } catch (err) {}
        if (fnName === "save_caller_info") {
          fnArgs = enrichSaveCallerInfo(fnArgs, transcript);
          lastSavedCallerName = String(fnArgs.name || "");
          lastSavedReason = String(fnArgs.reason || "");
        }

        if (fnName === "try_tommy") {
          const knownContact = await callerContactPromise.catch(function() { return null; });
          const gate = decideTransferEligibility({
            callerText: userTranscriptText(transcript),
            isFriendsFamily: !!(knownContact && knownContact.is_friends_family === true),
          });
          let toolOutput = "";
          if (tryAttempted) {
            toolOutput = "NO_ANSWER: Tommy has already been tried once on this call. Do not try again. Offer to take a message.";
          } else if (!gate.allowed) {
            toolOutput = "BLOCKED: This call is not eligible for an immediate transfer (" + gate.reason + "). Do not say you are trying Tommy. Continue helping the caller or record the callback/message.";
          } else {
            tryAttempted = true;
            transferInProgress = true;
            transferOutcome = "ATTEMPTING";
            const state = {
              callerNumber: callerNumber || "unknown",
              callerName: String(fnArgs.caller_name || (knownContact && knownContact.name) || ""),
              reason: String(fnArgs.reason || ""),
              transcript: transcript.slice(),
              savedByTool: savedByTool,
              transferOutcome: "ATTEMPTING",
              createdAt: Date.now(),
            };
            tryTommySessions.set(callSid, state);
            setTimeout(function() {
              const current = tryTommySessions.get(callSid);
              if (current && Date.now() - Number(current.createdAt || 0) > 15 * 60 * 1000) tryTommySessions.delete(callSid);
            }, 16 * 60 * 1000);
            try {
              const vr = new twilio.twiml.VoiceResponse();
              const dial = vr.dial({
                timeout: 18,
                answerOnBridge: true,
                action: BASE_URL + "/try-tommy-result",
                method: "POST",
              });
              dial.number(TOMMY_MOBILE);
              await twilioClient.calls(callSid).update({ twiml: vr.toString() });
              console.log("Try Tommy started for call " + callSid + " reason=" + gate.reason);
            } catch (transferError) {
              console.error("Try Tommy failed to start:", transferError.message);
              transferInProgress = false;
              transferOutcome = "NO_ANSWER";
              tryTommySessions.delete(callSid);
              toolOutput = "NO_ANSWER: I could not get a hold of Tommy. Offer to take a message.";
            }
          }
          if (toolOutput && openAiWs && openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(JSON.stringify({
              type: "conversation.item.create",
              item: { type: "function_call_output", call_id: msg.call_id, output: toolOutput },
            }));
            openAiWs.send(JSON.stringify({ type: "response.create" }));
          }
        }

        if (fnName === "lookup_job_schedule") {`,
    "try Tommy handler and save enrichment"
  );

  source = replaceOnce(
    source,
    `    openAiWs.on("close", (code, reason) => {
      console.log("OpenAI WS closed - code: " + code + ", reason: " + (reason ? reason.slice(0, 100) : "none"));
      if (transcript.length > 0 && callerNumber && !savedByTool) {`,
    `    openAiWs.on("close", (code, reason) => {
      console.log("OpenAI WS closed - code: " + code + ", reason: " + (reason ? reason.slice(0, 100) : "none"));
      if (transferInProgress) {
        console.log("OpenAI close caused by Try Tommy transfer; deferring save/email");
        return;
      }
      sendTranscriptEmailOnce(transferOutcome || "Completed").catch(function(error) { console.error("Transcript email finalizer error:", error.message); });
      if (transcript.length > 0 && callerNumber && !savedByTool) {`,
    "skip transfer close and email final transcript"
  );

  source = replaceOnce(
    source,
    `      callerContactPromise = direction === "inbound"
        ? lookupCallerContact(callerNumber)
        : Promise.resolve(null);
      connectToOpenAI();
`,
    `      callerContactPromise = direction === "inbound"
        ? lookupCallerContact(callerNumber)
        : Promise.resolve(null);
      recentCommunicationPromise = direction === "inbound"
        ? callerContactPromise.then(function(contact) { return lookupRecentCommunicationContext(contact); }).catch(function() { return []; })
        : Promise.resolve([]);
      resumeReason = String((msg.start.customParameters && msg.start.customParameters.resumeReason) || "");
      if (resumeReason === "NO_ANSWER" && callSid) {
        resumeState = tryTommySessions.get(callSid) || null;
        if (resumeState) {
          tryTommySessions.delete(callSid);
          transcript.push.apply(transcript, Array.isArray(resumeState.transcript) ? resumeState.transcript : []);
          tryAttempted = true;
          transferOutcome = "NO_ANSWER";
          lastSavedCallerName = String(resumeState.callerName || "");
          lastSavedReason = String(resumeState.reason || "");
        }
      }
      connectToOpenAI();
`,
    "resume state and communication lookup"
  );

  source = replaceOnce(
    source,
    `    if (msg.event === "stop") {
      console.log("Stream stopped");
      if (openAiWs) openAiWs.close();
    }
`,
    `    if (msg.event === "stop") {
      console.log("Stream stopped");
      if (!transferInProgress) {
        sendTranscriptEmailOnce(transferOutcome || "Completed").catch(function(error) { console.error("Transcript email stop error:", error.message); });
      }
      if (openAiWs) openAiWs.close();
    }
`,
    "email on stream stop"
  );

  return source;
}

module.exports = { applyPersonalPatches };
