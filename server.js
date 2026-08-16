require("dotenv").config();
const express = require("express");
const { createServer } = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const twilio = require("twilio");
const { KODI_SYSTEM_PROMPT } = require("./kodi-prompt");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const BASE44_API_KEY = process.env.BASE44_API_KEY || "";
const BASE44_APP_ID = process.env.BASE44_APP_ID || "69c1bcc966e03d26bd89d178";
const LCM_LOOKUP_URL = process.env.LCM_LOOKUP_URL || "";
const LCM_LOOKUP_SECRET = process.env.LCM_LOOKUP_SECRET || "";
const BASE44_ENTITIES_BASE = "https://base44.app/api/apps/" + BASE44_APP_ID + "/entities";
const BASE44_API_BASE = BASE44_ENTITIES_BASE + "/CallLog";
const BASE_URL = process.env.BASE_URL || "https://your-app.railway.app";

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

function normaliseSearch(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function toAustralianLocalNumber(value) {
  const raw = String(value || "").trim();
  const compact = raw.replace(/[^+\d]/g, "");
  if (/^\+61\d+$/.test(compact)) return "0" + compact.slice(3);
  if (/^61\d+$/.test(compact)) return "0" + compact.slice(2);
  return compact || raw;
}

async function lookupJobSchedule(args) {
  if (!LCM_LOOKUP_URL || !LCM_LOOKUP_SECRET) {
    throw new Error("LCM_LOOKUP_URL or LCM_LOOKUP_SECRET is missing");
  }

  const searchTerm = String(args.search_term || "").trim();
  let address = String(args.address || "").trim();
  let suburb = "";
  const builderJobNumber = String(args.builder_job_number || args.job_number || "").trim();

  if (address) {
    const commaIndex = address.lastIndexOf(",");
    if (commaIndex >= 0) {
      suburb = address.slice(commaIndex + 1).trim();
      address = address.slice(0, commaIndex).trim();
    }
  }

  if (!suburb && address && searchTerm) {
    const commaIndex = searchTerm.lastIndexOf(",");
    if (commaIndex >= 0) {
      const searchAddress = searchTerm.slice(0, commaIndex).trim();
      const searchSuburb = searchTerm.slice(commaIndex + 1).trim();
      if (!searchAddress || normaliseSearch(searchAddress) === normaliseSearch(address)) {
        suburb = searchSuburb;
      }
    } else if (!/\d/.test(searchTerm) && normaliseSearch(searchTerm) !== normaliseSearch(address)) {
      suburb = searchTerm;
    }
  }

  if (!searchTerm && !address && !builderJobNumber) {
    return { status: "need_more_detail", message: "Ask for the builder job number, suburb, or full address." };
  }

  const query = { limit: 20 };
  if (builderJobNumber) query.builder_job_number = builderJobNumber;
  if (address) query.address = address;
  if (suburb) query.suburb = suburb;

  if (!address && searchTerm && !builderJobNumber) {
    if (/\d/.test(searchTerm)) {
      const commaIndex = searchTerm.lastIndexOf(",");
      if (commaIndex >= 0) {
        query.address = searchTerm.slice(0, commaIndex).trim();
        query.suburb = searchTerm.slice(commaIndex + 1).trim();
      } else {
        query.address = searchTerm;
      }
    } else {
      query.suburb = searchTerm;
    }
  }

  async function runJobSearch(searchQuery) {
    const response = await fetch(LCM_LOOKUP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kodi-Shared-Secret": LCM_LOOKUP_SECRET,
      },
      body: JSON.stringify({ action: "searchJobs", query: searchQuery }),
    });
    const bodyText = await response.text();
    let body;
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch (error) {
      throw new Error("LCM lookup returned invalid JSON");
    }
    if (response.status === 404 && body && body.error && body.error.code === "NO_MATCH") return [];
    if (!response.ok) throw new Error("LCM lookup failed: " + response.status + " " + bodyText.slice(0, 500));
    return Array.isArray(body.jobs) ? body.jobs : [];
  }

  console.log("LCM lookup request:", JSON.stringify({
    search_term: searchTerm,
    address: address,
    suburb: suburb,
    builder_job_number: builderJobNumber,
    initial_query: query,
  }));

  let jobs = await runJobSearch(query);

  // Speech transcription and builder records often differ only in street suffixes
  // or whether a compound street name contains a space. Retry a small, bounded
  // set of address variants before telling the caller that no job exists.
  if (!jobs.length && query.address) {
    const originalAddress = String(query.address).trim();
    const addressVariants = [];
    const addAddressVariant = function(value) {
      const candidate = String(value || "").replace(/\s+/g, " ").trim();
      if (candidate && normaliseSearch(candidate) !== normaliseSearch(originalAddress) &&
          !addressVariants.some(function(existing) { return normaliseSearch(existing) === normaliseSearch(candidate); })) {
        addressVariants.push(candidate);
      }
    };

    addAddressVariant(originalAddress.replace(/\bAvenue\b/i, "Ave"));
    addAddressVariant(originalAddress.replace(/\bAve\b/i, "Avenue"));
    addAddressVariant(originalAddress.replace(/\bStreet\b/i, "St"));
    addAddressVariant(originalAddress.replace(/\bSt\b/i, "Street"));
    addAddressVariant(originalAddress.replace(/\bRoad\b/i, "Rd"));
    addAddressVariant(originalAddress.replace(/\bRd\b/i, "Road"));
    addAddressVariant(originalAddress.replace(/([A-Za-z]{3,})(grass)\b/i, "$1 $2"));

    for (const variant of addressVariants) {
      jobs = await runJobSearch(Object.assign({}, query, { address: variant }));
      if (jobs.length) {
        console.log("LCM address fallback matched:", variant);
        break;
      }
    }

    if (!jobs.length && query.suburb) {
      jobs = await runJobSearch({ address: originalAddress, limit: 20 });
      if (jobs.length) console.log("LCM address fallback matched without suburb");
    }
  }

  if (!jobs.length && builderJobNumber) {
    const compactBuilderNumber = builderJobNumber.replace(/[^A-Za-z0-9]/g, "");
    if (compactBuilderNumber && compactBuilderNumber !== builderJobNumber) {
      jobs = await runJobSearch(Object.assign({}, query, { builder_job_number: compactBuilderNumber }));
    }
  }
  if (!jobs.length && builderJobNumber) {
    const legacyQuery = Object.assign({}, query);
    delete legacyQuery.builder_job_number;
    legacyQuery.job_number = builderJobNumber;
    jobs = await runJobSearch(legacyQuery);
  }
  if (jobs.length === 0) {
    return { status: "not_found", message: "No matching LCM job was found." };
  }
  if (jobs.length > 1) {
    return {
      status: "multiple_matches",
      message: "Ask the caller for the full address or builder job number.",
      matches: jobs.slice(0, 10).map(function(job) {
        return {
          job_number: job.job_number || "",
          address: [job.address, job.suburb].filter(Boolean).join(", "),
        };
      }),
    };
  }

  const job = jobs[0];
  const activities = (Array.isArray(job.labour_activities) ? job.labour_activities : [])
    .map(function(activity) {
      return {
        name: activity.title || "",
        calendar_date: activity.calendar_date || null,
      };
    })
    .filter(function(activity) {
      return activity.name && activity.calendar_date;
    });

  const activityDate = function(pattern) {
    const match = activities.find(function(activity) {
      return pattern.test(activity.name);
    });
    return match ? match.calendar_date : null;
  };
  const podsAndSteelDate = activityDate(/pod.*steel/i);
  const sandUpDate = activityDate(/sand\s*up/i);
  const drainsDate = activityDate(/drains/i);
  let supplierGuidance = null;

  if (podsAndSteelDate) {
    supplierGuidance = supplierGuidance || {};
    supplierGuidance.pods_and_steel = {
      status: "confirmed",
      calendar_date: podsAndSteelDate,
      instruction: "Pods and steel must be on site by 7:00 a.m. on the confirmed Pod and Steel date. Do not approve a later delivery time.",
    };
  }

  if (sandUpDate) {
    supplierGuidance = supplierGuidance || {};
    if (drainsDate && drainsDate < sandUpDate) {
      supplierGuidance.sand = {
        status: "confirmed_ready",
        calendar_date: sandUpDate,
        instruction: "Drains are confirmed before Sand Up. Sand must be on site by 7:00 a.m. on the confirmed Sand Up date.",
      };
    } else {
      supplierGuidance.sand = {
        status: "not_confirmed_ready",
        calendar_date: sandUpDate,
        drains_calendar_date: drainsDate,
        instruction: "Do not say the job is ready and do not approve a sand delivery. Record a callback because Drains are not confirmed before Sand Up.",
      };
    }
  }

  return {
    status: "single_match",
    job: {
      job_number: job.job_number || "",
      address: [job.address, job.suburb].filter(Boolean).join(", "),
    },
    activities: activities,
    supplier_guidance: supplierGuidance,
    message: activities.length
      ? "Confirmed activity dates found. Any supplier_guidance is mandatory."
      : "The job was found, but no confirmed Labour Allocation dates are recorded.",
  };
}

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

