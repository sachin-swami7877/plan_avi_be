const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30

/** Start of today in IST, expressed as a UTC Date */
function getTodayISTStart() {
  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  const y = nowIST.getUTCFullYear();
  const m = nowIST.getUTCMonth();
  const d = nowIST.getUTCDate();
  return new Date(Date.UTC(y, m, d) - IST_OFFSET_MS);
}

/**
 * Parse a "YYYY-MM-DD" date string as an IST day boundary.
 * Returns a UTC Date representing IST midnight of that day.
 */
function istStartOfDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - IST_OFFSET_MS);
}

/**
 * Parse a "YYYY-MM-DD" date string as the last millisecond of that IST day.
 * Returns a UTC Date representing 23:59:59.999 IST of that day.
 */
function istEndOfDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1) - IST_OFFSET_MS - 1);
}

module.exports = { getTodayISTStart, istStartOfDay, istEndOfDay };
