require("dotenv").config();

const express = require("express");
const path = require("path");
const { createServer } = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/stream" });

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const TOMMY_PHONE_NUMBER = process.env.TOMMY_PHONE_NUMBER || "+61428049389";
const BASE44_API_KEY = process.env.BASE44_API_KEY || "";
const BASE44_APP_ID = process.env.BASE44_APP_ID || "69c1bcc966e03d26bd89d178";
const BASE44_API_BASE =
  process.env.BASE44_CALLLOG_URL ||
  `https://base44.app/api/apps/${BASE44_APP_ID}/entities/CallLog`;
const BASE_URL = process.env.BASE_URL || "https://kodi-voice-bridge-production.up.railway.app";

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

function requireEnvironment() {
  const required = {
    OPENAI_API_KEY,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_PHONE_NUMBER,
    BASE44_API_KEY,
    BASE44_APP_ID,
    BASE_URL,
  };

  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length) {
    console.warn(`Missing environment variables: ${missing.join(", ")}`);
  }
}

requireEnvironment();

// OpenAI currently returns PCM16 audio. Twilio Media Streams require 8 kHz
// G.711 mu-law, so assistant audio is resampled and encoded before forwarding.
const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

function linearToMulawSample(inputSample) {
  let sample = inputSample;
  const sign = (sample >> 8) & 0x80;

  if (sign !== 0) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;

  let exponent = 7;
  for (
    let exponentMask = 0x4000;
    (sample & exponentMask) === 0 && exponent > 0;
    exponentMask >>= 1
  ) {
    exponent -= 1;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function resamplePcm16(samples, inputRate, outputRate) {
  if (inputRate === outputRate) return samples;

  const ratio = inputRate / outputRate;
  const outputLength = Math.floor(samples.length / ratio);
  const output = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const sourcePosition = i * ratio;
    const lowerIndex = Math.floor(sourcePosition);
    const upperIndex = Math.min(lowerIndex + 1, samples.length - 1);
    const fraction = sourcePosition - lowerIndex;
    output[i] = Math.round(
      samples[lowerIndex] * (1 - fraction) + samples[upperIndex] * fraction
    );
  }

  return output;
}

function pcm16ToG711Ulaw(pcm16Buffer, inputSampleRate = 24000) {
  const sampleCount = Math.floor(pcm16Buffer.length / 2);
  const pcmSamples = new Int16Array(sampleCount);

  for (let i = 0; i < sampleCount; i += 1) {
    pcmSamples[i] = pcm16Buffer.readInt16LE(i * 2);
  }

  const samples = resamplePcm16(pcmSamples, inputSampleRate, 8000);
  const ulaw = Buffer.alloc(samples.length);

  for (let i = 0; i < samples.length; i += 1) {
    ulaw[i] = linearToMulawSample(samples[i]);
  }

  return ulaw;
}

function sendUlawToTwilio(twilioWs, streamSid, ulawBuffer) {
  if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;

  // 160 bytes is 20 ms at 8 kHz. Encode each binary frame separately.
  for (let offset = 0; offset < ulawBuffer.length; offset += 160) {
    const frame = ulawBuffer.subarray(offset, offset + 160);
    twilioWs.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: frame.toString("base64") },
      })
    );
  }
}

function normaliseText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function transcriptText(turns) {
  return turns
    .filter((turn) => turn.content)
    .map((turn) => `${turn.role === "assistant" ? "Kodi" : "Caller"}: ${turn.content}`)
    .join("\n");
}

async function base44Request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      api_key: BASE44_API_KEY,
      ...(options.headers || {}),
    },
  });

  const raw = await response.text();
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }

  if (!response.ok) {
    throw new Error(`Base44 ${response.status}: ${JSON.stringify(body)}`);
  }

  return body;
}

