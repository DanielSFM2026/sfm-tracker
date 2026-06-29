const DAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

// ── Internal: build [{start, end, splitCount}] intervals from a job's events ──
// split_count is stored on each START/RESUME event in the DB (DEFAULT 1).
// Storing it per-interval means turning split on/off PERMANENTLY bakes the
// divided time into history — toggling does not retroactively change past time.

function getIntervals(events, asOf = new Date()) {
  const sorted = [...events].sort(
    (a, b) => new Date(a.event_timestamp) - new Date(b.event_timestamp)
  )
  const intervals = []
  let openStart      = null
  let openSplitCount = 1

  for (const ev of sorted) {
    if (ev.event_type === 'START' || ev.event_type === 'RESUME') {
      openStart      = new Date(ev.event_timestamp)
      openSplitCount = ev.split_count ?? 1
    } else if (
      ev.event_type === 'PAUSE' ||
      ev.event_type === 'COMPLETE' ||
      ev.event_type === 'AUTO_LOGOUT'
    ) {
      if (openStart) {
        intervals.push({ start: openStart, end: new Date(ev.event_timestamp), splitCount: openSplitCount })
        openStart = null
      }
    }
  }
  if (openStart) intervals.push({ start: openStart, end: asOf, splitCount: openSplitCount })
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

// ── Standard accrued time — each interval divided by its stored split_count ──

export function calcAccruedMs(events, breakRules, asOf = new Date()) {
  let totalMs = 0
  for (const { start, end, splitCount } of getIntervals(events, asOf)) {
    let ms = end.getTime() - start.getTime()
    ms = subtractBreaks(ms, start, end, breakRules)
    totalMs += Math.max(0, ms) / splitCount
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

// ── Elapsed time — split_count is now stored in events, no parameter needed ──

export function calcElapsed(events, breakRules, asOf = new Date()) {
  return calcAccruedMs(events, breakRules, asOf)
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
