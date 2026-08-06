import { useState } from 'react'
import { holdReasonsFor } from '../lib/constants'

// "Why are you pausing?" picker. Real reasons get an optional comment step
// before confirming (they email out); "Just Pause" skips straight through
// (that one never emails — see doPause in DashboardScreen).
// onConfirm(reasonKey|null, comment|null)
export default function PauseReasonModal({ department = 'weld', onConfirm, onCancel }) {
  const [reason, setReason] = useState(undefined)   // undefined = not picked yet
  const [comment, setComment] = useState('')

  if (reason === undefined) {
    return (
      <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
        <div className="bg-stone-800 border border-stone-600 rounded-2xl p-6 w-full max-w-sm">
          <h2 className="text-lg font-bold text-stone-100 mb-1">Pause Job</h2>
          <p className="text-stone-500 text-sm mb-4">Why is this job stopping?</p>
          <div className="space-y-2">
            {holdReasonsFor(department).map(r => (
              <button key={r.key}
                className="w-full text-left px-4 py-3 rounded-xl bg-stone-700 hover:bg-orange-900/40
                           border border-stone-600 hover:border-orange-700 text-stone-200 text-sm"
                onClick={() => setReason(r.key)}>
                {r.label}
              </button>
            ))}
            <button
              className="w-full text-left px-4 py-3 rounded-xl bg-stone-700/50 hover:bg-stone-700
                         border border-stone-600 text-stone-400 text-sm"
              onClick={() => onConfirm(null, null)}>
              Other / Just Pause
            </button>
          </div>
          <button className="w-full btn-ghost mt-4 py-3" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    )
  }

  const label = holdReasonsFor(department).find(r => r.key === reason)?.label ?? reason
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl p-6 w-full max-w-sm">
        <h2 className="text-lg font-bold text-stone-100 mb-1">Add a Comment?</h2>
        <p className="text-stone-500 text-sm mb-4">
          <span className="text-orange-400 font-semibold">{label}</span> — this will email the team.
          Add any extra detail if it'll help (optional).
        </p>
        <textarea
          autoFocus
          rows={3}
          value={comment}
          onChange={e => setComment(e.target.value)}
          placeholder="e.g. which part is missing, who to check with…"
          className="w-full bg-stone-900 border border-stone-600 focus:border-orange-500 rounded-xl px-3 py-2.5 text-stone-100 text-sm outline-none placeholder-stone-600 mb-4"
        />
        <div className="flex gap-3">
          <button className="flex-1 btn-ghost py-3" onClick={() => setReason(undefined)}>Back</button>
          <button className="flex-1 btn-primary py-3" onClick={() => onConfirm(reason, comment.trim() || null)}>
            Confirm Pause
          </button>
        </div>
      </div>
    </div>
  )
}
