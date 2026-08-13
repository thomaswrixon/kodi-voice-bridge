const url = "https://base44.app/api/apps/69c1bcc966e03d26bd89d178/functions/callTranscriptEmail";
const secret = process.env.KODI_TRANSCRIPT_EMAIL_SECRET || "";
const apiKey = process.env.BASE44_API_KEY || "";
if (!secret) throw new Error("KODI_TRANSCRIPT_EMAIL_SECRET missing");
(async () => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-kodi-transcript-secret": secret,
      ...(apiKey ? { api_key: apiKey } : {}),
    },
    body: JSON.stringify({
      call_sid: "TEST-TRANSCRIPT-EMAIL",
      caller_number: "0400000000",
      caller_name: "Kodi Transcript Test",
      completed_at: new Date().toISOString(),
      transfer_outcome: "Synthetic verification only",
      transcript: [
        { role: "user", content: "This is a synthetic transcript email verification." },
        { role: "assistant", content: "Kodi transcript email delivery test." },
      ],
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    console.error("TRANSCRIPT_EMAIL_TEST_FAILED HTTP=" + response.status + " BODY=" + text.slice(0, 300));
    process.exit(1);
  }
  console.log("TRANSCRIPT_EMAIL_TEST_OK HTTP=" + response.status + " BODY=" + text.slice(0, 300));
})().catch((error) => {
  console.error("TRANSCRIPT_EMAIL_TEST_FAILED " + error.message);
  process.exit(1);
});
