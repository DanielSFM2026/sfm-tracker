import { useEffect, useState } from 'react'
import { fetchRecentCompletedJobs } from '../lib/db'

// Green "done" section for the bottom of every department's home screen —
// deliberately styled distinct from the active-jobs list above it so it
// reads as "already finished, nothing to do here" at a glance.
// refreshKey: bump this (e.g. a counter) after completing a job so the
// section picks it up without waiting for the next full page load.
export default function CompletedSection({ employeeId, refreshKey, days = 7 }) {
  const [jobs, setJobs]     = useState(null)
  const [error, setError]   = useState('')

  useEffect(() => {
    let alive = true
    fetchRecentCompletedJobs(employeeId, days)
      .then(rows => { if (alive) setJobs(rows) })
      .catch(err => { console.error(err); if (alive) setError('Could not load completed jobs.') })
    return () => { alive = false }
  }, [employeeId, days, refreshKey])

  if (!jobs || jobs.length === 0) return null

  return (
    <div className="mt-6">
      <div className="flex items-center gap-2 mb-3 px-1">
        <span className="text-emerald-400 text-lg">✓</span>
        <h2 className="text-sm font-bold uppercase tracking-widest text-emerald-400">
          Completed — Last {days} Days
        </h2>
        <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">
          {jobs.length}
        </span>
      </div>

      {error && <p className="text-red-400 text-sm px-1 mb-2">{error}</p>}

      <div className="space-y-2">
        {jobs.map(j => {
          const d = new Date(j.completed_at)
          return (
            <div key={j.event_id}
              className="rounded-2xl p-4 border-2 border-emerald-800/60 bg-emerald-950/20">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs text-emerald-500/70 uppercase tracking-widest">PO</p>
                  <p className="text-lg font-bold text-stone-100">{j.po_number}</p>
                  <p className="text-sm text-stone-400">Part: {j.part_number}</p>
                  {j.quantity != null && (
                    <p className="text-sm text-stone-500">Qty: {j.quantity}</p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <span className="inline-block px-3 py-1 rounded-full text-xs font-semibold uppercase bg-emerald-500/20 text-emerald-400">
                    ✓ Done
                  </span>
                  <p className="text-xs text-stone-500 mt-1.5">
                    {d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                  </p>
                  <p className="text-xs text-stone-500">
                    {d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
