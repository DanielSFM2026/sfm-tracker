import { supabase } from './supabase'

// ── Build plan (synced from the Excel schedule) ──────────────────────────────
//
// Each department reads its PLANNED week from an orange dept column, and its
// COMPLETED week from a green stage column (filled with the week it finished).
// Values are text: a week number, or a tag like 'RM'. We only treat a bare
// integer as a real week.

export const PLAN_WEEK_COL = {
  weld:          'fab_week',   // PLANNED FAB/WELD WEEK
  kitting:       'kit_week',   // KITTED BY WEEK
  assembly:      'subs_week',  // PLANNED SUBS WEEK
  paint:         'paint_week', // PLANNED PAINT WEEK
  rubber_lining: 'kit_week',   // shares the kitting screen/flow for now
}

const PLAN_FIELDS =
  'seq_no, po_number, part_number, model, description, customer, quantity, ' +
  'customer_req_date, original_date, kit_week, fab_week, paint_week, subs_week, ' +
  'cut_week, fold_week, kitting_week, weld_week, painting_week, subassembly_week'

// Each production department has a PLANNED week column (orange, the target) and
// a COMPLETED week column (green C/F/K/W/P/S, filled with the week it finished).
export const DEPTS = [
  { key: 'kitting', label: 'Kitting',      planned: 'kit_week',   completed: 'kitting_week' },
  { key: 'weld',    label: 'Weld',         planned: 'fab_week',   completed: 'weld_week' },
  { key: 'paint',   label: 'Paint',        planned: 'paint_week', completed: 'painting_week' },
  { key: 'subs',    label: 'Sub-Assembly', planned: 'subs_week',  completed: 'subassembly_week' },
]

// A build_plan value counts as a "week" only when it's a bare integer.
function weekNumber(value) {
  if (value == null) return null
  const s = String(value).trim()
  if (!/^\d+$/.test(s)) return null
  return parseInt(s, 10)
}

// Supabase caps responses at 1000 rows; page through so a growing plan never
// silently truncates (see the manager-report note in db.js for the same reason).
async function fetchAllPlanRows() {
  const pageSize = 1000
  let rows = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('build_plan')
      .select(PLAN_FIELDS)
      .order('seq_no', { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw error
    rows = rows.concat(data ?? [])
    if (!data || data.length < pageSize) break
  }
  return rows
}

// Load every planned job for a department, tagged with its numeric planned week.
// Returns { weeks: number[] (sorted), byWeek: Map<week, job[]> }.
export async function fetchDeptPlan(department) {
  const col = PLAN_WEEK_COL[department]
  if (!col) return { col: null, weeks: [], byWeek: new Map() }

  const rows = await fetchAllPlanRows()
  const byWeek = new Map()
  for (const row of rows) {
    const wk = weekNumber(row[col])
    if (wk == null) continue
    if (!byWeek.has(wk)) byWeek.set(wk, [])
    byWeek.get(wk).push({ ...row, planned_week: wk })
  }
  for (const list of byWeek.values()) {
    list.sort((a, b) =>
      String(a.customer ?? '').localeCompare(String(b.customer ?? '')) ||
      String(a.part_number ?? '').localeCompare(String(b.part_number ?? ''))
    )
  }
  const weeks = [...byWeek.keys()].sort((a, b) => a - b)
  return { col, weeks, byWeek }
}

// Live status of every job in a department, keyed by jobKey(po, part), so the
// picker can show which planned jobs are already in progress or finished.
export async function fetchDeptJobStatuses(department) {
  const pageSize = 1000
  let rows = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('jobs')
      .select('po_number, part_number, status')
      .eq('department', department)
      .range(from, from + pageSize - 1)
    if (error) throw error
    rows = rows.concat(data ?? [])
    if (!data || data.length < pageSize) break
  }
  const map = new Map()
  for (const r of rows) map.set(jobKey(r.po_number, r.part_number), r.status)
  return map
}

const ACTIVITY_LABEL = { tack: 'Tack', weld: 'Weld', tack_weld: 'Tack & Weld' }
const WORK_LABEL     = { parts: 'Parts', frames: 'Frames', parts_frames: 'Parts & Frames' }

// "Tack · Parts", "Weld", or null when the department doesn't track activity/work type.
export function activityLabel(activity_type, work_type) {
  const a = ACTIVITY_LABEL[activity_type]
  const w = WORK_LABEL[work_type]
  if (a && w) return `${a} · ${w}`
  return a ?? null
}

