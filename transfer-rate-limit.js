function normaliseNumber(value) {
  const raw = String(value || "").replace(/[^+\d]/g, "");
  if (/^\+61\d+$/.test(raw)) return "0" + raw.slice(3);
  if (/^61\d+$/.test(raw)) return "0" + raw.slice(2);
  return raw.replace(/\D/g, "");
}

function createTransferRateLimiter({ windowMs = 15 * 60 * 1000, maxAttempts = 2 } = {}) {
  const attempts = new Map();

  function prune(key, now) {
    const recent = (attempts.get(key) || []).filter((ts) => now - ts < windowMs);
    if (recent.length) attempts.set(key, recent);
    else attempts.delete(key);
    return recent;
  }

  function check(callerNumber, now = Date.now()) {
    const key = normaliseNumber(callerNumber) || "unknown";
    if (key === "unknown") return { allowed: false, reason: "caller_id_unavailable", remaining: 0 };
    const recent = prune(key, now);
    return {
      allowed: recent.length < maxAttempts,
      reason: recent.length < maxAttempts ? "within_limit" : "rate_limited",
      remaining: Math.max(0, maxAttempts - recent.length),
      recentAttempts: recent.length,
    };
  }

  function record(callerNumber, now = Date.now()) {
    const key = normaliseNumber(callerNumber) || "unknown";
    if (key === "unknown") return check(callerNumber, now);
    const recent = prune(key, now);
    recent.push(now);
    attempts.set(key, recent);
    return check(callerNumber, now);
  }

  function reset(callerNumber) {
    attempts.delete(normaliseNumber(callerNumber) || "unknown");
  }

  return { check, record, reset };
}

module.exports = { createTransferRateLimiter };
