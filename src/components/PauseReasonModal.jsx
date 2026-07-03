import { HOLD_REASONS } from '../lib/constants'

// One-tap "why are you pausing?" picker. onConfirm(reasonKey|null) —
// null means a plain pause with no reason recorded.
export default function PauseReasonModal({ onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl p-6 w-full max-w-sm">
        <h2 className="text-lg font-bold text-stone-100 mb-1">Pause Job</h2>
        <p className="text-stone-500 text-sm mb-4">Why is this job stopping?</p>
        <div className="space-y-2">
          {HOLD_REASONS.map(r => (
            <button key={r.key}
              className="w-full text-left px-4 py-3 rounded-xl bg-stone-700 hover:bg-orange-900/40
                         border border-stone-600 hover:border-orange-700 text-stone-200 text-sm"
              onClick={() => onConfirm(r.key)}>
              {r.label}
            </button>
          ))}
          <button
            className="w-full text-left px-4 py-3 rounded-xl bg-stone-700/50 hover:bg-stone-700
                       border border-stone-600 text-stone-400 text-sm"
            onClick={() => onConfirm(null)}>
            Other / Just Pause
          </button>
        </div>
        <button className="w-full btn-ghost mt-4 py-3" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
