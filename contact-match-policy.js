function normaliseName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9' -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstName(value) {
  return normaliseName(value).split(/\s+/)[0] || "";
}

function resolveCallerContactMatch(matches) {
  const rows = Array.isArray(matches) ? matches.filter(Boolean) : [];
  if (!rows.length) return null;

  const named = rows.filter((contact) => normaliseName(contact.name));
  const namedFamily = named.filter((contact) => contact.is_friends_family === true);
  const familyRows = rows.filter((contact) => contact.is_friends_family === true);

  // Imported Contact data contains stale blank/default duplicate rows. Those rows
  // must not cancel a deliberate Friends/Family heart on the same phone number.
  // A real identity conflict is when named rows disagree on who owns the number.
  const firstNames = new Set(named.map((contact) => firstName(contact.name)).filter(Boolean));
  const contactConflict = firstNames.size > 1;

  const preferred = namedFamily[0]
    || named[0]
    || familyRows[0]
    || rows[0];

  if (contactConflict) {
    return {
      ...preferred,
      is_friends_family: false,
      relationship: "",
      contact_conflict: true,
    };
  }

  return {
    ...preferred,
    is_friends_family: familyRows.length > 0,
    relationship: (namedFamily[0] || familyRows[0] || preferred).relationship || "",
    contact_conflict: false,
  };
}

module.exports = { resolveCallerContactMatch };