function linearToMulawSample(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample = sample + MULAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const ulawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return ulawByte;
}

function resamplePcm16(samples, inputRate, outputRate) {
  if (inputRate === outputRate) return samples;

  const ratio = inputRate / outputRate;
  const outputLength = Math.floor(samples.length / ratio);
  const result = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const indexFloor = Math.floor(srcIndex);
    const indexCeil = Math.min(indexFloor + 1, samples.length - 1);
    const frac = srcIndex - indexFloor;
    result[i] = Math.round(samples[indexFloor] * (1 - frac) + samples[indexCeil] * frac);
  }

  return result;
}

function pcm16ToG711Ulaw(pcm16Buffer, inputSampleRate) {
  const sampleCount = Math.floor(pcm16Buffer.length / 2);
  const pcmSamples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    pcmSamples[i] = pcm16Buffer.readInt16LE(i * 2);
  }

  const resampled = inputSampleRate === 8000
    ? pcmSamples
    : resamplePcm16(pcmSamples, inputSampleRate, 8000);

  const ulawBuffer = Buffer.alloc(resampled.length);
  for (let i = 0; i < resampled.length; i++) {
    ulawBuffer[i] = linearToMulawSample(resampled[i]);
  }

  return ulawBuffer;
}

app.post("/inbound", (req, res) => {
  const callSid = req.body.CallSid || "unknown";
  const from = req.body.From || "unknown";
  console.log("Inbound call: " + callSid + " from " + from);
  const wsUrl = BASE_URL.replace("https://", "wss://").replace("http://", "ws://");
  res.type("text/xml");
  res.send('<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="' + wsUrl + '/stream"><Parameter name="callSid" value="' + callSid + '" /><Parameter name="callerNumber" value="' + from + '" /><Parameter name="direction" value="inbound" /></Stream></Connect></Response>');
});

