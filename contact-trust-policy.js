function normaliseName(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function looksLikePhoneName(value) {
  return /^\+?[\d\s()-]{7,}$/.test(String(value || "").trim());
}

function selectCallerContact(matches = []) {
  const rows = (Array.isArray(matches) ? matches : []).filter(Boolean);
  if (!rows.length) return null;

  const named = rows.filter((row) => String(row.name || "").trim() && !looksLikePhoneName(row.name));
  const distinctNames = [...new Set(named.map((row) => normaliseName(row.name)).filter(Boolean))];
  const trusted = rows.filter((row) => row.is_friends_family === true);

  // Same phone number mapped to different human identities is a recycled-number,
  // stale-import or data-corruption signal. Never grant Friends/Family privilege
  // from that ambiguous number until the database is corrected.
  if (trusted.length && distinctNames.length > 1) {
    const preferred = named[0] || trusted[0] || rows[0];
    return {
      ...preferred,
      is_friends_family: false,
      relationship: "",
      trust_conflict: true,
      trust_conflict_reason: "conflicting_contact_names",
    };
  }

  const preferred = trusted[0] || named[0] || rows[0];
  return {
    ...preferred,
    trust_conflict: false,
  };
}

module.exports = { selectCallerContact };
