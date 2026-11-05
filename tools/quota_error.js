// Quota-exhausted message sent to OpenClaw. The Polish text is for the user;
// the English tail is for OpenClaw's failover classifier, which only treats an
// error as rate_limit (= try the next model) when it sees 429 / "rate limit" /
// "quota exceeded". Without it compaction (summarization) did not fall back.
function fmtDuration(ms) {
    if (ms == null) return 'nieznany czas';
    const totalSec = Math.round(ms / 1000);
    const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
}

// No square brackets: OpenClaw's diagnostic redactor treats "[... : ...]" as
// malformed JSON and replaces the WHOLE message, which hides the tag (29.10).
const FAILOVER_TAG = '(HTTP 429 rate limit, quota exceeded)';

function quotaMessage(modelName, resetMs) {
    return `Kwota (limit) modelu ${modelName} wyczerpana — reset za ${fmtDuration(resetMs)}. Wybierz inny model lub poczekaj. ${FAILOVER_TAG}`;
}

module.exports = { quotaMessage, fmtDuration, FAILOVER_TAG };