// Who (if anyone) is currently active on each job in a department, and what
// they're doing — so the Weekly Plan can show "Paul Beagan · Tack · Parts"
// on an in-progress row instead of just a pill. Keyed by jobKey(po, part);
// each entry is an array because assembly jobs can have a whole team on them.
export async function fetchDeptActiveWork(department) {
  const pageSize = 1000
  let rows = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('job_events')
      .select(`
        job_id, employee_id, event_type, activity_type, work_type, event_timestamp,
        jobs!inner ( po_number, part_number, department ),
        employees ( full_name )
      `)
      .eq('jobs.department', department)
      .in('event_type', ['START', 'RESUME', 'PAUSE', 'COMPLETE', 'AUTO_LOGOUT'])
      .order('event_timestamp', { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw error
    rows = rows.concat(data ?? [])
    if (!data || data.length < pageSize) break
  }

  // Last event per (job, employee) pair decides if they're currently active
  const lastByPair = new Map()
  for (const r of rows) lastByPair.set(`${r.job_id}_${r.employee_id}`, r)

  const map = new Map()
  for (const r of lastByPair.values()) {
    if (r.event_type !== 'START' && r.event_type !== 'RESUME') continue
    if (!r.jobs) continue
    const k = jobKey(r.jobs.po_number, r.jobs.part_number)
    if (!map.has(k)) map.set(k, [])
    map.get(k).push({
      name: r.employees?.full_name ?? 'Unknown',
      label: activityLabel(r.activity_type, r.work_type),
    })
  }
  return map
}

// Same underlying data as fetchDeptActiveWork, keyed by employee_id instead —
// so a manager picking someone to assign can see who's already on a job.
export async function fetchDeptActiveEmployees(department) {
  const pageSize = 1000
  let rows = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('job_events')
      .select(`
        job_id, employee_id, event_type, activity_type, work_type, event_timestamp,
        jobs!inner ( po_number, part_number, department )
      `)
      .eq('jobs.department', department)
      .in('event_type', ['START', 'RESUME', 'PAUSE', 'COMPLETE', 'AUTO_LOGOUT'])
      .order('event_timestamp', { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw error
    rows = rows.concat(data ?? [])
    if (!data || data.length < pageSize) break
  }

  const lastByEmployee = new Map()
  for (const r of rows) lastByEmployee.set(r.employee_id, r)

  const map = new Map()   // employee_id -> { poNumber, partNumber, label }
  for (const r of lastByEmployee.values()) {
    if (r.event_type !== 'START' && r.event_type !== 'RESUME') continue
    if (!r.jobs) continue
    map.set(r.employee_id, {
      poNumber: r.jobs.po_number,
      partNumber: r.jobs.part_number,
      label: activityLabel(r.activity_type, r.work_type),
    })
  }
  return map
}

// ── Weld machine progress (Tack/Weld × Parts/Frames) ─────────────────────────
// Mirrors getWeldProgress in db.js (kept in sync manually — see WELD_CELLS
// there): a weld machine is fully done once every activity×work-type cell has
// been completed by someone. Batched here so the Weekly Plan can show every
// job's progress in one query instead of one per row.
export const WELD_CELLS = ['tack_parts', 'tack_frames', 'weld_parts', 'weld_frames']
export const WELD_CELL_LABEL = { tack_parts: 'Tack · Parts', tack_frames: 'Tack · Frames', weld_parts: 'Weld · Parts', weld_frames: 'Weld · Frames' }
const expandActivity = a => a === 'tack_weld' ? ['tack', 'weld'] : a ? [a] : []
const expandWork     = w => w === 'parts_frames' ? ['parts', 'frames'] : w ? [w] : []

// jobKey(po, part) -> { tack_parts: {state, name}, ... } for all 4 WELD_CELLS.
// state is 'pending' (nobody's touched it), 'active' (someone's on it right
// now), or 'done' (completed) — each cell always present so the UI can show
// a fixed 4-pill row per job, not just the cells someone's worked.
export async function fetchWeldCellStatus() {
  const pageSize = 1000
  let rows = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('job_events')
      .select(`
        job_id, employee_id, event_type, activity_type, work_type, event_timestamp,
        jobs!inner ( po_number, part_number, department ),
        employees ( full_name )
      `)
      .eq('jobs.department', 'weld')
      .in('event_type', ['START', 'RESUME', 'PAUSE', 'COMPLETE', 'AUTO_LOGOUT'])
      .order('event_timestamp', { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw error
    rows = rows.concat(data ?? [])
    if (!data || data.length < pageSize) break
  }

  const map = new Map()
  function ensure(k) {
    if (!map.has(k)) {
      const cells = {}
      for (const c of WELD_CELLS) cells[c] = { state: 'pending', name: null }
      map.set(k, cells)
    }
    return map.get(k)
  }

  // Completions first, chronologically — the most recent COMPLETE on a cell wins.
  for (const r of rows) {
    if (r.event_type !== 'COMPLETE' || !r.jobs) continue
    const cells = ensure(jobKey(r.jobs.po_number, r.jobs.part_number))
    for (const a of expandActivity(r.activity_type))
      for (const w of expandWork(r.work_type))
        cells[`${a}_${w}`] = { state: 'done', name: r.employees?.full_name ?? 'Unknown' }
  }

  // Then who's currently active — only fills cells that aren't already done.
  const lastByPair = new Map()
  for (const r of rows) lastByPair.set(`${r.job_id}_${r.employee_id}`, r)
  for (const r of lastByPair.values()) {
    if (r.event_type !== 'START' && r.event_type !== 'RESUME') continue
    if (!r.jobs) continue
    const cells = ensure(jobKey(r.jobs.po_number, r.jobs.part_number))
    for (const a of expandActivity(r.activity_type))
      for (const w of expandWork(r.work_type)) {
        const key = `${a}_${w}`
        if (cells[key].state !== 'done') cells[key] = { state: 'active', name: r.employees?.full_name ?? 'Unknown' }
      }
  }
  return map
}

// ISO-8601 week number for defaulting the selector to "this week".
export function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const day = d.getUTCDay() || 7          // Mon=1 … Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day)  // shift to the Thursday of this week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7)
}

// Identity key matching how the scanner keys jobs (findOrCreateJob on po+part).
export function jobKey(poNumber, partNumber) {
  return `${String(poNumber ?? '').trim()} ${String(partNumber ?? '').trim()}`
}

// Parse a plain-integer week from a build_plan cell, else null (tags/blank).
export function asWeek(value) {
  return weekNumber(value)
}

// The exact fill colours read from the "DELIVERED TO" column of the actual
// workbook (checked customer-by-customer — no conflicting colours found for
// any customer across all rows). Cells with no fill (alpha 00) are omitted
// and fall through to the hash-based fallback below. Keyed by the full raw
// customer string, trimmed/uppercased, matching what's stored in build_plan.
const CUSTOMER_HEX = {
  'ASTEC - USA':                 '0070C0',
  'ASTEC OMAGH':                 'C00000',
  'CAMPSIE':                     'FF0000',
  'MCCLOSKEY - GRANVILLE SITE':  '00B050',
  'ROCO':                        'EDFD51',
  'RUBBLE MASTER':               'FFFF99',
  'SANDVIK':                     'FFC000',
  'SANDVIK SPARES':              'FFC000',
  'SFM ENGINEERING':             '5B9BD5',
  'TESAB':                       'E6E100',
  'TYRONE INTERNATIONAL':        '00B0F0',
}

function hexToHue(hex) {
  const r = parseInt(hex.slice(0, 2), 16) / 255
  const g = parseInt(hex.slice(2, 4), 16) / 255
  const b = parseInt(hex.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  if (max === min) return 0
  const d = max - min
  let h
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h *= 60
  return h < 0 ? h + 360 : h
}

// A stable colour per customer. Uses the workbook's real fill colour when
// known; otherwise falls back to one generated from the name itself, so
// every customer still gets a consistent colour even if the sheet never
// coloured them (or a new customer shows up before the map is updated).
function customerHue(customer) {
  const raw = String(customer ?? '').trim().toUpperCase()
  if (!raw) return null
  if (CUSTOMER_HEX[raw]) return hexToHue(CUSTOMER_HEX[raw])
  const name = raw.split(' - ')[0].trim()
  if (!name) return null
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return Math.abs(hash) % 360
}

export function customerColor(customer) {
  const hue = customerHue(customer)
  return hue == null ? 'hsl(0, 0%, 40%)' : `hsl(${hue}, 62%, 52%)`
}

// Inline-style trio (background/border/text) for rendering the customer as
// a coloured pill rather than a plain dot + name.
export function customerPillStyle(customer) {
  const hue = customerHue(customer)
  if (hue == null) return { backgroundColor: 'rgba(120,120,120,0.15)', borderColor: 'rgba(120,120,120,0.4)', color: '#a8a29e' }
  return {
    backgroundColor: `hsl(${hue}, 55%, 22%)`,
    borderColor: `hsl(${hue}, 55%, 42%)`,
    color: `hsl(${hue}, 85%, 78%)`,
  }
}

// All build_plan rows with every planned + completed week column — for the
// manager plan dashboard (load per week, late jobs, completed per week).
export async function fetchPlanRows() {
  return fetchAllPlanRows()
}
