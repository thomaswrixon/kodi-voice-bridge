require("dotenv").config();
const express = require("express");
const { createServer } = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const twilio = require("twilio");

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
const BASE44_APP_ID = "69bd9e4f4d346842bfeb2c45";
const BASE44_API_BASE = "https://kodi-bfeb2c45.base44.app/api/apps/" + BASE44_APP_ID + "/entities/CallLog";
const BASE_URL = process.env.BASE_URL || "https://your-app.railway.app";

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const KODI_SYSTEM_PROMPT = `You are Kodi, the AI receptionist for Local Concreting Mate (LCM), a residential concreting business in the Hunter Valley and Newcastle area of Australia. The owner is Tommy Wrixon.

YOUR CALL FLOW FOR INBOUND CALLS:
Step 1. Greet: "Kodi speaking, Tommy is not available right now. Can I ask who is calling?"
Step 2. Once you have their name, ask why they are calling.
Step 3. Once you have the reason, say: "And I have your number here as [read each digit individually with a pause, e.g. 0-4-2-8-0-4-9-3-8-9. NEVER say the number as a whole word like a million or billion - always individual digits]. Is that the best number for Tommy to call you back on?"
Step 4. If they confirm yes, say "Perfect." If they give a different number, update it.
Step 5. Say: "Brilliant, I will pass that straight on to Tommy. Have a good one."
Step 6. YOU MUST call save_caller_info NOW. This is mandatory. Do not say goodbye first. Do not hang up first. Call the function immediately.
Step 7. Only AFTER save_caller_info has returned a result, call hang_up.

CRITICAL: save_caller_info MUST be called on every single inbound call before hang_up. No exceptions. Even if the caller hangs up early, call save_caller_info with whatever information you have.

FOR CALLS WITH TOMMY (outbound):
1. Greet: "Morning Tommy, it is Kodi. Ready when you are."
2. Run through briefing items, answer questions, give business insights.

SERVICES: concrete driveways (plain, exposed aggregate, coloured, stencilled), paths, slabs, decorative concrete, kerbing, pool surrounds. Service area: Hunter Valley and Newcastle, NSW.

RULES:
- Never say the word mate
- Never use contractions - say "I will" not "I'll", "do not" not "don't", "that is" not "that's"
- SHORT responses, one or two sentences max. This is a phone call.
- Never quote prices - always defer to Tommy for quotes.`;

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

app.get("/", (req, res) => res.send("Kodi Voice Bridge running"));

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
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
      {
        headers: {
          Authorization: "Bearer " + OPENAI_API_KEY,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    openAiWs.on("open", () => {
      console.log("OpenAI Realtime connected");

      openAiWs.send(JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          voice: "shimmer",
          instructions: KODI_SYSTEM_PROMPT,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: { model: "whisper-1" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 700,
          },
          tools: [
            {
              type: "function",
              name: "save_caller_info",
              description: "MANDATORY: Save caller name, reason, and callback number. You MUST call this on every inbound call before hang_up. Call it immediately after saying goodbye.",
              parameters: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Callers name" },
                  reason: { type: "string", description: "Reason for calling" },
                  callback_number: { type: "string", description: "Confirmed callback number" },
                  notes: { type: "string", description: "Any other relevant details" },
                },
                required: ["name", "reason"],
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

      const greetingPrompt = direction === "outbound"
        ? "The call just connected to Tommy. Give him the morning briefing greeting."
        : "The call just connected. The caller's phone number is " + callerNumber + ". Start with your greeting now.";

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

      if (msg.type === "response.audio.delta" && msg.delta) {
        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid: streamSid,
          media: { payload: msg.delta },
        }));
      }

      if (msg.type === "conversation.item.input_audio_transcription.completed") {
        transcript.push({ role: "user", content: msg.transcript });
      }
      if (msg.type === "response.audio_transcript.done") {
        transcript.push({ role: "assistant", content: msg.transcript });
      }

      if (msg.type === "response.function_call_arguments.done") {
        const fnName = msg.name;
        let fnArgs = {};
        try { fnArgs = JSON.parse(msg.arguments || "{}"); } catch (err) {}

        if (fnName === "save_caller_info") {
          try {
            // Save directly to Base44 REST API
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

    openAiWs.on("close", () => {
      console.log("OpenAI WS closed");
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

    openAiWs.on("error", function(e) { console.error("OpenAI WS error:", e); });
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
