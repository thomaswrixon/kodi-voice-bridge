module.exports = [
  {
    id: "pour-date-multiple-matches",
    caller: "David wants the pour date for a Belmont North job but initially gives only the suburb. When asked, he gives 18 Example Street.",
    expected: ["use lookup_job_schedule", "ask for full address after multiple matches", "repeat lookup", "give only the confirmed Pour Concrete calendar date"],
    toolResults: [
      { status: "multiple_matches", message: "Ask for the full address or job number.", matches: [{ address: "18 Example Street, Belmont North" }, { address: "42 Sample Road, Belmont North" }] },
      { status: "single_match", job: { address: "18 Example Street, Belmont North" }, activities: [{ name: "Formwork", date: "2026-08-15" }, { name: "Pour Concrete", date: "2026-08-18" }], message: "Job and confirmed labour activity dates found." }
    ]
  },
  {
    id: "pour-date-not-found",
    caller: "Sarah asks when an unknown Warners Bay job is being poured and can provide a full address.",
    expected: ["use lookup_job_schedule", "do not invent a date", "offer Tommy callback", "confirm number only if callback required"],
    toolResults: [{ status: "not_found", message: "No matching LCM job was found." }]
  },
  {
    id: "single-confirmed-pour",
    caller: "Michael gives a unique job number and asks for its pour date.",
    expected: ["use lookup_job_schedule", "read Pour Concrete from activities", "give confirmed date", "do not ask unnecessary questions"],
    toolResults: [{ status: "single_match", job: { job_number: "210962", address: "24 Davoren Road, Lochinvar" }, activities: [{ name: "Formwork", date: "2026-08-17" }, { name: "Pod and Steel", date: "2026-08-18" }, { name: "Pour Concrete", date: "2026-08-20" }], message: "Job and confirmed labour activity dates found." }]
  },
  {
    id: "job-without-confirmed-pour",
    caller: "Emma asks for a pour date. The job exists and other labour activities have dates, but Pour Concrete does not.",
    expected: ["read activities", "do not use another activity date as the pour date", "explain no confirmed pour date", "arrange callback if needed"],
    toolResults: [{ status: "single_match", job: { address: "8 Test Avenue, Cardiff" }, activities: [{ name: "Formwork", date: "2026-08-22" }, { name: "Pod and Steel", date: "2026-08-25" }], message: "Job found; only confirmed labour activity dates are returned." }]
  },
  {
    id: "quote-request",
    caller: "Ben asks for a price for an exposed aggregate driveway.",
    expected: ["never quote a price", "collect useful enquiry details", "arrange callback"]
  },
  {
    id: "caller-hangs-up-early",
    caller: "A rushed caller gives only the name Jess and says she has to go.",
    expected: ["keep reply short", "save available information", "do not claim callback number confirmed"]
  }
];
