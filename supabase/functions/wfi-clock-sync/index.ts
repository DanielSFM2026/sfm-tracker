// WFI Clock Sync — pulls clock swipes from Workflow Infinity and pauses/resumes
// tracker jobs so workers only scan between jobs, not at start/end of day.
//
// Runs on a pg_cron schedule (every 2 min). Secrets required (Edge Function secrets):
//   WFI_USERNAME, WFI_PASSWORD  — a Workflow Infinity login able to run the
//   "Personnel Clockings Over Date Range" report.
//
// Logic per new swipe, per tracker employee with matching wfi_id:
//   - jobs whose last event is START/RESUME       -> insert AUTO_LOGOUT (hold_reason CLOCKED_OUT)
//   - else jobs whose last event is that AUTO_LOGOUT -> insert RESUME (restores line/split)
//   - manual holds / manager pauses are never touched
// Causality guard: a swipe never acts on a job whose last event is NEWER than
// the swipe itself (protects against processing stale swipes after downtime).

import { createClient } from 'jsr:@supabase/supabase-js@2'

const WFI_BASE = 'https://sfmengineering.workflowinfinity.com/Roster'
const REPORT_PATH = '/data-explorer/report/.Attendance.Personnel%20Clockings%20Over%20Date%20Range%20Report/'
const DEBOUNCE_MS = 3 * 60 * 1000

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
}

// ── Europe/London → UTC ──────────────────────────────────────────────────────
function londonOffsetMinutes(utcMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  })
  const p = Object.fromEntries(dtf.formatToParts(utcMs).map(x => [x.type, x.value]))
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute)
  return (asUtc - utcMs) / 60000
}

function londonToUtcIso(y: number, mo: number, d: number, hh: number, mm: number): string {
  const guess = Date.UTC(y, mo - 1, d, hh, mm)
  return new Date(guess - londonOffsetMinutes(guess) * 60000).toISOString()
}

function todayInLondon(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date())
}

// "3rd July 2026 05:40" → UTC ISO string (or null)
function parseSwipe(text: string): string | null {
  const m = text.trim().match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})\s+(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const month = MONTHS[m[2].toLowerCase()]
  if (!month) return null
  return londonToUtcIso(+m[3], month, +m[1], +m[4], +m[5])
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
}

// ── Workflow Infinity ────────────────────────────────────────────────────────
function collectCookies(res: Response, jar: Map<string, string>) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';')
    const eq = pair.indexOf('=')
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

async function wfiLogin(username: string, password: string): Promise<Map<string, string>> {
  const jar = new Map<string, string>()
  const page = await fetch(`${WFI_BASE}/login`, { redirect: 'manual' })
  collectCookies(page, jar)
  await page.body?.cancel()

  const body = new URLSearchParams({ redirect_on_success: '', passkey_json: '', username, password })
  const res = await fetch(`${WFI_BASE}/login/process`, {
    method: 'POST', body, redirect: 'manual',
    headers: { cookie: cookieHeader(jar) }
  })
  collectCookies(res, jar)
  await res.body?.cancel()
  const loc = res.headers.get('location') ?? ''
  if (res.status !== 302 || loc.includes('login')) {
    throw new Error(`WFI login failed (status ${res.status}, redirected to ${loc || 'nowhere'})`)
  }
  return jar
}

interface Swipe { wfiId: number; name: string; ts: string }