app.post("/outbound", (req, res) => {
  const callSid = req.body.CallSid || "unknown";
  const wsUrl = BASE_URL.replace("https://", "wss://").replace("http://", "ws://");
  res.type("text/xml");
  res.send('<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="' + wsUrl + '/stream"><Parameter name="callSid" value="' + callSid + '" /><Parameter name="callerNumber" value="+61428049389" /><Parameter name="direction" value="outbound" /></Stream></Connect></Response>');
});

app.post("/call-tommy", async (req, res) => {
  twilioClient.calls.create({
    to: "+61428049389",
    from: TWILIO_PHONE_NUMBER,
    url: BASE_URL + "/outbound",
    statusCallback: BASE_URL + "/status",
    statusCallbackMethod: "POST",
  }).then(function(call) {
    console.log("Outbound call started: " + call.sid);
    res.json({ success: true, callSid: call.sid });
  }).catch(function(err) {
    console.error("Failed to start outbound call:", err);
    res.status(500).json({ error: "Call failed" });
  });
});

app.post("/status", (req, res) => {
  console.log("Call status:", req.body.CallStatus, req.body.CallSid);
  res.sendStatus(200);
});

const path = require("path");

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/items", async (req, res) => {
  try {
    const r = await fetch(BASE44_API_BASE + "?sort=-created_date&limit=300", {
      headers: { "api_key": BASE44_API_KEY },
    });
    const data = await r.json();
    res.json(Array.isArray(data) ? data : (data.items || []));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/items/:id", async (req, res) => {
  try {
    const r = await fetch(BASE44_API_BASE + "/" + req.params.id, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "api_key": BASE44_API_KEY },
      body: JSON.stringify(req.body),
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + OPENAI_API_KEY },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: req.body.messages, max_tokens: 300 }),
    });
    const d = await r.json();
    const reply = d.choices?.[0]?.message?.content || "No response.";
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/send-sms", async (req, res) => {
  try {
    const { to, body } = req.body;
    const msg = await twilioClient.messages.create({ to, from: TWILIO_PHONE_NUMBER, body });
    res.json({ success: true, sid: msg.sid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/whatsapp-team", async (req, res) => {
  const { message } = req.body;
  const TEAM = ["+61428049389","+61405266508","+61407633409","+61466373308","+61423448605"];
  const results = await Promise.allSettled(TEAM.map(to =>
    twilioClient.messages.create({ to: "whatsapp:" + to, from: "whatsapp:" + TWILIO_PHONE_NUMBER, body: message })
  ));
  res.json({ sent: results.filter(r=>r.status==="fulfilled").length });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

wss.on("connection", (twilioWs) => {
  console.log("Twilio WebSocket connected");

  let openAiWs = null;
  let streamSid = null;
  let callSid = null;
  let callerNumber = null;
  let direction = "inbound";
  let audioBuffer = [];
  const transcript = [];
  let savedByTool = false;

  function hangUpCall() {
    if (callSid && callSid !== "unknown") {
      twilioClient.calls(callSid).update({ status: "completed" }).then(function() {
        console.log("Call hung up: " + callSid);
      }).catch(function(err) {
        console.error("Hang up error:", err);
      });
    }
  }

  function connectToOpenAI() {
    openAiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1",
      undefined,
      {
        headers: {
          Authorization: "Bearer " + OPENAI_API_KEY,
        },
      }
    );

    openAiWs.on("open", () => {
      console.log("OpenAI Realtime connected");

      openAiWs.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          output_modalities: ["audio"],
          instructions: KODI_SYSTEM_PROMPT,
          audio: {
            input: {
              format: {
                type: "audio/pcmu",
              },
              transcription: {
                model: "gpt-4o-mini-transcribe",
                language: "en",
                prompt: "Australian English phone call for Local Concreting Mate. Expected names include Tommy and Kodi.",
              },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 700,
              },
            },
            output: {
              format: {
                type: "audio/pcmu",
              },
              voice: "cedar",
            },
          },
          tools: [
            {
              type: "function",
              name: "lookup_job_schedule",
              description: "Search the live LCM app for a job and confirmed Labour Allocation dates. Search by builder job number or address. Never ask an external caller for an LCM job number. If multiple jobs are returned, ask for the full address or builder job number.",
              parameters: {
                type: "object",
                properties: {
                  search_term: { type: "string", description: "The suburb, partial address, full address, or builder job number stated by the caller" },
                  address: { type: "string", description: "Full or partial street address when the caller provides it" },
                  builder_job_number: { type: "string", description: "The builder's external job number, preserving punctuation when possible" },
                },
                required: ["search_term"],
              },
            },
            {
              type: "function",
              name: "save_caller_info",
              description: "MANDATORY: Save caller name, reason, and callback number. You MUST call this on every inbound call before hang_up. Use the inbound caller ID as the default callback number when available, confirm it by reading it back digit by digit, and only ask for a different number if caller ID is unavailable or the caller requests another number.",
              parameters: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Callers name" },
                  reason: { type: "string", description: "Reason for calling" },
                  callback_number: { type: "string", description: "Confirmed callback number in local Australian format where possible, for example 04xxxxxxxx" },
                  notes: { type: "string", description: "Relevant details only. Never claim the callback number was confirmed unless the caller explicitly confirmed it." },
                  callback_number_confirmed: { type: "boolean", description: "True only when Kodi read the number digit by digit and the caller explicitly confirmed it." },
                },
                required: ["name", "reason", "callback_number_confirmed"],
              },
            },
            {
              type: "function",
              name: "hang_up",
              description: "End the call. ONLY call this AFTER save_caller_info has already returned. Never call hang_up without calling save_caller_info first.",
              parameters: {
                type: "object",
                properties: {},
                required: [],
              },
            },
          ],
          tool_choice: "auto",
        },
      }));

      console.log("OpenAI session configured: output format=g711_ulaw rate=8000 voice=cedar");

      const localCallerNumber = toAustralianLocalNumber(callerNumber);
      const greetingPrompt = direction === "outbound"
        ? "The call just connected to Tommy. Give him the morning briefing greeting."
        : "The call just connected. The inbound caller ID callback number is " + localCallerNumber + ". Use this number as the default callback number. Do not ask the caller to provide their phone number unless caller ID is unavailable/private/unknown or they want to use a different number. If a callback is needed, read this local-format number back digit by digit, beginning with 0 rather than +61, and ask the caller to confirm it. Start with your greeting now.";

      openAiWs.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: greetingPrompt }],
        },
      }));
      openAiWs.send(JSON.stringify({ type: "response.create" }));

      for (const payload of audioBuffer) {
        openAiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload }));
      }
      audioBuffer = [];
    });

    openAiWs.on("message", async (data) => {
      const msg = JSON.parse(data.toString());

      if (msg.type === "error") {
        console.error("OpenAI Realtime error:", JSON.stringify(msg.error || msg));
      }
      if (msg.type === "session.updated") {
        console.log("OpenAI session accepted: input=audio/pcmu output=audio/pcmu");
      }
      if (msg.type === "input_audio_buffer.speech_started" || msg.type === "input_audio_buffer.speech_stopped") {
        console.log("OpenAI event: " + msg.type);
      }

      if (msg.type === "response.output_audio.delta" && msg.delta) {
        console.log("OpenAI event: response.output_audio.delta");
        console.log("Response audio base64 length: " + msg.delta.length + " bytes");
        try {
          const decodedPrefix = Buffer.from(msg.delta, "base64").slice(0, 6).toString("hex");
          console.log("Decoded audio prefix (hex): " + decodedPrefix);
        } catch (hexErr) {
          console.error("Failed to decode audio prefix:", hexErr.message);
        }
        console.log("Twilio media event: event=media streamSid=" + streamSid + " payloadLength=" + msg.delta.length);
        try {
          twilioWs.send(JSON.stringify({
            event: "media",
            streamSid: streamSid,
            media: { payload: msg.delta },
          }));
        } catch (forwardErr) {
          console.error("Audio forwarding failed:", forwardErr.message);
        }
      }

      if (msg.type === "conversation.item.input_audio_transcription.completed") {
        transcript.push({ role: "user", content: msg.transcript });
      }
      if (msg.type === "response.output_audio_transcript.done") {
        transcript.push({ role: "assistant", content: msg.transcript });
      }

      if (msg.type === "response.function_call_arguments.done") {
        const fnName = msg.name;
        let fnArgs = {};
        try { fnArgs = JSON.parse(msg.arguments || "{}"); } catch (err) {}

        if (fnName === "lookup_job_schedule") {
          let lookupResult;
          try {
            lookupResult = await lookupJobSchedule(fnArgs);
            console.log("LCM lookup result: " + JSON.stringify(lookupResult));
          } catch (lookupErr) {
            console.error("LCM lookup error:", lookupErr);
            lookupResult = {
              status: "lookup_error",
              message: "The LCM system could not be checked right now. Take a callback message for Tommy.",
            };
          }

          openAiWs.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: msg.call_id,
              output: JSON.stringify(lookupResult),
            },
          }));
          openAiWs.send(JSON.stringify({ type: "response.create" }));
        }

        if (fnName === "save_caller_info") {
          try {
            try {
              const saveRes = await fetch(BASE44_API_BASE, {
                method: "POST",
                headers: { "Content-Type": "application/json", "api_key": BASE44_API_KEY },
                body: JSON.stringify({
                  call_sid: callSid || "",
                  caller_number: callerNumber || "unknown",
                  from_name: fnArgs.name || "",
                  message: (fnArgs.reason || "") + (fnArgs.notes ? " - " + fnArgs.notes : ""),
                  channel: "call",
                  status: "completed",
                  history: JSON.stringify(transcript),
                  briefed: false,
                }),
              });
              const saveJson = await saveRes.json();
              console.log("Save response status: " + saveRes.status);
              console.log("Save response body: " + JSON.stringify(saveJson));
              console.log("API key present: " + (BASE44_API_KEY ? "yes len=" + BASE44_API_KEY.length : "NO - MISSING"));
              if (saveJson.id) {
                console.log("Caller info saved for " + (fnArgs.name || "unknown") + " id=" + saveJson.id);
                savedByTool = true;
              } else {
                console.error("Save failed - no id returned:", JSON.stringify(saveJson));
              }
            } catch (saveErr) {
              console.error("Direct API save error:", saveErr);
            }
          } catch (err) {
            console.error("Save error:", err);
          }

          openAiWs.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: msg.call_id,
              output: "Saved successfully.",
            },
          }));
          openAiWs.send(JSON.stringify({ type: "response.create" }));
        }

        if (fnName === "hang_up") {
          console.log("Hang up requested by AI");
          openAiWs.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: msg.call_id,
              output: "Call ended.",
            },
          }));
          setTimeout(function() {
            hangUpCall();
            if (openAiWs) openAiWs.close();
          }, 1500);
        }
      }
    });

    openAiWs.on("close", (code, reason) => {
      console.log("OpenAI WS closed - code: " + code + ", reason: " + (reason ? reason.slice(0, 100) : "none"));
      if (transcript.length > 0 && callerNumber && !savedByTool) {
        console.log("Fallback save triggered - tool was not called");
        fetch(BASE44_API_BASE, {
          method: "POST",
          headers: { "Content-Type": "application/json", "api_key": BASE44_API_KEY },
          body: JSON.stringify({
            call_sid: callSid || "",
            caller_number: callerNumber || "unknown",
            from_name: "",
            message: transcript.filter(function(t) { return t.role === "user"; }).map(function(t) { return t.content; }).join(" | "),
            channel: "call",
            status: "completed",
            history: JSON.stringify(transcript),
            briefed: false,
          }),
        }).catch(function(err) { console.error("Final save error:", err); });
      }
    });

    openAiWs.on("error", function(e) {
      const errorMessage = e.message || JSON.stringify(e);
      console.error("OpenAI WS error:", errorMessage);
      if (e.code || e.statusCode) {
        console.error("Error code:", e.code || e.statusCode);
      }
      if (!e.message) {
        console.error("OpenAI WS error missing message:", e);
      }
    });
  }

  twilioWs.on("message", (data) => {
    const msg = JSON.parse(data.toString());

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      callSid = (msg.start.customParameters && msg.start.customParameters.callSid) || msg.start.callSid;
      callerNumber = (msg.start.customParameters && msg.start.customParameters.callerNumber) || "unknown";
      direction = (msg.start.customParameters && msg.start.customParameters.direction) || "inbound";
      console.log("Stream started: " + streamSid + " direction: " + direction + " from: " + callerNumber);
      connectToOpenAI();
    }

    if (msg.event === "media") {
      const payload = msg.media.payload;
      console.log("Twilio inbound media: payloadLength=" + (payload ? payload.length : 0));
      if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload }));
      } else {
        audioBuffer.push(payload);
      }
    }

    if (msg.event === "stop") {
      console.log("Stream stopped");
      if (openAiWs) openAiWs.close();
    }
  });

  twilioWs.on("close", () => { if (openAiWs) openAiWs.close(); });
  twilioWs.on("error", function(e) { console.error("Twilio WS error:", e); });
});

server.listen(PORT, () => console.log("Kodi Voice Bridge running on port " + PORT));
