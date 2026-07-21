import { useEffect, useMemo, useState } from 'react'
import { fetchDeptPlan, isoWeek, jobKey } from '../lib/plan'

// Full-screen overlay: pick a job from the weekly plan instead of scanning.
// department  — which build_plan week column to read (weld/kitting/assembly…)
// title       — heading shown to the worker ("Weld", "Kitting", …)
// activeKeys  — Set of jobKey(po, part) already on this worker's list
// onPick(po, part) — called when a planned job is chosen
// onClose()   — close without picking
export default function WeeklyPlanPanel({ department, title, activeKeys, onPick, onClose }) {
  const [plan, setPlan]     = useState(null)   // { weeks, byWeek } | null while loading
  const [error, setError]   = useState('')
  const [weekIdx, setWeekIdx] = useState(0)

  useEffect(() => {
    let alive = true
    fetchDeptPlan(department)
      .then(res => {
        if (!alive) return
        setPlan(res)
        // Default to this ISO week if it has jobs, else the next planned week,
        // else the last — so the worker lands on what's current.
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
  const jobs  = useMemo(() => (week != null ? plan.byWeek.get(week) ?? [] : []), [plan, week])

  return (
    <div className="fixed inset-0 z-50 bg-stone-950 flex flex-col">

      {/* Header */}
      <div className="bg-stone-900 border-b border-stone-700 px-5 py-4 flex items-center justify-between shrink-0 gap-3">
        <div className="min-w-0">
          <p className="text-xs text-stone-500 uppercase tracking-widest">Weekly plan</p>
          <p className="text-xl font-bold text-stone-100 truncate">{title}</p>
        </div>
        <button className="btn-ghost px-5 py-3 text-base" onClick={onClose}>Close</button>
      </div>

      {/* Week selector */}
      <div className="bg-stone-900/60 border-b border-stone-800 px-5 py-3 flex items-center justify-between shrink-0">
        <button
          disabled={weekIdx <= 0}
          onClick={() => setWeekIdx(i => Math.max(0, i - 1))}
          className="w-12 h-12 rounded-xl border border-stone-600 bg-stone-800 text-stone-200 text-2xl leading-none disabled:opacity-30">
          ‹
        </button>
        <div className="text-center">
          <p className="text-xs text-stone-500 uppercase tracking-widest">Week</p>
          <p className="text-2xl font-bold text-amber-400 tabular-nums">{week ?? '—'}</p>
          {week != null && <p className="text-xs text-stone-500">{jobs.length} job{jobs.length === 1 ? '' : 's'}</p>}
        </div>
        <button
          disabled={weekIdx >= weeks.length - 1}
          onClick={() => setWeekIdx(i => Math.min(weeks.length - 1, i + 1))}
          className="w-12 h-12 rounded-xl border border-stone-600 bg-stone-800 text-stone-200 text-2xl leading-none disabled:opacity-30">
          ›
        </button>
      </div>

      {/* Job list */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2.5">
        {error && <p className="text-red-400 text-sm text-center py-4">{error}</p>}

        {!plan && !error && (
          <p className="text-stone-500 text-center py-16 animate-pulse">Loading the plan…</p>
        )}

        {plan && weeks.length === 0 && !error && (
          <div className="text-center py-16 text-stone-600">
            <p className="text-4xl mb-3">🗓️</p>
            <p className="text-lg">No planned weeks for {title.toLowerCase()} yet.</p>
          </div>
        )}

        {plan && week != null && jobs.length === 0 && (
          <div className="text-center py-16 text-stone-600">
            <p className="text-lg">Nothing planned for week {week}.</p>
          </div>
        )}

        {jobs.map(job => {
          const onList = activeKeys?.has(jobKey(job.po_number, job.part_number))
          return (
            <button
              key={job.seq_no ?? `${job.po_number}-${job.part_number}`}
              onClick={() => onPick(job.po_number, job.part_number)}
              className="w-full text-left bg-stone-800 border border-stone-700 hover:border-amber-500
                         active:scale-[0.99] rounded-2xl p-4 flex items-center justify-between gap-3 transition-all">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-lg font-bold text-stone-100">{job.part_number}</span>
                  {job.model && (
                    <span className="text-xs font-semibold text-amber-300 bg-amber-500/10 border border-amber-700/50 rounded px-1.5 py-0.5">
                      {job.model}
                    </span>
                  )}
                  {onList && (
                    <span className="text-xs font-semibold text-sky-300 bg-sky-500/15 border border-sky-700/50 rounded-full px-2 py-0.5">
                      On your list
                    </span>
                  )}
                </div>
                {job.description && (
                  <p className="text-sm text-stone-400 truncate mt-0.5">{job.description}</p>
                )}
                <p className="text-xs text-stone-500 mt-0.5">
                  PO {job.po_number}
                  {job.quantity != null && <> · Qty {job.quantity}</>}
                  {job.customer && <> · {String(job.customer).split(' - ')[0]}</>}
                </p>
              </div>
              <span className="shrink-0 text-amber-400 font-semibold text-sm border border-amber-700/60 rounded-xl px-4 py-3">
                Select
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