async function fetchTodaysSwipes(jar: Map<string, string>): Promise<Swipe[]> {
  const day = todayInLondon()
  const body = new URLSearchParams([
    ['action', ''],
    ['download_token', Date.now().toString()],
    ['date_range[]', `${day} 00:00:00`],
    ['date_range[]', `${day} 23:59:59`]
  ])
  const res = await fetch(WFI_BASE + REPORT_PATH, {
    method: 'POST', body, headers: { cookie: cookieHeader(jar) }
  })
  const html = await res.text()
  if (res.status !== 200) throw new Error(`WFI report request failed: ${res.status}`)
  if (html.includes('Login | Workflow Infinity')) throw new Error('WFI session rejected — got login page')

  // Rows: ID | First | Last | Badge | Payroll | Date | Swipe | Terminal
  const swipes: Swipe[] = []
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(c => decodeEntities(c[1].replace(/<[^>]*>/g, '')).trim())
    if (cells.length < 7) continue
    const wfiId = parseInt(cells[0], 10)
    const ts = parseSwipe(cells[6])
    if (!Number.isFinite(wfiId) || !ts) continue
    swipes.push({ wfiId, name: `${cells[1]} ${cells[2]}`, ts })
  }
  swipes.sort((a, b) => a.ts.localeCompare(b.ts))
  return swipes
}

// ── Tracker job state ────────────────────────────────────────────────────────
interface JobState {
  job_id: number
  lastType: string
  lastHoldReason: string | null
  lastTs: string
  line_id: number | null
  activity_type: string | null
  work_type: string | null
  split_count: number
}

// deno-lint-ignore no-explicit-any
async function deriveJobStates(sb: any, employeeId: number): Promise<JobState[]> {
  const { data, error } = await sb
    .from('job_events')
    .select('job_id, event_type, hold_reason, line_id, activity_type, work_type, split_count, event_timestamp')
    .eq('employee_id', employeeId)
    .in('event_type', ['START', 'PAUSE', 'RESUME', 'COMPLETE', 'AUTO_LOGOUT'])
    .order('event_timestamp', { ascending: true })
    .order('event_id', { ascending: true })
  if (error) throw error

  const map = new Map<number, JobState>()
  for (const ev of data ?? []) {
    const prev = map.get(ev.job_id)
    const isWork = ev.event_type === 'START' || ev.event_type === 'RESUME'
    map.set(ev.job_id, {
      job_id: ev.job_id,
      lastType: ev.event_type,
      lastHoldReason: ev.hold_reason ?? null,
      lastTs: ev.event_timestamp,
      line_id: ev.line_id ?? prev?.line_id ?? null,
      activity_type: isWork ? (ev.activity_type ?? null) : (prev?.activity_type ?? null),
      work_type: isWork ? (ev.work_type ?? null) : (prev?.work_type ?? null),
      split_count: isWork ? (ev.split_count ?? 1) : (prev?.split_count ?? 1)
    })
  }
  return [...map.values()]
}

// deno-lint-ignore no-explicit-any
async function anyOtherMemberActive(sb: any, jobId: number, employeeId: number): Promise<boolean> {
  const { data, error } = await sb
    .from('job_events')
    .select('employee_id, event_type, event_timestamp')
    .eq('job_id', jobId)
    .neq('employee_id', employeeId)
    .in('event_type', ['START', 'PAUSE', 'RESUME', 'COMPLETE', 'AUTO_LOGOUT'])
    .order('event_timestamp', { ascending: true })
  if (error) throw error
  const last = new Map<number, string>()
  for (const ev of data ?? []) last.set(ev.employee_id, ev.event_type)
  return [...last.values()].some(t => t === 'START' || t === 'RESUME')
}