async function createCallLog(payload) {
  return base44Request(BASE44_API_BASE, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function updateCallLog(id, payload) {
  return base44Request(`${BASE44_API_BASE}/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

const KODI_SYSTEM_PROMPT = `You are Kodi, the AI receptionist for Local Concreting Mate (LCM), a residential concreting business in the Hunter Valley and Newcastle area of Australia. The owner is Tommy Wrixon.

YOUR CALL FLOW FOR INBOUND CALLS:
Step 1. Greet: "Kodi speaking, Tommy is not available right now. Can I ask who is calling?"
Step 2. Once you have their name, ask why they are calling.
Step 3. Once you have the reason, say: "And I have your number here as [read each digit individually with a pause]. Is that the best number for Tommy to call you back on?"
Step 4. If they confirm yes, say "Perfect." If they give a different number, update it.
Step 5. Say: "Brilliant, I will pass that straight on to Tommy. Have a good one."
Step 6. Call save_caller_info. This is mandatory and must happen before hang_up.
Step 7. Only after save_caller_info returns a result, call hang_up.

Even if the caller hangs up early, save whatever information is available.

FOR CALLS WITH TOMMY (outbound):
1. Greet: "Morning Tommy, it is Kodi. Ready when you are."
2. Run through briefing items, answer questions, and give business insights.

SERVICES: concrete driveways, paths, slabs, decorative concrete, kerbing, and pool surrounds. Service area: Hunter Valley and Newcastle, NSW.

RULES:
- Never say the word mate.
- Never use contractions.
- Keep responses to one or two sentences.
- Never quote prices; defer quotes to Tommy.
- Read phone numbers one digit at a time.`;

function publicWebSocketUrl() {
  return BASE_URL.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}

function streamTwiml({ callSid, callerNumber, direction }) {
  const wsUrl = `${publicWebSocketUrl()}/stream`;
  const response = new twilio.twiml.VoiceResponse();
  const connect = response.connect();
  const stream = connect.stream({ url: wsUrl });
  stream.parameter({ name: "callSid", value: callSid || "unknown" });
  stream.parameter({ name: "callerNumber", value: callerNumber || "unknown" });
  stream.parameter({ name: "direction", value: direction });
  return response.toString();
}

app.post("/inbound", (req, res) => {
  const callSid = req.body.CallSid || "unknown";
  const callerNumber = req.body.From || "unknown";
  console.log(`Inbound call ${callSid} from ${callerNumber}`);
  res.type("text/xml").send(streamTwiml({ callSid, callerNumber, direction: "inbound" }));
});

app.post("/outbound", (req, res) => {
  const callSid = req.body.CallSid || "unknown";
  res.type("text/xml").send(
    streamTwiml({ callSid, callerNumber: TOMMY_PHONE_NUMBER, direction: "outbound" })
  );
});

app.post("/call-tommy", async (req, res) => {
  try {
    const call = await twilioClient.calls.create({
      to: TOMMY_PHONE_NUMBER,
      from: TWILIO_PHONE_NUMBER,
      url: `${BASE_URL}/outbound`,
      statusCallback: `${BASE_URL}/status`,
      statusCallbackMethod: "POST",
    });
    console.log(`Outbound call started: ${call.sid}`);
    res.json({ success: true, callSid: call.sid });
  } catch (error) {
    console.error("Failed to start outbound call:", error);
    res.status(500).json({ error: "Call failed" });
  }
});

app.post("/status", (req, res) => {
  console.log(`Call status ${req.body.CallSid}: ${req.body.CallStatus}`);
  res.sendStatus(200);
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy" });
});

app.get("/api/items", async (req, res) => {
  try {
    const data = await base44Request(`${BASE44_API_BASE}?sort=-created_date&limit=300`, {
      method: "GET",
    });
    res.json(Array.isArray(data) ? data : data?.items || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/items/:id", async (req, res) => {
  try {
    res.json(await updateCallLog(req.params.id, req.body));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: req.body.messages,
        max_tokens: 300,
      }),
    });
    const data = await response.json();
    res.json({ reply: data.choices?.[0]?.message?.content || "No response." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/send-sms", async (req, res) => {
  try {
    const message = await twilioClient.messages.create({
      to: req.body.to,
      from: TWILIO_PHONE_NUMBER,
      body: req.body.body,
    });
    res.json({ success: true, sid: message.sid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/whatsapp-team", async (req, res) => {
  const team = [
    "+61428049389",
    "+61405266508",
    "+61407633409",
    "+61466373308",
    "+61423448605",
  ];
  const results = await Promise.allSettled(
    team.map((to) =>
      twilioClient.messages.create({
        to: `whatsapp:${to}`,
        from: `whatsapp:${TWILIO_PHONE_NUMBER}`,
        body: req.body.message,
      })
    )
  );
  res.json({ sent: results.filter((result) => result.status === "fulfilled").length });
});

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

wss.on("connection", (twilioWs) => {
  console.log("Twilio WebSocket connected");

  let openAiWs = null;
  let streamSid = null;
  let callSid = "unknown";
  let callerNumber = "unknown";
  let direction = "inbound";
  let callStartedAt = new Date().toISOString();
  let pendingAudio = [];
  let transcript = [];
  let callerInfo = {};
  let callLogId = null;
  let saveInProgress = null;
  let finalised = false;

  function addTranscriptTurn(role, content) {
    const text = normaliseText(content);
    if (!text) return;

    const previous = transcript[transcript.length - 1];
    if (previous && previous.role === role && previous.content === text) return;

    transcript.push({
      role,
      content: text,
      timestamp: new Date().toISOString(),
    });
    console.log(`${role === "assistant" ? "Kodi" : "Caller"}: ${text}`);
  }

  function buildCallLog(status = "completed") {
    const callerSpeech = transcript
      .filter((turn) => turn.role === "user")
      .map((turn) => turn.content)
      .join(" | ");

    const reason = normaliseText(callerInfo.reason);
    const notes = normaliseText(callerInfo.notes);
    const message = [reason || callerSpeech, notes].filter(Boolean).join(" - ");

    return {
      call_sid: callSid || "",
      caller_number: callerInfo.callback_number || callerNumber || "unknown",
      from_name: callerInfo.name || "",
      message,
      channel: "call",
      status,
      history: JSON.stringify(transcript),
      briefed: false,
    };
  }

  async function saveCallLog(status = "completed") {
    if (saveInProgress) await saveInProgress;

    saveInProgress = (async () => {
      try {
        const payload = buildCallLog(status);
        const saved = callLogId
          ? await updateCallLog(callLogId, payload)
          : await createCallLog(payload);

        callLogId = saved?.id || callLogId;
        console.log(`CallLog saved: ${callLogId || "no id returned"}`);
        return saved;
      } catch (error) {
        console.error("CallLog save failed:", error.message);
        return null;
      } finally {
        saveInProgress = null;
      }
    })();

    return saveInProgress;
  }

  async function finaliseCall(status = "completed") {
    if (finalised) return;
    finalised = true;
    await saveCallLog(status);
  }

  async function hangUpCall() {
    await finaliseCall("completed");
    if (!callSid || callSid === "unknown") return;

    try {
      await twilioClient.calls(callSid).update({ status: "completed" });
      console.log(`Call hung up: ${callSid}`);
    } catch (error) {
      console.error("Hang up error:", error.message);
    }
  }

  function sendToOpenAI(event) {
    if (openAiWs?.readyState === WebSocket.OPEN) {
      openAiWs.send(JSON.stringify(event));
    }
  }

  function connectToOpenAI() {
    openAiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1", {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    });

    openAiWs.on("open", () => {
      console.log("OpenAI Realtime connected");

      sendToOpenAI({
        type: "session.update",
        session: {
          type: "realtime",
          model: "gpt-realtime-2.1",
          output_modalities: ["audio"],
          instructions: KODI_SYSTEM_PROMPT,
          audio: {
            input: {
              format: { type: "g711_ulaw", rate: 8000 },
              transcription: {
                model: "gpt-4o-mini-transcribe",
                language: "en",
              },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 700,
                create_response: true,
              },
            },
            output: {
              format: { type: "audio/pcm" },
              voice: "shimmer",
            },
          },
          tools: [
            {
              type: "function",
              name: "save_caller_info",
              description:
                "Save the caller name, reason and callback number before ending every inbound call.",
              parameters: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Caller name" },
                  reason: { type: "string", description: "Reason for calling" },
                  callback_number: {
                    type: "string",
                    description: "Confirmed callback number",
                  },
                  notes: { type: "string", description: "Other useful details" },
                },
                required: ["name", "reason"],
              },
            },
            {
              type: "function",
              name: "hang_up",
              description: "End the call only after save_caller_info succeeds.",
              parameters: { type: "object", properties: {}, required: [] },
            },
          ],
          tool_choice: "auto",
        },
      });

      const greetingPrompt =
        direction === "outbound"
          ? "The call has connected to Tommy. Give the outbound greeting now."
          : `The call has connected. The caller number is ${callerNumber}. Give the inbound greeting now.`;

      sendToOpenAI({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: greetingPrompt }],
        },
      });
      sendToOpenAI({ type: "response.create" });

      pendingAudio.forEach((audio) =>
        sendToOpenAI({ type: "input_audio_buffer.append", audio })
      );
      pendingAudio = [];
    });

    openAiWs.on("message", async (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch (error) {
        console.error("Invalid OpenAI event:", error.message);
        return;
      }

      if (message.type === "error") {
        console.error("OpenAI Realtime error:", JSON.stringify(message.error || message));
        return;
      }

      if (message.type === "response.output_audio.delta" && message.delta) {
        try {
          const pcm16 = Buffer.from(message.delta, "base64");
          const ulaw = pcm16ToG711Ulaw(pcm16, 24000);
          sendUlawToTwilio(twilioWs, streamSid, ulaw);
        } catch (error) {
          console.error("Audio conversion failed:", error.message);
        }
      }

      if (message.type === "conversation.item.input_audio_transcription.completed") {
        addTranscriptTurn("user", message.transcript);
      }

      if (
        message.type === "response.output_audio_transcript.done" ||
        message.type === "response.audio_transcript.done"
      ) {
        addTranscriptTurn("assistant", message.transcript);
      }

      if (message.type === "response.function_call_arguments.done") {
        let argumentsObject = {};
        try {
          argumentsObject = JSON.parse(message.arguments || "{}");
        } catch {
          argumentsObject = {};
        }

        if (message.name === "save_caller_info") {
          callerInfo = { ...callerInfo, ...argumentsObject };
          const saved = await saveCallLog("completed");
          sendToOpenAI({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: message.call_id,
              output: saved ? "Saved successfully." : "Save failed. Please try again.",
            },
          });
          sendToOpenAI({ type: "response.create" });
        }

        if (message.name === "hang_up") {
          sendToOpenAI({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: message.call_id,
              output: "Call ending.",
            },
          });

          setTimeout(async () => {
            await hangUpCall();
            openAiWs?.close();
          }, 1200);
        }
      }
    });

    openAiWs.on("close", async (code, reasonBuffer) => {
      const reason = reasonBuffer?.toString().slice(0, 200) || "none";
      console.log(`OpenAI WebSocket closed: ${code} ${reason}`);
      await finaliseCall(code === 1000 ? "completed" : "disconnected");
    });

    openAiWs.on("error", (error) => {
      console.error("OpenAI WebSocket error:", error.message || error);
    });
  }

  twilioWs.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (error) {
      console.error("Invalid Twilio event:", error.message);
      return;
    }

    if (message.event === "start") {
      streamSid = message.start.streamSid;
      callSid = message.start.customParameters?.callSid || message.start.callSid || "unknown";
      callerNumber = message.start.customParameters?.callerNumber || "unknown";
      direction = message.start.customParameters?.direction || "inbound";
      callStartedAt = new Date().toISOString();
      console.log(
        `Stream started ${streamSid}; direction=${direction}; caller=${callerNumber}`
      );
      connectToOpenAI();
    }

    if (message.event === "media") {
      const audio = message.media?.payload;
      if (!audio) return;

      if (openAiWs?.readyState === WebSocket.OPEN) {
        sendToOpenAI({ type: "input_audio_buffer.append", audio });
      } else {
        pendingAudio.push(audio);
      }
    }

    if (message.event === "stop") {
      console.log("Twilio stream stopped");
      finaliseCall("completed").finally(() => openAiWs?.close());
    }
  });

  twilioWs.on("close", () => {
    finaliseCall("completed").finally(() => openAiWs?.close());
  });

  twilioWs.on("error", (error) => {
    console.error("Twilio WebSocket error:", error.message || error);
  });
});

server.listen(PORT, () => {
  console.log(`Kodi Voice Bridge running on port ${PORT}`);
});
