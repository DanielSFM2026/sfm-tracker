import { useEffect, useRef, useState } from 'react'
import {
  loadManagerReport, fetchBreakRules, fetchAssemblyLines,
  pauseJob, resumeJob, completeJob, rebalanceEmployeeSplit,
  holdAssemblyJob, managerResumeAssemblyJob, completeAssemblyJob, managerToggleAssemblyMember,
  fetchDepartmentEmployees, managerStartWorkerOnJob, managerStartAssemblyJobFull,
  findOrCreateJob, addTeamMemberToJob,
} from '../lib/db'
import { calcElapsed, formatDuration, isJobActive } from '../lib/timeCalc'

const REFRESH_MS = 30_000

const DEPT_LABEL = {
  weld:     'Weld Shop',
  paint:    'Paint Shop',
  kitting:  'Cutting Shop',
}

const SUB_DEPT_LABEL = {
  blast: 'Blast',
  pack:  'Pack',
  paint: 'Paint',
  prep:  'Prep',
}

const HOLD_SHORT = {
  missing_parts_sfm:          'Missing Parts (SFM)',
  poor_quality_sfm:           'Poor Quality (SFM)',
  missing_parts_supply_chain: 'Missing Parts (Supply Chain)',
  poor_quality_supply_chain:  'Poor Quality (Supply Chain)',
}

const HOLD_REASONS = [
  { key: 'missing_parts_sfm',          label: 'Missing Parts (SFM)' },
  { key: 'poor_quality_sfm',           label: 'Poor Quality (SFM)' },
  { key: 'missing_parts_supply_chain', label: 'Missing Parts (Supply Chain)' },
  { key: 'poor_quality_supply_chain',  label: 'Poor Quality (Supply Chain)' },
]