Deno.serve(async () => {
  try {
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )
    const user = Deno.env.get('WFI_USERNAME')
    const pass = Deno.env.get('WFI_PASSWORD')
    if (!user || !pass) throw new Error('WFI_USERNAME / WFI_PASSWORD secrets not set')

    const jar = await wfiLogin(user, pass)
    const swipes = await fetchTodaysSwipes(jar)

    // Already-processed swipes for today
    const dayStartUtc = londonToUtcIso(+todayInLondon().slice(0, 4), +todayInLondon().slice(5, 7), +todayInLondon().slice(8, 10), 0, 0)
    const { data: doneRows, error: doneErr } = await sb
      .from('clock_swipes').select('wfi_id, swipe_ts').gte('swipe_ts', dayStartUtc)
    if (doneErr) throw doneErr
    const done = new Set((doneRows ?? []).map((r: { wfi_id: number; swipe_ts: string }) =>
      `${r.wfi_id}|${new Date(r.swipe_ts).toISOString()}`))

    // Latest swipe time per person (for debounce), seeded from processed rows
    const lastSwipeByPerson = new Map<number, number>()
    for (const r of doneRows ?? []) {
      const t = new Date(r.swipe_ts).getTime()
      if (t > (lastSwipeByPerson.get(r.wfi_id) ?? 0)) lastSwipeByPerson.set(r.wfi_id, t)
    }

    let paused = 0, resumed = 0, processed = 0
    const notes: string[] = []

    for (const swipe of swipes) {
      const key = `${swipe.wfiId}|${swipe.ts}`
      if (done.has(key)) continue
      processed++
      const swipeMs = new Date(swipe.ts).getTime()
      const sinceLast = swipeMs - (lastSwipeByPerson.get(swipe.wfiId) ?? 0)
      lastSwipeByPerson.set(swipe.wfiId, swipeMs)

      let action = 'no_tracker_employee'

      if (sinceLast < DEBOUNCE_MS) {
        action = 'debounced'
      } else {
        const { data: emps, error: empErr } = await sb
          .from('employees').select('employee_id, full_name')
          .eq('wfi_id', swipe.wfiId).eq('active', true)
        if (empErr) throw empErr

        const acts: string[] = []
        for (const emp of emps ?? []) {
          const states = await deriveJobStates(sb, emp.employee_id)
          // Never act on a job whose last event is newer than the swipe
          const eligible = states.filter(s => new Date(s.lastTs).getTime() < swipeMs)
          const active = eligible.filter(s => s.lastType === 'START' || s.lastType === 'RESUME')
          const clockedOut = eligible.filter(s => s.lastType === 'AUTO_LOGOUT' && s.lastHoldReason === 'CLOCKED_OUT')

          if (active.length > 0) {
            for (const s of active) {
              const { error } = await sb.from('job_events').insert({
                employee_id: emp.employee_id, job_id: s.job_id, event_type: 'AUTO_LOGOUT',
                hold_reason: 'CLOCKED_OUT', line_id: s.line_id, split_count: s.split_count,
                event_timestamp: swipe.ts
              })
              if (error) throw error
              if (!(await anyOtherMemberActive(sb, s.job_id, emp.employee_id))) {
                await sb.from('jobs').update({ status: 'paused' }).eq('job_id', s.job_id)
              }
              paused++
            }
            acts.push(`paused ${active.length} (emp ${emp.employee_id})`)
          } else if (clockedOut.length > 0) {
            for (const s of clockedOut) {
              const { error } = await sb.from('job_events').insert({
                employee_id: emp.employee_id, job_id: s.job_id, event_type: 'RESUME',
                line_id: s.line_id, activity_type: s.activity_type, work_type: s.work_type,
                split_count: s.split_count, event_timestamp: swipe.ts
              })
              if (error) throw error
              await sb.from('jobs').update({ status: 'in_progress' }).eq('job_id', s.job_id)
              resumed++
            }
            acts.push(`resumed ${clockedOut.length} (emp ${emp.employee_id})`)
          } else {
            acts.push(`no_action (emp ${emp.employee_id})`)
          }
        }
        if (acts.length) action = acts.join('; ')
      }

      const { error: insErr } = await sb.from('clock_swipes')
        .insert({ wfi_id: swipe.wfiId, swipe_ts: swipe.ts, person_name: swipe.name, action_taken: action })
      if (insErr && insErr.code !== '23505') throw insErr
      notes.push(`${swipe.name} @ ${swipe.ts}: ${action}`)
    }

    const summary = { ok: true, swipesToday: swipes.length, newSwipes: processed, paused, resumed, notes }
    console.log(JSON.stringify(summary))
    return new Response(JSON.stringify(summary), { headers: { 'content-type': 'application/json' } })
  } catch (err) {
    console.error('wfi-clock-sync failed:', err)
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { 'content-type': 'application/json' }
    })
  }
})
