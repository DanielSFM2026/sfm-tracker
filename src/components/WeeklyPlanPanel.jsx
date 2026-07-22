import { useEffect, useMemo, useState } from 'react'
import { fetchDeptPlan, fetchDeptJobStatuses, isoWeek, jobKey, asWeek } from '../lib/plan'

// Per-department wording + which upstream stage's COMPLETED-week column gates
// "ready vs waiting" (a job is ready once the upstream stage has a week filled in).
const DEPT_UI = {
  weld:     { ready: 'Ready to weld',  waiting: 'Waiting on kit',   done: 'Welded',    upstream: 'kitting_week',  waitLabel: 'Waiting on kit' },
  kitting:  { ready: 'Ready to kit',   waiting: 'Not started',      done: 'Kitted',    upstream: null,            waitLabel: 'Not started' },
  assembly: { ready: 'Ready to build', waiting: 'Waiting on paint', done: 'Assembled', upstream: 'painting_week',  waitLabel: 'Waiting on paint' },
}

// state → styling
const STATE = {
  wip:     { stripe: 'bg-amber-500',   pill: 'text-amber-400 bg-amber-500/15',   tile: 'bg-amber-500',   row: 'border-l-amber-500' },
  ready:   { stripe: 'bg-blue-500',    pill: 'text-blue-400 bg-blue-500/15',     tile: 'bg-blue-500',    row: 'border-l-blue-500' },
  waiting: { stripe: 'bg-stone-500',   pill: 'text-stone-400 bg-stone-600/40',   tile: 'bg-stone-500',   row: 'border-l-stone-600' },
  done:    { stripe: 'bg-emerald-500', pill: 'text-emerald-400 bg-emerald-500/15', tile: 'bg-emerald-500', row: 'border-l-emerald-600' },
}

// List order: in-progress first, then ready, then waiting-on-upstream, with
// completed at the very bottom. Within a group, by customer then part number.
const STATE_RANK = { wip: 0, ready: 1, waiting: 2, done: 3 }

function useClock() {
  const [t, setT] = useState(() => new Date())
  useEffect(() => { const id = setInterval(() => setT(new Date()), 15000); return () => clearInterval(id) }, [])
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
}

