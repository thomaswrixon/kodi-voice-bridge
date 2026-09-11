function applyCallAuditPatches(source, replaceOnce) {
  const swap = (a, b, label) => { source = replaceOnce(source, a, b, label); };
  swap('  let initialGreetingStarted = false;', `  let initialGreetingStarted = false;
  let callEnded = false;
  let contactUpdated = false;
  let closeScheduled = false;
  let audioQueuedUntil = 0;
  const { confirmedName, createCallSaver, isGoodbye } = require('./call-audit-policy');
  const persistCall = createCallSaver(async function(id, payload) {
    const response = await fetch(BASE44_API_BASE + (id ? '/' + encodeURIComponent(id) : ''), {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json', api_key: BASE44_API_KEY },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('Call save HTTP ' + response.status);
    const record = await response.json();
    if (!record.id) throw new Error('Call save returned no record ID');
    savedByTool = true;
    return record;
  });
  function callPayload() {
    return {
      call_sid: callSid || '', caller_number: callerNumber || 'unknown',
      from_name: lastSavedCallerName,
      message: lastSavedReason || transcript.filter(t => t.role === 'user').map(t => t.content).join(' | '),
      channel: 'call', status: 'completed', history: JSON.stringify(transcript), briefed: false,
    };
  }
  function finishAfterAudio() {
    if (closeScheduled || callEnded || transferInProgress) return;
    closeScheduled = true;
    const delay = Math.max(500, audioQueuedUntil - Date.now() + 400);
    setTimeout(function() {
      if (callEnded || transferInProgress) return;
      callEnded = true;
      hangUpCall();
      if (openAiWs) openAiWs.close();
    }, delay);
  }`, 'audited call state');

  // A save result is bookkeeping, not an invitation for another spoken turn.
  const saveStart = source.indexOf('        if (fnName === "save_caller_info") {\n          try {');
  const saveEnd = source.indexOf('        if (fnName === "hang_up") {', saveStart);
  if (saveStart < 0 || saveEnd < 0) throw new Error('Missing save handler boundaries');
  source = source.slice(0, saveStart) + `        if (fnName === "save_caller_info") {
          let output;
          try {
            const contact = await callerContactPromise.catch(() => null);
            lastSavedCallerName = confirmedName(transcript, contact);
            lastSavedReason = (fnArgs.reason || '') + (fnArgs.notes ? ' - ' + fnArgs.notes : '');
            const record = await persistCall(callPayload());
            output = JSON.stringify({ status: 'saved', id: record.id });
            if (!contactUpdated && direction === 'inbound') {
              contactUpdated = true;
              upsertCallerContact(callerNumber, lastSavedCallerName, lastSavedReason).catch(error => console.error('Contact update failed:', error.message));
            }
          } catch (error) {
            console.error('Call save failed:', callSid, error.message);
            output = JSON.stringify({ status: 'save_failed', message: 'The request was not saved. Do not claim success.' });
          }
          if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(JSON.stringify({ type: 'conversation.item.create', item: {
              type: 'function_call_output', call_id: msg.call_id, output,
            }}));
          }
          if (closingSpoken) finishAfterAudio();
        }

` + source.slice(saveEnd);

  // Serialize close fallback through the same record writer, including final turns.
  const fallbackStart = source.indexOf('      if (transcript.length > 0 && callerNumber && !savedByTool) {');
  const fallbackEnd = source.indexOf('\n    });', fallbackStart);
  if (fallbackStart < 0 || fallbackEnd < 0) throw new Error('Missing fallback save boundaries');
  source = source.slice(0, fallbackStart) + `      callEnded = true;
      if (callerNumber && callSid) {
        callerContactPromise.catch(() => null).then(function(contact) {
          lastSavedCallerName = confirmedName(transcript, contact);
          return persistCall(callPayload());
        }).catch(function(error) { console.error('Final save error:', callSid, error.message); });
      }` + source.slice(fallbackEnd);

  swap('      caller_name: lastSavedCallerName || (resumeState && resumeState.callerName) || "",',
    '      caller_name: confirmedName(transcript, await callerContactPromise.catch(() => null)) || (resumeState && resumeState.callerName) || "",', 'email identity');
  swap('      const msg = JSON.parse(data.toString());\n\n      if (msg.type === "error")',
    '      const msg = JSON.parse(data.toString());\n      if (callEnded || (closeScheduled && msg.type === "response.output_audio.delta")) return;\n\n      if (msg.type === "error")', 'closed socket response guard');
  swap('      if (msg.type === "response.output_audio.delta" && msg.delta) {',
    `      if (msg.type === 'response.output_audio.done' && closingSpoken && savedByTool) finishAfterAudio();
      if (msg.type === "response.output_audio.delta" && msg.delta) {
        audioQueuedUntil = Math.max(Date.now(), audioQueuedUntil) + Buffer.from(msg.delta, 'base64').length / 8;`, 'track queued audio');
  const closingStart = source.indexOf('        const spoken = String(msg.transcript || "").toLowerCase();');
  const closingEnd = source.indexOf('\n      }', closingStart);
  if (closingStart < 0 || closingEnd < 0) throw new Error('Missing closing detection');
  source = source.slice(0, closingStart) + `        closingSpoken = isGoodbye(msg.transcript);
        if (closingSpoken && savedByTool) finishAfterAudio();` + source.slice(closingEnd);
  swap(`            setTimeout(function() {
              hangUpCall();
              if (openAiWs) openAiWs.close();
            }, 1500);`, `            finishAfterAudio();`, 'drain closing audio');

  // Bound optional context and job requests. Missing history is never success.
  swap('BASE44_COMMUNICATIONS_BASE + "?sort=-received_at&limit=120"',
    'BASE44_COMMUNICATIONS_BASE + "?sort=-created_date&limit=120"', 'stable history sort');
  swap('if (!response.ok) throw new Error("Communication lookup failed with HTTP " + response.status);',
    'if (!response.ok) throw new Error("Communication lookup failed with HTTP " + response.status);', 'history contract marker');
  source = source.replaceAll('headers: { "api_key": BASE44_API_KEY },',
    'headers: { "api_key": BASE44_API_KEY }, signal: AbortSignal.timeout(1800),');
  swap('      body: JSON.stringify({ action: "searchJobs", query: searchQuery }),',
    '      body: JSON.stringify({ action: "searchJobs", query: searchQuery }),\n      signal: AbortSignal.timeout(8000),', 'job lookup timeout');
  swap('  if (builderJobNumber) query.job_number = builderJobNumber;',
    '  if (builderJobNumber) query.job_number = builderJobNumber;', 'builder marker');
  swap('  if (suburb) query.suburb = suburb;\n',
    `  if (suburb) query.suburb = suburb;
  if (builderJobNumber) {
    delete query.address;
    delete query.suburb;
  }
`, 'independent builder lookup');
  // Do not silently change digits and then confirm a different job.
  const retryStart = source.indexOf('    // Realtime speech can occasionally duplicate one digit');
  const retryEnd = source.indexOf('\n  if (jobs.length === 0)', retryStart);
  if (retryStart < 0 || retryEnd < 0) throw new Error('Missing repeated-digit retry');
  source = source.slice(0, retryStart) + '  }\n' + source.slice(retryEnd);
  return source;
}
module.exports = { applyCallAuditPatches };
