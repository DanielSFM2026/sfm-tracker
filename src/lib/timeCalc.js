const DAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

// ── Internal: build [{start, end}] intervals from a single job's events ──────

function getIntervals(events, asOf = new Date()) {
  const sorted = [...events].sort(
    (a, b) => new Date(a.event_timestamp) - new Date(b.event_timestamp)
  )
  const intervals = []
  let openStart = null

  for (const ev of sorted) {
    if (ev.event_type === 'START' || ev.event_type === 'RESUME') {
      openStart = new Date(ev.event_timestamp)
    } else if (
      ev.event_type === 'PAUSE' ||
      ev.event_type === 'COMPLETE' ||
      ev.event_type === 'AUTO_LOGOUT'
    ) {
      if (openStart) {
        intervals.push({ start: openStart, end: new Date(ev.event_timestamp) })
        openStart = null
      }
    }
  }
  if (openStart) intervals.push({ start: openStart, end: asOf })
  return intervals
}

// ── Internal: subtract break windows from a millisecond value ────────────────

function subtractBreaks(ms, start, end, breakRules) {
  const dayNum = start.getDay()
  for (const rule of breakRules) {
    if (DAY_MAP[rule.weekday] !== dayNum) continue
    const [bh, bm] = rule.start_time.split(':')
    const bStart = new Date(start)
    bStart.setHours(+bh, +bm, 0, 0)
    const bEnd = new Date(bStart)
    bEnd.setMinutes(bEnd.getMinutes() + rule.duration_minutes)
    const oStart = Math.max(start.getTime(), bStart.getTime())
    const oEnd   = Math.min(end.getTime(),   bEnd.getTime())
    if (oEnd > oStart) ms -= oEnd - oStart
  }
  return ms
}

// ── Standard accrued time (all closed + open intervals) ─────────────────────

export function calcAccruedMs(events, breakRules, asOf = new Date()) {
  let totalMs = 0
  for (const { start, end } of getIntervals(events, asOf)) {
    let ms = end.getTime() - start.getTime()
    ms = subtractBreaks(ms, start, end, breakRules)
    totalMs += ms
  }
  return Math.max(0, totalMs)
}

// ── Returns the start of the current open interval, or null if paused ────────

export function getOpenStart(events) {
  const sorted = [...events].sort(
    (a, b) => new Date(b.event_timestamp) - new Date(a.event_timestamp)
  )
  for (const ev of sorted) {
    if (ev.event_type === 'START' || ev.event_type === 'RESUME')
      return new Date(ev.event_timestamp)
    if (['PAUSE', 'COMPLETE', 'AUTO_LOGOUT'].includes(ev.event_type))
      return null
  }
  return null
}

// ── Split-aware elapsed time ──────────────────────────────────────────────────
//
// Historical (closed) intervals always get full credit — split mode only
// affects the CURRENT open interval, dividing it equally across splitCount jobs.
// This means toggling split on/off never retroactively changes past time.

export function calcElapsed(events, breakRules, splitCount = 1, asOf = new Date()) {
  const openStart = getOpenStart(events)

  // Job is paused — just return total historical time
  if (!openStart) return calcAccruedMs(events, breakRules, asOf)

  // Historical time: everything up to when the current interval started
  const historicalMs = calcAccruedMs(events, breakRules, openStart)

  // Current interval time (with break deduction)
  const fullMs    = calcAccruedMs(events, breakRules, asOf)
  let currentMs   = fullMs - historicalMs

  // Only divide the live portion
  if (splitCount > 1) currentMs = currentMs / splitCount

  return Math.max(0, historicalMs + currentMs)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function isJobActive(events) {
  const relevant = events.filter(e =>
    ['START','RESUME','PAUSE','COMPLETE','AUTO_LOGOUT'].includes(e.event_type)
  )
  if (!relevant.length) return false
  const last = relevant.reduce((a, b) =>
    new Date(a.event_timestamp) > new Date(b.event_timestamp) ? a : b
  )
  return last.event_type === 'START' || last.event_type === 'RESUME'
}

export function parseJobBarcode(raw) {
  const trimmed = raw.trim()
  const idx = trimmed.indexOf('/')
  if (idx < 1) return null
  return {
    poNumber:   trimmed.slice(0, idx).trim(),
    partNumber: trimmed.slice(idx + 1).trim()
  }
}
