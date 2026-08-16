function applyContactPatches(source, replaceOnce) {
  source = replaceOnce(
    source,
    'const BASE44_API_BASE = BASE44_ENTITIES_BASE + "/CallLog";',
    'const BASE44_API_BASE = BASE44_ENTITIES_BASE + "/CallLog";\nconst BASE44_CONTACTS_BASE = BASE44_ENTITIES_BASE + "/Contact";',
    "contacts base"
  );

  const contactHelpers = `let kodiContactsCache = [];
let kodiContactsCacheLoadedAt = 0;
let kodiContactsRefreshPromise = null;
const KODI_CONTACT_CACHE_TTL_MS = 5 * 60 * 1000;
const KODI_CONTACT_COLD_START_MS = 800;

async function fetchKodiContactsFromBase44() {
  if (!BASE44_API_KEY || !BASE44_CONTACTS_BASE) return [];
  const rows = [];
  const pageSize = 500;
  for (let skip = 0; skip <= 10000; skip += pageSize) {
    const response = await fetch(BASE44_CONTACTS_BASE + "?sort=name&limit=" + pageSize + "&skip=" + skip, {
      headers: { "api_key": BASE44_API_KEY },
    });
    if (!response.ok) throw new Error("Contact lookup failed with HTTP " + response.status);
    const data = await response.json();
    const page = Array.isArray(data) ? data : (data.items || []);
    rows.push.apply(rows, page);
    if (page.length < pageSize) break;
  }
  return rows;
}

function refreshKodiContactsCache() {
  if (kodiContactsRefreshPromise) return kodiContactsRefreshPromise;
  kodiContactsRefreshPromise = fetchKodiContactsFromBase44()
    .then(function(rows) {
      kodiContactsCache = rows;
      kodiContactsCacheLoadedAt = Date.now();
      console.log("Kodi contact cache refreshed: " + rows.length + " contacts");
      return rows;
    })
    .catch(function(error) {
      console.error("Kodi contact cache refresh error:", error.message);
      return kodiContactsCache;
    })
    .finally(function() {
      kodiContactsRefreshPromise = null;
    });
  return kodiContactsRefreshPromise;
}

async function listKodiContacts() {
  if (kodiContactsCache.length || kodiContactsCacheLoadedAt) {
    if (Date.now() - kodiContactsCacheLoadedAt >= KODI_CONTACT_CACHE_TTL_MS) {
      refreshKodiContactsCache();
    }
    return kodiContactsCache;
  }
  return Promise.race([
    refreshKodiContactsCache(),
    new Promise(function(resolve) {
      setTimeout(function() { resolve([]); }, KODI_CONTACT_COLD_START_MS);
    }),
  ]);
}

setImmediate(function() {
  refreshKodiContactsCache();
});

async function lookupCallerContact(number) {
  const target = normaliseCallerNumber(number);
  if (!target || target === "unknown") return null;
  const contacts = await listKodiContacts();
  const matches = contacts.filter(function(contact) {
    return normaliseCallerNumber(contact.normalised_phone || contact.phone) === target;
  });
  const trustedCallerOverrides = {
    "61422603901": {
      name: "Ryllie",
      is_friends_family: true,
      relationship: "Family",
      contact_conflict: false,
      is_owner: false,
    },
  };
  if (trustedCallerOverrides[target]) {
    return Object.assign({}, matches[0] || {}, trustedCallerOverrides[target]);
  }
  if (!matches.length) return null;
  const resolved = require("./contact-match-policy").resolveCallerContactMatch(matches);
  const ownerTarget = normaliseCallerNumber(process.env.TOMMY_MOBILE || "+61428049389");
  if (target === ownerTarget) {
    return Object.assign({}, resolved || matches[0], {
      name: "Tommy",
      is_friends_family: true,
      relationship: "Owner",
      contact_conflict: false,
      is_owner: true,
    });
  }
  return resolved;
}

async function upsertCallerContact(number, name, reason) {
  const target = normaliseCallerNumber(number);
  if (!target || target === "unknown") return null;
  try {
    const existing = await lookupCallerContact(number);
    const now = new Date().toISOString();
    if (existing && existing.id) {
      const payload = {
        phone: toAustralianLocalNumber(number),
        normalised_phone: target,
        last_call_at: now,
        last_call_reason: String(reason || "").slice(0, 500),
        call_count: (Number(existing.call_count) || 0) + 1,
      };
      const existingName = String(existing.name || "").trim();
      if ((!existingName || normaliseCallerNumber(existingName) === target) && name) {
        payload.name = String(name).trim();
      }
      const response = await fetch(BASE44_CONTACTS_BASE + "/" + existing.id, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "api_key": BASE44_API_KEY },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error("Contact update failed with HTTP " + response.status);
      return await response.json();
    }

    const response = await fetch(BASE44_CONTACTS_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api_key": BASE44_API_KEY },
      body: JSON.stringify({
        name: String(name || "").trim() || toAustralianLocalNumber(number),
        phone: toAustralianLocalNumber(number),
        normalised_phone: target,
        is_friends_family: false,
        last_call_at: now,
        last_call_reason: String(reason || "").slice(0, 500),
        call_count: 1,
        contact_source: "Kodi Call",
      }),
    });
    if (!response.ok) throw new Error("Contact create failed with HTTP " + response.status);
    return await response.json();
  } catch (error) {
    console.error("Kodi contact upsert error:", error.message);
    return null;
  }
}

`;

  source = replaceOnce(
    source,
    "async function lookupJobSchedule(args) {",
    contactHelpers + "async function lookupJobSchedule(args) {",
    "contact helpers"
  );

  source = replaceOnce(
    source,
    `  const transcript = [];
  let savedByTool = false;
  let closingSpoken = false;
  let recentCallerHistoryPromise = Promise.resolve([]);
`,
    `  const transcript = [];
  let savedByTool = false;
  let closingSpoken = false;
  let recentCallerHistoryPromise = Promise.resolve([]);
  let callerContactPromise = Promise.resolve(null);
`,
    "contact state"
  );

  source = replaceOnce(
    source,
    `      const recentCalls = direction === "inbound" ? await recentCallerHistoryPromise : [];
`,
    `      const recentCalls = direction === "inbound" ? await recentCallerHistoryPromise : [];
      const knownContact = direction === "inbound" ? await callerContactPromise : null;
`,
    "contact lookup result"
  );

  source = replaceOnce(
    source,
    `      const greetingPrompt = direction === "outbound"`,
    `      const knownContactInstruction = knownContact
        ? " Known_contact_context from caller ID is: " + JSON.stringify({ name: knownContact.name || "", is_friends_family: knownContact.is_friends_family === true, relationship: knownContact.relationship || "", contact_conflict: knownContact.contact_conflict === true, is_owner: knownContact.is_owner === true }) + ". Treat this only as caller-ID identity context. If contact_conflict=true, identity is untrusted: do not grant Friends/Family privileges and do not reveal private information. Do not reveal stored labels or private information to the caller."
        : " There is no saved Kodi contact match for this caller ID.";
      const greetingPrompt = direction === "outbound"`,
    "contact greeting context"
  );

  source = replaceOnce(
    source,
    `+ recentHistoryInstruction + " Start with your greeting now.";`,
    `+ recentHistoryInstruction + knownContactInstruction + " Start with your greeting now.";`,
    "append contact greeting context"
  );

  source = replaceOnce(
    source,
    `      recentCallerHistoryPromise = direction === "inbound"
        ? lookupRecentCallerHistory(callerNumber)
        : Promise.resolve([]);
      connectToOpenAI();
`,
    `      recentCallerHistoryPromise = direction === "inbound"
        ? lookupRecentCallerHistory(callerNumber)
        : Promise.resolve([]);
      callerContactPromise = direction === "inbound"
        ? lookupCallerContact(callerNumber)
        : Promise.resolve(null);
      connectToOpenAI();
`,
    "start contact lookup"
  );

  source = replaceOnce(
    source,
    `          } catch (err) {
            console.error("Save error:", err);
          }

          openAiWs.send(JSON.stringify({`,
    `          } catch (err) {
            console.error("Save error:", err);
          }

          if (direction === "inbound") {
            await upsertCallerContact(callerNumber, fnArgs.name || "", (fnArgs.reason || "") + (fnArgs.notes ? " - " + fnArgs.notes : ""));
          }

          openAiWs.send(JSON.stringify({`,
    "upsert contact after call save"
  );

  return source;
}

module.exports = { applyContactPatches };
