import { useEffect, useState } from 'react'
import { calcElapsed, formatDuration, isJobActive } from '../lib/timeCalc'

const ACTIVITY_LABEL = { tack: 'Tack', weld: 'Weld', tack_weld: 'Tack & Weld' }
const WORK_LABEL     = { parts: 'Parts', frames: 'Frames', parts_frames: 'Parts & Frames' }

export default function JobCard({
  job, breakRules, splitMode, allJobs,
  onResume, onPause, onEdit, onComplete
}) {
  const active = isJobActive(job.events)

  // split_count is now stored in each event — timer reads it from events directly
  function computeElapsed() { return calcElapsed(job.events, breakRules) }
  const [elapsed, setElapsed] = useState(computeElapsed)

  useEffect(() => {
    setElapsed(computeElapsed())
    if (!active) return
    const id = setInterval(() => setElapsed(computeElapsed()), 1000)
    return () => clearInterval(id)
  }, [active, job.events, breakRules])

  // Number of currently active jobs — for the ÷N badge only, not the timer
  const splitCount = splitMode
    ? (allJobs ?? []).filter(j => isJobActive(j.events)).length
    : 1

  const lastTagged    = [...job.events].reverse().find(e => e.activity_type || e.work_type)
  const activityLabel = ACTIVITY_LABEL[lastTagged?.activity_type] ?? null
  const workLabel     = WORK_LABEL[lastTagged?.work_type] ?? null
  const selectionTag  = [activityLabel, workLabel].filter(Boolean).join(' · ')

  return (
    <div
      className={`rounded-2xl p-5 border-2 transition-colors ${
        active ? 'bg-stone-800 border-amber-500' : 'border-stone-700'
      }`}
      style={active ? {} : { backgroundColor: '#1e1b18' }}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <p className="text-xs text-stone-500 uppercase tracking-widest">PO</p>
          <p className="text-xl font-bold text-stone-100">{job.po_number}</p>
          <p className="text-sm text-stone-400">Part: {job.part_number}</p>
          {job.quantity != null && (
            <p className="text-sm text-stone-500">Qty: {job.quantity}</p>
          )}
        </div>

        <div className="text-right shrink-0">
          <div className="flex items-center justify-end gap-2 mb-1">
            <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold uppercase ${
              active ? 'bg-amber-500/20 text-amber-400' : 'bg-stone-700 text-stone-400'
            }`}>
              {active ? 'Active' : 'Paused'}
            </span>
            {active && (
              <button
                onClick={() => onEdit(job.job_id)}
                className="text-stone-500 hover:text-stone-300 text-lg leading-none p-1"
                title="Edit activity / work type"
              >
                ✏
              </button>
            )}
          </div>

          <p className={`text-2xl font-mono font-bold ${active ? 'text-amber-400' : 'text-stone-400'}`}>
            {formatDuration(elapsed)}
          </p>

          {active && splitMode && splitCount > 1 && (
            <p className="text-xs text-sky-400 font-semibold mt-0.5">÷{splitCount} split</p>
          )}

          {selectionTag && (
            <p className="text-xs text-stone-500 mt-0.5">{selectionTag}</p>
          )}
        </div>
      </div>

      <div className="flex gap-3 mt-1">
        {active ? (
          <button className="btn-secondary flex-1" onClick={() => onPause(job.job_id)}>
            {splitMode ? '⏹ Stop' : '⏸ Pause'}
          </button>
        ) : (
          <button className="btn-primary flex-1" onClick={() => onResume(job.job_id)}>
            ▶ Resume
          </button>
        )}
        <button className="btn-green flex-1" onClick={() => onComplete(job.job_id)}>
          ✓ Complete
        </button>
      </div>
    </div>
  )
}
