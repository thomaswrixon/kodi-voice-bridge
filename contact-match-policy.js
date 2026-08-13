function normaliseName(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function resolveCallerContactMatch(matches) {
  const rows = Array.isArray(matches) ? matches.filter(Boolean) : [];
  if (!rows.length) return null;

  const named = rows.filter((contact) => normaliseName(contact.name));
  const preferred = rows.find((contact) => contact.is_friends_family === true)
    || named[0]
    || rows[0];

  const familyStates = new Set(rows.map((contact) => contact.is_friends_family === true ? "family" : "ordinary"));
  const names = new Set(named.map((contact) => normaliseName(contact.name)));
  const contactConflict = familyStates.size > 1 || names.size > 1;

  if (!contactConflict) return { ...preferred, contact_conflict: false };

  return {
    ...preferred,
    is_friends_family: false,
    relationship: "",
    contact_conflict: true,
  };
}

module.exports = { resolveCallerContactMatch };
