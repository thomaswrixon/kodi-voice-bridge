function normaliseCallerKey(value) {
  return String(value || "").replace(/\D/g, "");
}

function createCallerTransferRateLimit(options = {}) {
  const windowMs = Number(options.windowMs) > 0 ? Number(options.windowMs) : 5 * 60 * 1000;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const attempts = new Map();

  function check(callerNumber) {
    const key = normaliseCallerKey(callerNumber);
    if (!key) return { allowed: true, reason: "no_stable_caller_key", key: "" };
    const current = now();
    const last = attempts.get(key);
    if (Number.isFinite(last) && current - last < windowMs) {
      return {
        allowed: false,
        reason: "caller_transfer_cooldown",
        key,
        retry_after_ms: Math.max(0, windowMs - (current - last)),
      };
    }
    return { allowed: true, reason: "cooldown_clear", key };
  }

  function record(callerNumber) {
    const key = normaliseCallerKey(callerNumber);
    if (!key) return;
    const current = now();
    attempts.set(key, current);
    for (const [storedKey, timestamp] of attempts) {
      if (!Number.isFinite(timestamp) || current - timestamp > windowMs * 3) attempts.delete(storedKey);
    }
  }

  function clear(callerNumber) {
    const key = normaliseCallerKey(callerNumber);
    if (key) attempts.delete(key);
  }

  return { check, record, clear, windowMs };
}

module.exports = { createCallerTransferRateLimit };
