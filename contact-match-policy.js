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
  const firstNames = new Set(named.map((contact) => firstName(contact.name)).filter(Boolean));
  const contactConflict = firstNames.size > 1;

  const preferred = namedFamily[0] || named[0] || familyRows[0] || rows[0];

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
