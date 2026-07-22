import { useState } from 'react'
import WeeklyPlanPanel from './WeeklyPlanPanel'

// Manager-facing version of the worker Weekly Plan: same week-by-week queue,
// with a department switcher on top, embedded (no fixed overlay, no Start
// buttons — managers browse this to see what's in progress and what still
// needs someone put on it, not to clock jobs in themselves).
const DEPTS = [
  { key: 'kitting',  label: 'Kitting' },
  { key: 'weld',     label: 'Weld' },
  { key: 'assembly', label: 'Assembly' },
]

export default function ManagerWeeklyPlan() {
  const [dept, setDept] = useState('weld')

  return (
    <div className="flex-1 overflow-y-auto flex flex-col">
      <div className="shrink-0 px-4 py-3 flex gap-2 border-b border-stone-800">
        {DEPTS.map(d => (
          <button key={d.key} onClick={() => setDept(d.key)}
            className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
              dept === d.key
                ? 'bg-amber-500 text-stone-950'
                : 'bg-stone-800 border border-stone-700 text-stone-400 hover:text-stone-200'
            }`}>
            {d.label}
          </button>
        ))}
      </div>
      <WeeklyPlanPanel
        key={dept}
        department={dept}
        title={DEPTS.find(d => d.key === dept)?.label}
        embedded
      />
    </div>
  )
}
