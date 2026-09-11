function confirmedName(turns, contact) {
  // A transcript can mishear a name. Never use it to rename a trusted contact.
  if (contact && !contact.contact_conflict && contact.name) return contact.name;
  // For unknown callers, acknowledgements never establish a name.
  const denied = /^(yes|yeah|yep|no|nah|okay|ok|thanks|thank|your|his|her|my|calling|speaking|looking|trying|not|a|an|the)$/i;
  for (const turn of [...turns].reverse()) {
    if (turn.role !== 'user') continue;
    const match = String(turn.content || '').trim().match(/^(?:(?:hi|hello|hey)[, ]+)?(?:(?:my name is|this is|i am|i'm|it's)\s+([a-z][a-z'-]{1,30})\b|([a-z][a-z'-]{1,30})\s+here\b)/i);
    const name = match && (match[1] || match[2]);
    if (name && !denied.test(name)) return name;
  }
  return '';
}

function createCallSaver(write) {
  let id = '';
  let chain = Promise.resolve();
  return (payload) => {
    const result = chain.catch(() => {}).then(async () => {
      const record = await write(id, payload);
      if (!record || !record.id) throw new Error('Call save returned no record ID');
      id = record.id;
      return record;
    });
    chain = result;
    return result;
  };
}

function isGoodbye(text) {
  return /(?:^|\b)(?:goodbye|bye|see ya|see you|take care|cheers|have a (?:good|great) (?:day|night|weekend))[.! ,]*$/i.test(String(text || '').trim());
}

module.exports = { confirmedName, createCallSaver, isGoodbye };
