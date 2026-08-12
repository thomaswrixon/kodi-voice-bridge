const originalStringify = JSON.stringify;

function norm(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function ordinal(day) {
  const n = Number(day);
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return n + "th";
  if (n % 10 === 1) return n + "st";
  if (n % 10 === 2) return n + "nd";
  if (n % 10 === 3) return n + "rd";
  return n + "th";
}

function humanDate(iso) {
  const parts = String(iso || "").split("-").map(Number);
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return "";
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  return ordinal(parts[2]) + " " + months[parts[1] - 1] + " " + parts[0];
}

function findActivity(activities, name) {
  const wanted = norm(name);
  return activities.find(function(activity) {
    return norm(activity.name) === wanted;
  });
}

function enrichLookupResult(value) {
  if (!value || value.status !== "single_match" || !Array.isArray(value.activities)) {
    return value;
  }
  if (value.supplier_guidance) return value;

  const activities = value.activities.map(function(activity) {
    if (norm(activity.name) === "internal drains") {
      return Object.assign({}, activity, { name: "Drains" });
    }
    return activity;
  });

  const drains = findActivity(activities, "Drains");
  const sand = findActivity(activities, "Sand Up");
  const pod = findActivity(activities, "Pod and Steel");
  const pod2 = findActivity(activities, "Pod and Steel 2");
  const sandSafe = !!drains && !!sand && String(drains.calendar_date) < String(sand.calendar_date);

  const supplierGuidance = {
    sand_delivery: sandSafe
      ? {
          status: "SAFE",
          drains_date: drains.calendar_date,
          sand_up_date: sand.calendar_date,
          delivery_by: "07:00",
          response: "The sand delivery is confirmed for " + humanDate(sand.calendar_date) + " and the sand must be on site by 7:00 a.m."
        }
      : {
          status: "BLOCKED",
          drains_date: drains ? drains.calendar_date : null,
          sand_up_date: sand ? sand.calendar_date : null,
          response: "The job is in the system, but the current confirmed schedule does not let me approve the sand delivery. I will take a callback message."
        },
    pod_and_steel: pod
      ? {
          status: "CONFIRMED",
          calendar_date: pod.calendar_date,
          delivery_by: "07:00",
          response: "The confirmed Pod and Steel date is " + humanDate(pod.calendar_date) + " and the materials need to be on site by 7:00 a.m."
        }
      : { status: "UNCONFIRMED" },
    pod_and_steel_2: pod2
      ? {
          status: "CONFIRMED",
          calendar_date: pod2.calendar_date,
          delivery_by: "07:00",
          response: "The confirmed second Pod and Steel date is " + humanDate(pod2.calendar_date) + " and the materials need to be on site by 7:00 a.m."
        }
      : { status: "UNCONFIRMED" }
  };

  return Object.assign({}, value, {
    activities: activities,
    supplier_guidance: supplierGuidance
  });
}

JSON.stringify = function(value, replacer, space) {
  return originalStringify(enrichLookupResult(value), replacer, space);
};