export default function WeeklyPlanPanel({ department, title, operatorName, activeKeys, onPick, onClose }) {
  const ui = DEPT_UI[department] ?? DEPT_UI.weld
  const [plan, setPlan]         = useState(null)
  const [statuses, setStatuses] = useState(new Map())
  const [error, setError]       = useState('')
  const [weekIdx, setWeekIdx]   = useState(0)
  const clock = useClock()

  useEffect(() => {
    let alive = true
    Promise.all([fetchDeptPlan(department), fetchDeptJobStatuses(department).catch(() => new Map())])
      .then(([res, st]) => {
        if (!alive) return
        setPlan(res); setStatuses(st)
        const wk = isoWeek()
        let idx = res.weeks.indexOf(wk)
        if (idx === -1) idx = res.weeks.findIndex(w => w >= wk)
        if (idx === -1) idx = res.weeks.length - 1
        setWeekIdx(Math.max(0, idx))
      })
      .catch(err => { console.error(err); if (alive) setError('Could not load the plan — check connection.') })
    return () => { alive = false }
  }, [department])

  const weeks = plan?.weeks ?? []
  const week  = weeks[weekIdx]

  function stateOf(job) {
    const st = statuses.get(jobKey(job.po_number, job.part_number))
    if (st === 'completed') return 'done'
    if (st === 'in_progress' || st === 'paused') return 'wip'
    if (ui.upstream && asWeek(job[ui.upstream]) == null) return 'waiting'
    return 'ready'
  }

  const jobs = useMemo(() => {
    if (week == null || !plan) return []
    const list = (plan.byWeek.get(week) ?? []).map(j => ({ ...j, _state: stateOf(j) }))
    list.sort((a, b) =>
      (STATE_RANK[a._state] - STATE_RANK[b._state]) ||
      String(a.customer ?? '').localeCompare(String(b.customer ?? '')) ||
      String(a.part_number ?? '').localeCompare(String(b.part_number ?? ''))
    )
    return list
  }, [plan, week, statuses])

  const counts = useMemo(() => {
    const c = { total: jobs.length, wip: 0, ready: 0, waiting: 0, done: 0 }
    for (const j of jobs) c[j._state]++
    return c
  }, [jobs])

  const stateLabel = { wip: 'In progress', ready: ui.ready, waiting: ui.waiting, done: ui.done }

  return (
    <div className="fixed inset-0 z-50 bg-stone-950 flex flex-col text-stone-100">

      {/* Header — compact: operator · week selector · clock/close */}
      <div className="shrink-0 px-3 py-2 flex items-center justify-between gap-2 border-b border-stone-800 bg-stone-900">
        <div className="min-w-0 flex-1">
          {operatorName && (
            <p className="text-base text-stone-300 truncate">
              <span className="text-stone-600 uppercase tracking-widest text-[10px] mr-1">Operator</span>
              <span className="text-amber-300 font-semibold">{operatorName}</span>
            </p>
          )}
        </div>

        {/* Week selector */}
        <div className="flex items-center gap-1.5 bg-stone-950 border border-stone-700 rounded-2xl px-1.5 py-1 shrink-0">
          <button disabled={weekIdx <= 0} onClick={() => setWeekIdx(i => Math.max(0, i - 1))}
            className="w-10 h-10 rounded-xl bg-stone-800 border border-stone-700 text-2xl disabled:opacity-30">‹</button>
          <div className="text-center px-1">
            <p className="text-[9px] uppercase tracking-widest text-stone-500 leading-none">Week</p>
            <select
              value={week ?? ''}
              onChange={e => setWeekIdx(Math.max(0, weeks.indexOf(+e.target.value)))}
              className="bg-transparent text-2xl font-extrabold text-amber-400 tabular-nums text-center outline-none cursor-pointer appearance-none">
              {weeks.map(w => <option key={w} value={w} className="bg-stone-900">{w}</option>)}
            </select>
          </div>
          <button disabled={weekIdx >= weeks.length - 1} onClick={() => setWeekIdx(i => Math.min(weeks.length - 1, i + 1))}
            className="w-10 h-10 rounded-xl bg-stone-800 border border-stone-700 text-2xl disabled:opacity-30">›</button>
        </div>

        <div className="flex items-center gap-3 shrink-0 flex-1 justify-end">
          <p className="text-base font-mono tabular-nums text-stone-400 hidden sm:block">{clock}</p>
          <button onClick={onClose} className="text-sm text-stone-200 border border-stone-700 rounded-lg px-4 py-2 hover:bg-stone-800">Close</button>
        </div>
      </div>

      {/* Summary tiles */}
      <div className="shrink-0 px-3 py-2.5 grid grid-cols-3 sm:grid-cols-5 gap-2 border-b border-stone-800">
        <Tile n={counts.total} label="Jobs this week" stripe="bg-stone-500" />
        <Tile n={counts.wip}     label="In progress"   stripe={STATE.wip.tile} />
        <Tile n={counts.ready}   label={ui.ready}       stripe={STATE.ready.tile} />
        <Tile n={counts.waiting} label={ui.waitLabel}   stripe={STATE.waiting.tile} />
        <Tile n={counts.done}    label={ui.done}        stripe={STATE.done.tile} />
      </div>

      {/* Column header */}
      <div className="shrink-0 hidden sm:flex items-center gap-3 px-5 py-2 text-[11px] uppercase tracking-widest text-stone-500 border-b border-stone-800/60">
        <span className="flex-1">Part / Description</span>
        <span className="w-14 text-center">Qty</span>
        <span className="hidden md:block w-40">Customer</span>
        <span className="w-24 text-center">Due</span>
        <span className="w-32 text-center">Action</span>
      </div>

      {/* Job list */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {error && <p className="text-red-400 text-center py-6">{error}</p>}
        {!plan && !error && <p className="text-stone-500 text-center py-16 animate-pulse">Loading the plan…</p>}
        {plan && weeks.length === 0 && !error && (
          <div className="text-center py-16 text-stone-600"><p className="text-4xl mb-3">🗓️</p><p className="text-lg">No planned weeks yet.</p></div>
        )}
        {plan && week != null && jobs.length === 0 && (
          <p className="text-center py-16 text-stone-600 text-lg">Nothing planned for week {week}.</p>
        )}

        {jobs.map(job => {
          const s   = STATE[job._state]
          const due = job.customer_req_date || job.original_date
          const onList = activeKeys?.has(jobKey(job.po_number, job.part_number))
          const canStart = job._state !== 'done'
          return (
            <div key={job.seq_no ?? `${job.po_number}-${job.part_number}`}
              className={`flex items-center gap-3 rounded-xl bg-stone-900 border border-stone-800 border-l-4 ${s.row} pl-3 pr-3 py-2.5`}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-lg font-bold">{job.part_number}</span>
                  {job.model && <span className="text-xs font-semibold text-amber-300 bg-amber-500/10 border border-amber-700/50 rounded px-1.5 py-0.5">{job.model}</span>}
                  <span className={`text-[11px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 ${s.pill}`}>● {stateLabel[job._state]}</span>
                  {onList && <span className="text-[11px] font-semibold text-sky-300 bg-sky-500/15 border border-sky-700/50 rounded-full px-2 py-0.5">On your list</span>}
                </div>
                {/* PO — the disambiguator between two of the same part; kept prominent */}
                <div className="flex items-center gap-1.5 mt-1">
                  <span className="text-[10px] uppercase tracking-widest text-stone-500 font-bold">PO</span>
                  <span className="font-mono font-bold text-amber-300 text-base sm:text-lg leading-none">{job.po_number}</span>
                </div>
                {job.description && <p className="text-sm text-stone-400 truncate mt-1">{job.description}</p>}
                <p className="text-xs text-stone-500 mt-0.5 sm:hidden">
                  Qty {job.quantity ?? '—'}{job.customer && <> · {String(job.customer).split(' - ')[0]}</>}{due && <> · Due {due}</>}
                </p>
              </div>

              <div className="hidden sm:block w-14 text-center font-mono text-lg font-bold tabular-nums">{job.quantity ?? '—'}</div>
              <div className="hidden md:block w-40 text-sm font-semibold truncate">{job.customer ? String(job.customer).split(' - ')[0] : '—'}</div>
              <div className="hidden sm:block w-24 text-center font-mono text-sm">{due || '—'}</div>

              <div className="w-32 shrink-0 flex justify-center">
                {canStart ? (
                  <button onClick={() => onPick(job.po_number, job.part_number)}
                    className={`w-full py-3 rounded-xl font-bold text-base active:scale-95 transition-transform ${
                      job._state === 'wip'
                        ? 'bg-amber-500 hover:bg-amber-400 text-stone-950'
                        : 'bg-blue-500 hover:bg-blue-400 text-white'
                    }`}>
                    {job._state === 'wip' ? 'Open' : '▶ Start'}
                  </button>
                ) : (
                  <span className="w-full py-3 rounded-xl text-center font-semibold text-emerald-400 bg-emerald-500/10 border border-emerald-700/40">✓ {ui.done}</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Tile({ n, label, stripe }) {
  return (
    <div className="relative bg-stone-900 border border-stone-800 rounded-xl px-3 py-2.5 overflow-hidden">
      <span className={`absolute left-0 top-0 bottom-0 w-1 ${stripe}`} />
      <p className="text-2xl sm:text-3xl font-extrabold tabular-nums leading-none">{n}</p>
      <p className="text-[10px] uppercase tracking-wider text-stone-500 font-semibold mt-1 leading-tight truncate">{label}</p>
    </div>
  )
}
