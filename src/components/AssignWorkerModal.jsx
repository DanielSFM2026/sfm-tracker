import { useEffect, useState } from 'react'
import {
  fetchDepartmentEmployees, fetchAssemblyLines,
  findOrCreateJob, managerStartWorkerOnJob, managerStartAssemblyJobFull,
} from '../lib/db'
import { fetchDeptActiveEmployees, fetchWeldCellStatus, weldPickerPlan, jobKey, WELD_CELL_LABEL } from '../lib/plan'

function nowLocal() {
  const d = new Date(); d.setSeconds(0, 0)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function localInputToISO(dtLocalStr) {
  if (!dtLocalStr) return new Date().toISOString()
  const [datePart, timePart] = dtLocalStr.split('T')
  const [y, mo, d] = datePart.split('-').map(Number)
  const [h, mi] = timePart.split(':').map(Number)
  return new Date(y, mo - 1, d, h, mi, 0, 0).toISOString()
}

// Manager picks who to put on a job straight from the Weekly Plan — same
// scrollable department roster as Live Overview's "Add Worker", plus a
// visible tag for anyone already active elsewhere so the manager doesn't
// double them up by accident.
export default function AssignWorkerModal({ department, job, onClose, onAssigned }) {
  const isAssembly = department === 'assembly'
  const [step, setStep] = useState(isAssembly ? 'line' : 'pick')
  const [employees, setEmployees] = useState(null)
  const [activeMap, setActiveMap] = useState(new Map())
  const [lines, setLines] = useState([])
  const [lineId, setLineId] = useState(null)
  const [lineName, setLineName] = useState('')
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [target, setTarget] = useState(null)   // single-employee pick, non-assembly
  const [activityType, setActivityType] = useState(null)   // weld only: tack / weld / tack_weld
  const [workType, setWorkType] = useState(null)            // weld only: parts / frames / parts_frames
  const [startTime, setStartTime] = useState(nowLocal)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [usedSingle, setUsedSingle] = useState(false)     // came via the one-cell shortcut, for Back routing
  const [remainingCells, setRemainingCells] = useState(null)   // null while loading = permissive default
  const isWeld = department === 'weld'
  const ACTIVITY_LABEL = { tack: 'Tack', weld: 'Weld', tack_weld: 'Tack & Weld' }
  const weldPlan = weldPickerPlan(remainingCells)

  useEffect(() => {
    let alive = true
    Promise.all([
      fetchDepartmentEmployees(department),
      fetchDeptActiveEmployees(department).catch(() => new Map()),
      isAssembly ? fetchAssemblyLines() : Promise.resolve([]),
      isWeld ? fetchWeldCellStatus().catch(() => new Map()) : Promise.resolve(null),
    ]).then(([emps, active, ls, weldStatus]) => {
      if (!alive) return
      setEmployees(emps); setActiveMap(active); setLines(ls)
      if (weldStatus) {
        const cellsObj = weldStatus.get(jobKey(job.po_number, job.part_number))
        setRemainingCells(cellsObj ? Object.keys(cellsObj).filter(c => cellsObj[c].state !== 'done') : null)
      }
    }).catch(err => { console.error(err); if (alive) setError('Could not load employees.') })
    return () => { alive = false }
  }, [department])

  function toggleMember(id) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function handleConfirm() {
    setBusy(true); setError('')
    try {
      const { job: dbJob } = await findOrCreateJob(job.po_number, job.part_number, department)
      const ts = localInputToISO(startTime)
      if (isAssembly) {
        await managerStartAssemblyJobFull(dbJob.job_id, lineId, [...selectedIds], ts)
      } else {
        await managerStartWorkerOnJob(target.employee_id, dbJob.job_id, null, ts, activityType, workType)
      }
      onAssigned()
    } catch (err) {
      console.error(err)
      setError('Failed to assign — check connection.')
    } finally {
      setBusy(false)
    }
  }

  function ActiveTag({ employeeId }) {
    const a = activeMap.get(employeeId)
    if (!a) return null
    return (
      <span className="text-[10px] text-amber-400 block truncate">
        ● On PO {a.poNumber}{a.label ? ` · ${a.label}` : ''}
      </span>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[60] px-4">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl w-full max-w-sm p-6 max-h-[85vh] overflow-y-auto">
        <p className="text-xs text-stone-500 uppercase tracking-widest mb-1">Assign — {job.part_number}</p>
        <p className="text-sm text-stone-400 mb-4">PO {job.po_number}</p>
        {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

        {/* Assembly step 1: line */}
        {step === 'line' && (
          <>
            <p className="text-stone-300 text-sm mb-3">Which line?</p>
            <div className="space-y-2 mb-4">
              {lines.map(l => (
                <button key={l.line_id}
                  onClick={() => { setLineId(l.line_id); setLineName(l.line_name); setStep('team') }}
                  className="w-full px-4 py-3 rounded-xl bg-stone-700 hover:bg-stone-600 border border-stone-600 text-stone-200 text-sm text-left font-semibold">
                  {l.line_name}
                </button>
              ))}
            </div>
            <button className="w-full text-sm text-stone-500 underline" onClick={onClose}>Cancel</button>
          </>
        )}

        {/* Assembly step 2 / non-assembly step 1: pick from roster */}
        {(step === 'team' || step === 'pick') && (
          <>
            <p className="text-stone-300 text-sm mb-1">
              {isAssembly ? <>Select team — <span className="text-sky-400 font-semibold">{lineName}</span></> : 'Select worker'}
            </p>
            {isAssembly && <p className="text-stone-500 text-xs mb-3">Tap to toggle. Selected members clock in together.</p>}
            {employees === null ? (
              <p className="text-stone-500 text-sm animate-pulse py-4">Loading…</p>
            ) : (
              <div className="space-y-1.5 mb-4 max-h-80 overflow-y-auto">
                {employees.map(e => {
                  const on = selectedIds.has(e.employee_id)
                  return (
                    <button key={e.employee_id}
                      onClick={() => {
                        if (isAssembly) { toggleMember(e.employee_id); return }
                        setTarget(e)
                        if (isWeld && weldPlan.single) { setUsedSingle(true); setStep('single') }
                        else { setUsedSingle(false); setStep(isWeld ? 'activity' : 'time') }
                      }}
                      className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border text-sm text-left transition-colors ${
                        isAssembly && on
                          ? 'bg-sky-900/40 border-sky-600 text-sky-200'
                          : 'bg-stone-700 border-stone-600 text-stone-200 hover:bg-stone-600'
                      }`}>
                      <span className="min-w-0">
                        <span className="block truncate">{e.full_name}</span>
                        <ActiveTag employeeId={e.employee_id} />
                      </span>
                      {isAssembly && (
                        <span className={`text-xs font-bold shrink-0 ml-2 ${on ? 'text-sky-400' : 'text-stone-600'}`}>
                          {on ? '✓ On' : '+ Add'}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
            {isAssembly && (
              <button disabled={selectedIds.size === 0}
                onClick={() => setStep('time')}
                className="w-full py-3 rounded-xl bg-stone-700 border border-stone-600 text-stone-200 text-base mb-2 disabled:opacity-40">
                Next → ({selectedIds.size} selected)
              </button>
            )}
            <button className="w-full text-sm text-stone-500 underline"
              onClick={() => isAssembly ? setStep('line') : onClose()}>
              {isAssembly ? 'Back' : 'Cancel'}
            </button>
          </>
        )}

        {/* Only one cell left on this job — skip the wizard, one-tap confirm */}
        {step === 'single' && weldPlan.single && (
          <>
            <p className="text-stone-300 text-sm mb-1">
              <strong className="text-stone-100">{WELD_CELL_LABEL[weldPlan.single]}</strong> is all that's left
            </p>
            <p className="text-stone-500 text-xs mb-4">Start {target?.full_name} on this?</p>
            <button className="w-full py-4 rounded-xl bg-emerald-700/30 border border-emerald-600 text-emerald-300 text-lg font-semibold mb-2"
              onClick={() => {
                const [a, w] = weldPlan.single.split('_')
                setActivityType(a); setWorkType(w); setStep('time')
              }}>
              Start
            </button>
            <button className="w-full text-sm text-stone-500 underline mb-1"
              onClick={() => { setUsedSingle(false); setStep('activity') }}>
              Choose something else
            </button>
            <button className="w-full text-sm text-stone-500 underline" onClick={() => setStep('pick')}>Back</button>
          </>
        )}

        {/* Weld only — same two questions the worker's own clock-on screen asks.
            Already-completed activities/work-types are greyed out. */}
        {step === 'activity' && (
          <>
            <p className="text-stone-300 text-sm mb-1">
              What's <strong className="text-stone-100">{target?.full_name}</strong> doing?
            </p>
            <p className="text-stone-500 text-xs mb-4">Step 1 of 2</p>
            <div className="flex flex-col gap-2 mb-2">
              <button disabled={!weldPlan.activityEnabled.tack}
                className={`py-4 rounded-xl bg-amber-500/20 border border-amber-600 text-amber-300 text-lg font-semibold ${!weldPlan.activityEnabled.tack ? 'opacity-30 cursor-not-allowed' : ''}`}
                onClick={() => { setActivityType('tack'); setStep('work') }}>Tack</button>
              <button disabled={!weldPlan.activityEnabled.weld}
                className={`py-4 rounded-xl bg-stone-700 border border-stone-600 text-stone-200 text-lg font-semibold ${!weldPlan.activityEnabled.weld ? 'opacity-30 cursor-not-allowed' : ''}`}
                onClick={() => { setActivityType('weld'); setStep('work') }}>Weld</button>
              <button disabled={!weldPlan.activityEnabled.tack_weld}
                className={`py-4 rounded-xl border border-stone-600 text-stone-300 text-lg ${!weldPlan.activityEnabled.tack_weld ? 'opacity-30 cursor-not-allowed' : ''}`}
                onClick={() => { setActivityType('tack_weld'); setStep('work') }}>Tack &amp; Weld</button>
            </div>
            <button className="w-full text-sm text-stone-500 underline mt-1" onClick={() => setStep('pick')}>Back</button>
          </>
        )}

        {step === 'work' && (() => {
          const workOk = weldPlan.workEnabledFor(activityType)
          return (
            <>
              <p className="text-stone-300 text-sm mb-1">Working on?</p>
              <p className="text-stone-500 text-xs mb-4">
                Step 2 of 2 · <span className="text-amber-400">{ACTIVITY_LABEL[activityType]}</span>
              </p>
              <div className="flex flex-col gap-2 mb-2">
                <button disabled={!workOk.parts}
                  className={`py-4 rounded-xl bg-amber-500/20 border border-amber-600 text-amber-300 text-lg font-semibold ${!workOk.parts ? 'opacity-30 cursor-not-allowed' : ''}`}
                  onClick={() => { setWorkType('parts'); setStep('time') }}>Parts</button>
                <button disabled={!workOk.frames}
                  className={`py-4 rounded-xl bg-stone-700 border border-stone-600 text-stone-200 text-lg font-semibold ${!workOk.frames ? 'opacity-30 cursor-not-allowed' : ''}`}
                  onClick={() => { setWorkType('frames'); setStep('time') }}>Frames</button>
                <button disabled={!workOk.parts_frames}
                  className={`py-4 rounded-xl border border-stone-600 text-stone-300 text-lg ${!workOk.parts_frames ? 'opacity-30 cursor-not-allowed' : ''}`}
                  onClick={() => { setWorkType('parts_frames'); setStep('time') }}>Parts &amp; Frames</button>
              </div>
              <button className="w-full text-sm text-stone-500 underline mt-1" onClick={() => setStep('activity')}>Back</button>
            </>
          )
        })()}

        {/* Final step: confirm start time */}
        {step === 'time' && (
          <>
            <p className="text-stone-300 text-sm mb-1">
              {isAssembly
                ? <>{lineName} · {selectedIds.size} member{selectedIds.size !== 1 ? 's' : ''}</>
                : <>Starting <strong className="text-stone-100">{target?.full_name}</strong>{isWeld && <> · <span className="text-amber-400">{ACTIVITY_LABEL[activityType]}</span></>}</>}
            </p>
            <p className="text-stone-500 text-xs mb-4">Set the actual start time — backdate if needed.</p>
            <label className="block text-xs text-stone-500 uppercase tracking-widest mb-1">Start time</label>
            <input type="datetime-local" value={startTime} onChange={e => setStartTime(e.target.value)}
              className="w-full bg-stone-700 border border-stone-600 rounded-xl px-4 py-3 text-stone-100 text-sm mb-5 focus:outline-none focus:border-amber-500" />
            <button disabled={busy}
              onClick={handleConfirm}
              className="w-full py-3 rounded-xl bg-emerald-700/30 border border-emerald-600 text-emerald-300 text-base mb-2 disabled:opacity-40">
              {busy ? 'Starting…' : 'Confirm & Start'}
            </button>
            <button className="w-full text-sm text-stone-500 underline"
              onClick={() => setStep(isAssembly ? 'team' : isWeld ? (usedSingle ? 'single' : 'work') : 'pick')}>
              Back
            </button>
          </>
        )}
      </div>
    </div>
  )
}