// ── Manager action modal ──────────────────────────────────────────────────────
function ManagerActionModal({ action, onClose, onDone }) {
  const [holdStep, setHoldStep]         = useState(false)
  const [addWorkerOpen, setAddWorkerOpen] = useState(false)
  const [allEmployees, setAllEmployees] = useState(null)
  const [addTarget, setAddTarget]       = useState(null)   // employee selected to add
  const [startTime, setStartTime]       = useState('')     // backdated start for weld
  const [busy, setBusy]                 = useState(false)
  const [busyMember, setBusyMember]     = useState(null)
  const [busyAdd, setBusyAdd]           = useState(null)
  const [error, setError]               = useState('')

  const { type, emp, job, lineId, members } = action
  const isAssembly = type === 'assembly'
  const isActive   = isAssembly ? action.isActive : job.isActive
  const department = isAssembly ? 'assembly' : emp?.department

  // Load department employees when "+ Add Worker" is opened
  async function openAddWorker() {
    setAddWorkerOpen(true)
    if (allEmployees !== null) return
    try {
      const emps = await fetchDepartmentEmployees(department)
      setAllEmployees(emps)
    } catch (e) {
      console.error(e); setError('Failed to load employees.')
    }
  }

  // Workers already on this job (by employee_id) — used to filter the picker list
  const existingIds = new Set(
    isAssembly
      ? (members ?? []).map(m => m.employee_id)
      : [emp?.employee_id]
  )

  // Always show time-picker step so manager can backdate if needed
  function handleSelectWorker(newEmp) {
    const now = new Date()
    now.setSeconds(0, 0)
    setStartTime(now.toISOString().slice(0, 16))
    setAddTarget(newEmp)
  }

  async function handleAddWorker(newEmp, isoTime) {
    setBusyAdd(newEmp.employee_id); setError('')
    try {
      const ts = isoTime ? localInputToISO(isoTime) : new Date().toISOString()
      if (isAssembly) {
        const memberCount = (members ?? []).filter(
          m => m.lastEvent === 'START' || m.lastEvent === 'RESUME'
        ).length + 1
        await addTeamMemberToJob(newEmp.employee_id, job.job_id, lineId, memberCount, ts)
      } else {
        await managerStartWorkerOnJob(newEmp.employee_id, job.job_id, lineId, ts)
      }
      onDone()
    } catch (e) {
      console.error(e); setError('Failed to add worker.')
    } finally {
      setBusyAdd(null)
    }
  }

  async function run(fn) {
    setBusy(true); setError('')
    try { await fn(); onDone() }
    catch (e) { console.error(e); setError('Action failed — check connection.') }
    finally { setBusy(false) }
  }

  // Weld/Paint/Kitting: pause then rebalance split on remaining jobs
  function handlePauseWorker() {
    run(async () => {
      await pauseJob(emp.employee_id, job.job_id)
      await rebalanceEmployeeSplit(emp.employee_id)
    })
  }
  function handleResumeWorker() {
    run(() => resumeJob(emp.employee_id, job.job_id))
  }
  // Complete then rebalance split (other jobs go from ÷2 back to ÷1)
  function handleCompleteWorker() {
    run(async () => {
      await completeJob(emp.employee_id, job.job_id)
      await rebalanceEmployeeSplit(emp.employee_id)
    })
  }

  // Assembly job-level actions
  function handleHoldAssembly(reason) {
    const activeIds = members.filter(m => m.lastEvent === 'START' || m.lastEvent === 'RESUME').map(m => m.employee_id)
    run(() => holdAssemblyJob(job.job_id, lineId, reason, activeIds))
  }
  function handleResumeAssembly() {
    const pausedIds = members.filter(m => m.lastEvent === 'PAUSE').map(m => m.employee_id)
    run(() => managerResumeAssemblyJob(job.job_id, lineId, pausedIds))
  }
  function handleCompleteAssembly() {
    const activeIds = members.filter(m => m.lastEvent === 'START' || m.lastEvent === 'RESUME').map(m => m.employee_id)
    run(() => completeAssemblyJob(job.job_id, lineId, activeIds))
  }

  // Assembly individual member toggle
  async function handleToggleMember(member) {
    setBusyMember(member.employee_id); setError('')
    try {
      const currentlyActive = member.lastEvent === 'START' || member.lastEvent === 'RESUME'
      await managerToggleAssemblyMember(member.employee_id, job.job_id, lineId, currentlyActive, members)
      onDone()
    } catch (e) {
      console.error(e); setError('Action failed — check connection.')
    } finally {
      setBusyMember(null)
    }
  }

  const visibleMembers = members?.filter(m => m.lastEvent !== 'COMPLETE') ?? []
  const availableToAdd = (allEmployees ?? []).filter(e => !existingIds.has(e.employee_id))

  if (addWorkerOpen) {
    return (
      <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-4">
        <div className="bg-stone-800 border border-stone-600 rounded-2xl w-full max-w-sm p-6 max-h-[90vh] overflow-y-auto">
          <div className="mb-4">
            <p className="text-xs text-stone-500 uppercase tracking-widest mb-1">Add Worker</p>
            <p className="text-base font-bold text-stone-100">PO {job.po_number}</p>
          </div>
          {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

          {/* Step 2 (weld only): confirm start time for selected worker */}
          {addTarget ? (
            <>
              <p className="text-stone-300 text-sm mb-1">Adding <strong>{addTarget.full_name}</strong></p>
              <p className="text-stone-500 text-xs mb-4">
                Set the time they actually started — backdate if they forgot to scan in.
              </p>
              <label className="block text-xs text-stone-500 uppercase tracking-widest mb-1">Start time</label>
              <input
                type="datetime-local"
                value={startTime}
                onChange={e => setStartTime(e.target.value)}
                className="w-full bg-stone-700 border border-stone-600 rounded-xl px-4 py-3
                           text-stone-100 text-sm mb-5 focus:outline-none focus:border-amber-500"
              />
              <button
                disabled={!!busyAdd || !startTime}
                onClick={() => handleAddWorker(addTarget, startTime)}
                className="w-full py-3 rounded-xl bg-emerald-700/30 border border-emerald-600 text-emerald-300 text-base mb-2">
                {busyAdd ? 'Adding…' : 'Confirm & Clock In'}
              </button>
              <button className="w-full text-sm text-stone-500 underline" onClick={() => setAddTarget(null)}>Back</button>
            </>
          ) : (
            /* Step 1: pick the worker */
            <>
              {allEmployees === null ? (
                <p className="text-stone-500 text-sm animate-pulse">Loading…</p>
              ) : availableToAdd.length === 0 ? (
                <p className="text-stone-500 text-sm">All department employees are already on this job.</p>
              ) : (
                <div className="space-y-1.5 mb-4">
                  {availableToAdd.map(e => (
                    <button key={e.employee_id}
                      disabled={!!busyAdd}
                      onClick={() => handleSelectWorker(e)}
                      className="w-full flex items-center justify-between px-4 py-3 rounded-xl
                                 bg-stone-700 hover:bg-stone-600 border border-stone-600 text-stone-200 text-sm">
                      <span>{e.full_name}</span>
                      {busyAdd === e.employee_id
                        ? <span className="text-stone-400 text-xs">Adding…</span>
                        : <span className="text-emerald-400 text-xs">+ Add</span>
                      }
                    </button>
                  ))}
                </div>
              )}
              <button className="w-full text-sm text-stone-500 underline" onClick={() => setAddWorkerOpen(false)}>Back</button>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-4">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl w-full max-w-sm p-6 max-h-[90vh] overflow-y-auto">

        {/* Header */}
        <div className="mb-5">
          <p className="text-xs text-stone-500 uppercase tracking-widest mb-1">
            {isAssembly ? `Assembly · ${action.lineName}` : emp.full_name}
          </p>
          <p className="text-lg font-bold text-stone-100">PO {job.po_number}</p>
          <p className="text-sm text-stone-400">{job.part_number}</p>
          <span className={`inline-block mt-2 px-3 py-0.5 rounded-full text-xs font-semibold ${
            isActive ? 'bg-amber-500/20 text-amber-400' : 'bg-orange-900/40 text-orange-400'
          }`}>
            {isActive ? 'Active' : 'Paused / On Hold'}
          </span>
        </div>

        {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

        {/* Assembly: individual member clock on/off */}
        {isAssembly && visibleMembers.length > 0 && (
          <div className="mb-5">
            <p className="text-xs text-stone-500 uppercase tracking-widest mb-2">Team</p>
            <div className="space-y-1.5">
              {visibleMembers.map(m => {
                const active = m.lastEvent === 'START' || m.lastEvent === 'RESUME'
                return (
                  <div key={m.employee_id} className="flex items-center justify-between">
                    <span className={`text-sm ${active ? 'text-stone-200' : 'text-stone-500'}`}>
                      {m.full_name}
                    </span>
                    <button
                      disabled={!!busyMember || busy}
                      onClick={() => handleToggleMember(m)}
                      className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                        active
                          ? 'border-orange-700 bg-orange-950/40 text-orange-400 hover:bg-orange-900/60'
                          : 'border-amber-700/50 bg-amber-950/30 text-amber-500 hover:bg-amber-900/40'
                      }`}>
                      {busyMember === m.employee_id ? '…' : active ? 'Clock Off' : 'Clock On'}
                    </button>
                  </div>
                )
              })}
            </div>
            <div className="border-t border-stone-700 mt-4 mb-4" />
          </div>
        )}

        {/* Hold reason picker */}
        {holdStep ? (
          <>
            <p className="text-stone-400 text-sm mb-3">Select hold reason:</p>
            <div className="space-y-2 mb-4">
              {HOLD_REASONS.map(r => (
                <button key={r.key} disabled={busy}
                  className="w-full text-left px-4 py-3 rounded-xl bg-stone-700 hover:bg-orange-900/40
                             border border-stone-600 hover:border-orange-700 text-stone-200 text-sm"
                  onClick={() => handleHoldAssembly(r.key)}>
                  {r.label}
                </button>
              ))}
            </div>
            <button className="w-full text-sm text-stone-500 underline" onClick={() => setHoldStep(false)}>Back</button>
          </>
        ) : (
          <div className="space-y-2">
            {isAssembly ? (
              <>
                {isActive && (
                  <button disabled={busy}
                    className="w-full py-3 rounded-xl border border-orange-700 bg-orange-950/40 text-orange-400 text-base"
                    onClick={() => setHoldStep(true)}>
                    ⚠ Hold Job
                  </button>
                )}
                {!isActive && (
                  <button disabled={busy}
                    className="w-full py-3 rounded-xl bg-amber-500/20 border border-amber-600 text-amber-300 text-base"
                    onClick={handleResumeAssembly}>
                    ▶ Resume Job
                  </button>
                )}
                <button disabled={busy}
                  className="w-full py-3 rounded-xl bg-emerald-700/30 border border-emerald-600 text-emerald-300 text-base"
                  onClick={handleCompleteAssembly}>
                  ✓ Complete Job
                </button>
              </>
            ) : (
              isActive ? (
                <>
                  <button disabled={busy}
                    className="w-full py-3 rounded-xl border border-orange-700 bg-orange-950/40 text-orange-400 text-base"
                    onClick={handlePauseWorker}>
                    ⏸ Pause Job
                  </button>
                  <button disabled={busy}
                    className="w-full py-3 rounded-xl bg-emerald-700/30 border border-emerald-600 text-emerald-300 text-base"
                    onClick={handleCompleteWorker}>
                    ✓ Complete Job
                  </button>
                </>
              ) : (
                <>
                  <button disabled={busy}
                    className="w-full py-3 rounded-xl bg-amber-500/20 border border-amber-600 text-amber-300 text-base"
                    onClick={handleResumeWorker}>
                    ▶ Resume Job
                  </button>
                  <button disabled={busy}
                    className="w-full py-3 rounded-xl bg-emerald-700/30 border border-emerald-600 text-emerald-300 text-base"
                    onClick={handleCompleteWorker}>
                    ✓ Complete Job
                  </button>
                </>
              )
            )}
            {/* Add Worker only makes sense for assembly (shared team jobs) */}
            {isAssembly && (
              <button disabled={busy}
                className="w-full py-3 rounded-xl border border-stone-600 bg-stone-700/40 text-stone-400 text-base hover:bg-stone-700"
                onClick={openAddWorker}>
                + Add Team Member
              </button>
            )}
            <button className="w-full mt-2 text-sm text-stone-500 underline pt-1" onClick={onClose}>Cancel</button>
          </div>
        )}
        {busy && <p className="text-stone-500 text-xs text-center mt-3 animate-pulse">Working…</p>}
      </div>
    </div>
  )
}

// ── Add Job modal — replicates full scan-on flow per department ───────────────
const ADD_JOB_DEPTS = [
  { key: 'kitting',  label: 'Kitting' },
  { key: 'weld',     label: 'Weld Shop' },
  { key: 'paint',    label: 'Paint Shop' },
  { key: 'assembly', label: 'Assembly' },
]

// Returns "YYYY-MM-DDTHH:MM" in the browser's local timezone (e.g. BST = UTC+1)
function nowLocal() {
  const d = new Date(); d.setSeconds(0, 0)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// datetime-local inputs are already in local time — interpret them as local, not UTC
function localInputToISO(dtLocalStr) {
  if (!dtLocalStr) return new Date().toISOString()
  const [datePart, timePart] = dtLocalStr.split('T')
  const [y, mo, d] = datePart.split('-').map(Number)
  const [h, mi]    = timePart.split(':').map(Number)
  return new Date(y, mo - 1, d, h, mi, 0, 0).toISOString()
}

function AddJobModal({ onClose, onDone }) {
  // shared
  const [step, setStep]             = useState('dept')
  const [dept, setDept]             = useState('')
  const [employees, setEmployees]   = useState(null)
  const [poNumber, setPoNumber]     = useState('')
  const [partNumber, setPartNumber] = useState('')
  const [startTime, setStartTime]   = useState(nowLocal)
  const [busy, setBusy]             = useState(false)
  const [error, setError]           = useState('')

  // weld / kitting / paint
  const [target, setTarget] = useState(null)

  // assembly
  const [lines, setLines]           = useState([])
  const [lineId, setLineId]         = useState(null)
  const [lineName, setLineName]     = useState('')
  const [selectedIds, setSelectedIds] = useState(new Set())

  const isAssembly = dept === 'assembly'

  async function selectDept(d) {
    setDept(d); setError('')
    try {
      const [emps, asmLines] = await Promise.all([
        fetchDepartmentEmployees(d),
        d === 'assembly' ? fetchAssemblyLines() : Promise.resolve([]),
      ])
      setEmployees(emps)
      setLines(asmLines)
      setStep(d === 'assembly' ? 'asm_line' : 'employee')
    } catch (e) {
      console.error(e); setError('Failed to load data.')
    }
  }

  function toggleMember(id) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // ── Confirm: weld / kitting / paint ──────────────────────────────────────
  async function handleConfirmSingle() {
    if (!poNumber.trim() || !partNumber.trim()) { setError('PO number and part number are required.'); return }
    setBusy(true); setError('')
    try {
      const { job } = await findOrCreateJob(poNumber.trim().toUpperCase(), partNumber.trim().toUpperCase(), dept)
      const ts = localInputToISO(startTime)
      await managerStartWorkerOnJob(target.employee_id, job.job_id, null, ts)
      onDone()
    } catch (e) {
      console.error(e); setError('Failed to create job.')
    } finally { setBusy(false) }
  }

  // ── Confirm: assembly ─────────────────────────────────────────────────────
  async function handleConfirmAssembly() {
    if (!poNumber.trim() || !partNumber.trim()) { setError('PO number and part number are required.'); return }
    if (selectedIds.size === 0) { setError('Select at least one team member.'); return }
    setBusy(true); setError('')
    try {
      const { job } = await findOrCreateJob(poNumber.trim().toUpperCase(), partNumber.trim().toUpperCase(), 'assembly')
      const ts = localInputToISO(startTime)
      await managerStartAssemblyJobFull(job.job_id, lineId, [...selectedIds], ts)
      onDone()
    } catch (e) {
      console.error(e); setError('Failed to start job.')
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-4">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl w-full max-w-sm p-6 max-h-[90vh] overflow-y-auto">
        <p className="text-xs text-stone-500 uppercase tracking-widest mb-4">Add Job</p>
        {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

        {/* Step 1: Department */}
        {step === 'dept' && (
          <>
            <p className="text-stone-300 text-sm mb-3">Which department?</p>
            <div className="space-y-2">
              {ADD_JOB_DEPTS.map(d => (
                <button key={d.key} onClick={() => selectDept(d.key)}
                  className="w-full px-4 py-3 rounded-xl bg-stone-700 hover:bg-stone-600 border border-stone-600 text-stone-200 text-sm text-left">
                  {d.label}
                </button>
              ))}
            </div>
            <button className="w-full text-sm text-stone-500 underline mt-4" onClick={onClose}>Cancel</button>
          </>
        )}

        {/* Step 2a (weld/kitting/paint): pick worker */}
        {step === 'employee' && (
          <>
            <p className="text-stone-300 text-sm mb-3">Select worker</p>
            {!employees
              ? <p className="text-stone-500 text-sm animate-pulse">Loading…</p>
              : <div className="space-y-1.5 mb-4 max-h-80 overflow-y-auto">
                  {employees.map(e => (
                    <button key={e.employee_id} onClick={() => { setTarget(e); setStep('details') }}
                      className="w-full px-4 py-3 rounded-xl bg-stone-700 hover:bg-stone-600 border border-stone-600 text-stone-200 text-sm text-left">
                      {e.full_name}
                    </button>
                  ))}
                </div>
            }
            <button className="w-full text-sm text-stone-500 underline" onClick={() => setStep('dept')}>Back</button>
          </>
        )}

        {/* Step 2b (assembly): pick line */}
        {step === 'asm_line' && (
          <>
            <p className="text-stone-300 text-sm mb-3">Select line</p>
            <div className="space-y-2 mb-4">
              {lines.map(l => (
                <button key={l.line_id} onClick={() => { setLineId(l.line_id); setLineName(l.line_name); setStep('asm_team') }}
                  className="w-full px-4 py-3 rounded-xl bg-stone-700 hover:bg-stone-600 border border-stone-600 text-stone-200 text-sm text-left font-semibold">
                  {l.line_name}
                </button>
              ))}
            </div>
            <button className="w-full text-sm text-stone-500 underline" onClick={() => setStep('dept')}>Back</button>
          </>
        )}

        {/* Step 3 (assembly): pick team members */}
        {step === 'asm_team' && (
          <>
            <p className="text-stone-300 text-sm mb-1">
              <span className="font-semibold text-sky-400">{lineName}</span> — select team
            </p>
            <p className="text-stone-500 text-xs mb-3">Tap to toggle. Selected members will all be clocked in together.</p>
            {!employees
              ? <p className="text-stone-500 text-sm animate-pulse">Loading…</p>
              : <div className="space-y-1.5 mb-4 max-h-80 overflow-y-auto">
                  {employees.map(e => {
                    const on = selectedIds.has(e.employee_id)
                    return (
                      <button key={e.employee_id} onClick={() => toggleMember(e.employee_id)}
                        className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border text-sm transition-colors ${
                          on
                            ? 'bg-sky-900/40 border-sky-600 text-sky-200'
                            : 'bg-stone-700 border-stone-600 text-stone-400 hover:bg-stone-600'
                        }`}>
                        <span>{e.full_name}</span>
                        <span className={`text-xs font-bold ${on ? 'text-sky-400' : 'text-stone-600'}`}>
                          {on ? '✓ On' : '+ Add'}
                        </span>
                      </button>
                    )
                  })}
                </div>
            }
            {selectedIds.size > 0 && (
              <p className="text-sky-400 text-xs mb-3">{selectedIds.size} selected</p>
            )}
            <button disabled={selectedIds.size === 0}
              onClick={() => setStep('asm_details')}
              className="w-full py-3 rounded-xl bg-stone-700 border border-stone-600 text-stone-200 text-base mb-2 disabled:opacity-40">
              Next →
            </button>
            <button className="w-full text-sm text-stone-500 underline" onClick={() => setStep('asm_line')}>Back</button>
          </>
        )}

        {/* Step 4 (weld etc): job details */}
        {(step === 'details' || step === 'asm_details') && (
          <>
            {step === 'details' && target && (
              <p className="text-stone-400 text-sm mb-4">Worker: <strong className="text-stone-200">{target.full_name}</strong></p>
            )}
            {step === 'asm_details' && (
              <p className="text-stone-400 text-sm mb-4">
                Line: <strong className="text-stone-200">{lineName}</strong> · {selectedIds.size} member{selectedIds.size !== 1 ? 's' : ''} selected
              </p>
            )}

            <label className="block text-xs text-stone-500 uppercase tracking-widest mb-1">PO Number</label>
            <input type="text" value={poNumber} onChange={e => setPoNumber(e.target.value)}
              placeholder="e.g. 12345"
              className="w-full bg-stone-700 border border-stone-600 rounded-xl px-4 py-3 text-stone-100 text-sm mb-3 focus:outline-none focus:border-amber-500" />

            <label className="block text-xs text-stone-500 uppercase tracking-widest mb-1">Part Number</label>
            <input type="text" value={partNumber} onChange={e => setPartNumber(e.target.value)}
              placeholder="e.g. ABC-001"
              className="w-full bg-stone-700 border border-stone-600 rounded-xl px-4 py-3 text-stone-100 text-sm mb-3 focus:outline-none focus:border-amber-500" />

            <label className="block text-xs text-stone-500 uppercase tracking-widest mb-1">Start time</label>
            <p className="text-stone-600 text-xs mb-1">Backdate if they forgot to scan in</p>
            <input type="datetime-local" value={startTime} onChange={e => setStartTime(e.target.value)}
              className="w-full bg-stone-700 border border-stone-600 rounded-xl px-4 py-3 text-stone-100 text-sm mb-5 focus:outline-none focus:border-amber-500" />

            <button disabled={busy}
              onClick={step === 'details' ? handleConfirmSingle : handleConfirmAssembly}
              className="w-full py-3 rounded-xl bg-emerald-700/30 border border-emerald-600 text-emerald-300 text-base mb-2">
              {busy ? 'Starting…' : step === 'details' ? `Clock In ${target?.full_name}` : `Start Job · ${selectedIds.size} on team`}
            </button>
            <button className="w-full text-sm text-stone-500 underline"
              onClick={() => setStep(step === 'details' ? 'employee' : 'asm_team')}>
              Back
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// ── Live timer cell ───────────────────────────────────────────────────────────
function LiveTimer({ events, breakRules, isActive }) {
  function compute() { return calcElapsed(events, breakRules) }
  const [ms, setMs] = useState(compute)
  useEffect(() => {
    setMs(compute())
    if (!isActive) return
    const id = setInterval(() => setMs(compute()), 1000)
    return () => clearInterval(id)
  }, [isActive, events, breakRules])
  return (
    <span className={`font-mono font-bold text-lg tabular-nums ${
      isActive ? 'text-amber-400' : 'text-stone-500'
    }`}>
      {formatDuration(ms)}
    </span>
  )
}

// ── Status dot ────────────────────────────────────────────────────────────────
function Dot({ active }) {
  return (
    <span className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${
      active ? 'bg-emerald-400' : 'bg-orange-500'
    }`} />
  )
}

// ── Individual dept row ───────────────────────────────────────────────────────
function WorkerRow({ emp, jobs, breakRules, onAction }) {
  const subLabel = SUB_DEPT_LABEL[emp.sub_department]
  return (
    <div className="border-b border-stone-700 last:border-0">
      {jobs.map((job, i) => (
        <div key={job.job_id}
          className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-stone-800/50 active:bg-stone-700/40 transition-colors"
          onClick={() => onAction({ type: 'worker', emp, job })}>
          <Dot active={job.isActive} />
          <div className="flex-1 min-w-0">
            <p className="text-stone-100 font-semibold">
              {i === 0 ? emp.full_name : ''}
              {i === 0 && subLabel && (
                <span className="ml-2 text-xs text-purple-400 font-normal">{subLabel}</span>
              )}
            </p>
            <p className="text-stone-400 text-sm truncate">
              PO {job.po_number} &nbsp;·&nbsp; {job.part_number}
              {job.holdReason && (
                <span className="ml-2 text-orange-400 text-xs">
                  ⏸ {HOLD_SHORT[job.holdReason] ?? job.holdReason}
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <LiveTimer events={job.events} breakRules={breakRules} isActive={job.isActive} />
            <span className="text-stone-600 text-xs">›</span>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Assembly total timer — sums credited hours across all team members ────────
// Each member's events carry their own split_count, so calcElapsed handles
// manager line-split and team member time correctly without mixing events.
function AssemblyTotalTimer({ members, breakRules, isActive }) {
  function compute() {
    return members.reduce((sum, m) => sum + calcElapsed(m.events, breakRules), 0)
  }
  const [ms, setMs] = useState(compute)
  useEffect(() => {
    setMs(compute())
    if (!isActive) return
    const id = setInterval(() => setMs(compute()), 1000)
    return () => clearInterval(id)
  }, [isActive, members, breakRules])
  return (
    <span className={`font-mono font-bold text-lg tabular-nums ${
      isActive ? 'text-amber-400' : 'text-stone-500'
    }`}>
      {formatDuration(ms)}
    </span>
  )
}

// ── Assembly line job row ─────────────────────────────────────────────────────
function AssemblyJobRow({ entry, breakRules, lineId, lineName, onAction }) {
  const { job, members, isActive, holdReason, team } = entry
  return (
    <div
      className="border-b border-stone-700 last:border-0 px-4 py-3 cursor-pointer hover:bg-stone-800/50 active:bg-stone-700/40 transition-colors"
      onClick={() => onAction({ type: 'assembly', job, lineId, lineName, members, isActive, holdReason })}>
      <div className="flex items-center gap-3">
        <Dot active={isActive} />
        <div className="flex-1 min-w-0">
          <p className="text-stone-100 font-semibold truncate">
            PO {job.po_number} &nbsp;·&nbsp; {job.part_number}
          </p>
          <p className="text-stone-500 text-xs mt-0.5 truncate">
            {team.length === 0
              ? 'No team assigned'
              : team.map(m => m.full_name).join(', ')
            }
          </p>
          {holdReason && (
            <p className="text-orange-400 text-xs mt-0.5">
              ⏸ {HOLD_SHORT[holdReason] ?? holdReason}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <AssemblyTotalTimer members={members} breakRules={breakRules} isActive={isActive} />
          <span className="text-stone-600 text-xs">›</span>
        </div>
      </div>
    </div>
  )
}

// ── Section card ──────────────────────────────────────────────────────────────
function Section({ title, badge, badgeColour = 'bg-stone-700 text-stone-300', children, empty }) {
  return (
    <div className="bg-stone-900 rounded-2xl border border-stone-700 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-stone-700 bg-stone-800/60">
        <h2 className="text-sm font-bold uppercase tracking-widest text-stone-300">{title}</h2>
        {badge != null && (
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${badgeColour}`}>
            {badge}
          </span>
        )}
      </div>
      {empty ? (
        <p className="text-stone-600 text-sm px-4 py-5 text-center">No active jobs</p>
      ) : children}
    </div>
  )
}

// ── Main report screen ────────────────────────────────────────────────────────
export default function ManagerReport({ onBack }) {
  const [report, setReport]         = useState(null)
  const [lines, setLines]           = useState([])
  const [breakRules, setBreakRules] = useState([])
  const [loading, setLoading]       = useState(true)
  const [lastRefresh, setLastRefresh] = useState(null)
  const [error, setError]           = useState('')
  const [actionModal, setActionModal] = useState(null)
  const [showAddJob, setShowAddJob]   = useState(false)
  const timerRef = useRef(null)

  async function refresh() {
    setError('')
    try {
      const [data, rules, lineList] = await Promise.all([
        loadManagerReport(),
        fetchBreakRules(),
        fetchAssemblyLines()
      ])
      setReport(data)
      setBreakRules(rules)
      setLines(lineList)
      setLastRefresh(new Date())
    } catch (err) {
      console.error(err)
      setError('Could not load data — check connection.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    timerRef.current = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(timerRef.current)
  }, [])

  const lineMap = Object.fromEntries(lines.map(l => [l.line_id, l.line_name]))

  // Count active workers across all individual depts
  const activeCount = report
    ? Object.values(report.individual).flat().filter(({ jobs }) => jobs.some(j => j.isActive)).length
    : 0

  return (
    <div className="flex flex-col min-h-screen bg-stone-950">

      {/* Header */}
      <div className="bg-stone-900 border-b border-stone-700 px-5 py-4 flex items-center justify-between shrink-0 gap-3">
        <div className="min-w-0">
          <p className="text-xs text-stone-500 uppercase tracking-widest">Live Overview</p>
          <p className="text-xl font-bold text-stone-100">SFM Job Tracker</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {lastRefresh && (
            <p className="text-xs text-stone-600 hidden sm:block">
              Updated {lastRefresh.toLocaleTimeString()}
            </p>
          )}
          <button
            className="bg-emerald-800/40 border border-emerald-700 text-emerald-300 px-4 py-2.5 rounded-xl text-sm"
            onClick={() => setShowAddJob(true)}
          >
            + Add Job
          </button>
          <button className="btn-danger px-4 py-2.5 text-sm" onClick={onBack}>
            ← Back
          </button>
        </div>
      </div>


      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-5 space-y-5">

        {loading && (
          <div className="text-center py-20 text-stone-600">
            <p className="text-2xl animate-pulse">Loading…</p>
          </div>
        )}

        {error && (
          <div className="bg-red-900/40 border border-red-700 rounded-xl px-4 py-3 text-red-300 text-sm text-center">
            {error}
          </div>
        )}

        {report && !loading && (
          <>
            {/* ── Kitting ──────────────────────────────────────────────── */}
            {(() => {
              const workers = report.individual.kitting ?? []
              const active  = workers.filter(w => w.jobs.some(j => j.isActive)).length
              return (
                <Section
                  title="Kitting"
                  badge={active > 0 ? `${active} active` : 'none active'}
                  badgeColour={active > 0 ? 'bg-sky-500/20 text-sky-400' : 'bg-stone-700 text-stone-500'}
                  empty={workers.length === 0}
                >
                  {workers
                    .sort((a, b) => {
                      const aA = a.jobs.some(j => j.isActive) ? 0 : 1
                      const bA = b.jobs.some(j => j.isActive) ? 0 : 1
                      return aA - bA
                    })
                    .map(({ emp, jobs }) => (
                      <WorkerRow key={emp.employee_id} emp={emp} jobs={jobs} breakRules={breakRules} onAction={setActionModal} />
                    ))
                  }
                </Section>
              )
            })()}

            {/* ── Weld ─────────────────────────────────────────────────── */}
            {(() => {
              const workers = report.individual.weld ?? []
              const active  = workers.filter(w => w.jobs.some(j => j.isActive)).length
              return (
                <Section
                  title="Weld Shop"
                  badge={active > 0 ? `${active} active` : 'none active'}
                  badgeColour={active > 0 ? 'bg-amber-500/20 text-amber-400' : 'bg-stone-700 text-stone-500'}
                  empty={workers.length === 0}
                >
                  {workers
                    .sort((a, b) => {
                      const aA = a.jobs.some(j => j.isActive) ? 0 : 1
                      const bA = b.jobs.some(j => j.isActive) ? 0 : 1
                      return aA - bA
                    })
                    .map(({ emp, jobs }) => (
                      <WorkerRow key={emp.employee_id} emp={emp} jobs={jobs} breakRules={breakRules} onAction={setActionModal} />
                    ))
                  }
                </Section>
              )
            })()}

            {/* ── Paint ────────────────────────────────────────────────── */}
            {(() => {
              const workers = report.individual.paint ?? []
              const active  = workers.filter(w => w.jobs.some(j => j.isActive)).length
              const PAINT_ORDER = ['blast','prep','paint','pack']
              const PAINT_LABEL = { blast: 'Blast', prep: 'Prep', paint: 'Paint', pack: 'Pack' }
              const grouped = PAINT_ORDER.map(sub => ({
                sub,
                label: PAINT_LABEL[sub],
                workers: workers.filter(w => w.emp.sub_department === sub)
              })).filter(g => g.workers.length > 0)

              return (
                <div className="bg-stone-900 rounded-2xl border border-stone-700 overflow-hidden">
                  <div className="flex items-center gap-3 px-4 py-3 border-b border-stone-700 bg-stone-800/60">
                    <h2 className="text-sm font-bold uppercase tracking-widest text-stone-300">Paint Shop</h2>
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                      active > 0 ? 'bg-purple-500/20 text-purple-400' : 'bg-stone-700 text-stone-500'
                    }`}>
                      {active > 0 ? `${active} active` : 'none active'}
                    </span>
                  </div>
                  {workers.length === 0 ? (
                    <p className="text-stone-600 text-sm px-4 py-5 text-center">No active jobs</p>
                  ) : (
                    <div className="divide-y divide-stone-700">
                      {grouped.map(({ sub, label, workers: grpWorkers }) => {
                        const grpActive = grpWorkers.filter(w => w.jobs.some(j => j.isActive)).length
                        return (
                          <div key={sub}>
                            <div className="flex items-center gap-3 px-4 py-2.5 bg-stone-800/60 border-l-2 border-purple-600">
                              <span className="text-xs font-bold text-purple-300 uppercase tracking-wider">{label}</span>
                              {grpActive > 0 && (
                                <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400">
                                  {grpActive} active
                                </span>
                              )}
                            </div>
                            {grpWorkers.map(({ emp, jobs }) => (
                              <WorkerRow key={emp.employee_id} emp={emp} jobs={jobs} breakRules={breakRules} onAction={setActionModal} />
                            ))}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })()}

            {/* ── Assembly ─────────────────────────────────────────────── */}
            {(() => {
              const asmLines = Object.entries(report.assembly).sort(([a], [b]) => Number(a) - Number(b))
              const totalActive = asmLines.reduce((sum, [, jobs]) => sum + jobs.filter(j => j.isActive).length, 0)
              return (
                <div className="bg-stone-900 rounded-2xl border border-stone-700 overflow-hidden">
                  {/* Assembly header */}
                  <div className="flex items-center gap-3 px-4 py-3 border-b border-stone-700 bg-stone-800/60">
                    <h2 className="text-sm font-bold uppercase tracking-widest text-stone-300">Assembly</h2>
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                      totalActive > 0 ? 'bg-amber-500/20 text-amber-400' : 'bg-stone-700 text-stone-500'
                    }`}>
                      {totalActive > 0 ? `${totalActive} active` : 'none active'}
                    </span>
                  </div>
                  {asmLines.length === 0 ? (
                    <p className="text-stone-600 text-sm px-4 py-5 text-center">No active jobs</p>
                  ) : (
                    <div className="divide-y divide-stone-700">
                      {asmLines.map(([lineId, jobs]) => {
                        const activeJobs = jobs.filter(j => j.isActive).length
                        return (
                          <div key={lineId}>
                            {/* Line sub-header */}
                            <div className="flex items-center gap-3 px-4 py-2.5 bg-stone-800/60 border-l-2 border-sky-600">
                              <span className="text-xs font-bold text-sky-300 uppercase tracking-wider">
                                {lineMap[lineId] ?? `Line ${lineId}`}
                              </span>
                              <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                                activeJobs > 0 ? 'bg-amber-500/20 text-amber-400' : 'bg-orange-900/40 text-orange-400'
                              }`}>
                                {activeJobs > 0 ? `${activeJobs} active` : 'on hold'}
                              </span>
                            </div>
                            {jobs.map((entry, i) => (
                              <AssemblyJobRow key={i} entry={entry} breakRules={breakRules}
                                lineId={lineId} lineName={lineMap[lineId] ?? `Line ${lineId}`}
                                onAction={setActionModal} />
                            ))}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })()}
          </>
        )}
      </div>

      {actionModal && (
        <ManagerActionModal
          action={actionModal}
          onClose={() => setActionModal(null)}
          onDone={() => { setActionModal(null); refresh() }}
        />
      )}

      {showAddJob && (
        <AddJobModal
          onClose={() => setShowAddJob(false)}
          onDone={() => { setShowAddJob(false); refresh() }}
        />
      )}
    </div>
  )
}
