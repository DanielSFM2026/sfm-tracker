import { useEffect, useMemo, useRef, useState } from 'react'
import {
  loadManagerReport, fetchBreakRules, fetchAssemblyLines, fetchJobEventsCount,
  pauseJob, resumeJob, completeJob, rebalanceEmployeeSplit,
  holdAssemblyJob, managerResumeAssemblyJob, completeAssemblyJob, managerToggleAssemblyMember,
  fetchDepartmentEmployees, managerStartWorkerOnJob, managerStartAssemblyJobFull,
  findOrCreateJob, addTeamMemberToJob, employeeHasCompletedJob,
  loadJobHistory, loadJobEvents, updateEventTimestamp, deleteJobEvent, addJobEvent,
  deleteCreatedJob,
} from '../lib/db'
import { calcElapsed, formatDuration, isJobActive, parseJobBarcode } from '../lib/timeCalc'
import { holdReasonsFor, HOLD_REASON_LABEL } from '../lib/constants'
import PlanDashboard from '../components/PlanDashboard'
import ManagerWeeklyPlan from '../components/ManagerWeeklyPlan'

const REFRESH_MS      = 10_000   // change-probe cadence (tiny request)
const FULL_REFRESH_MS = 60_000   // full reload at least this often

// A job stays "active" as long as its last event is START/RESUME with nothing
// closing it — if a device dies or a tab gets killed mid-shift, that interval
// never gets a PAUSE/AUTO_LOGOUT and just keeps accruing hours silently.
// Flag anything open longer than a normal shift so it gets caught within a
// day, not two weeks later.
const STALE_HOURS = 16

// Walk the already-loaded live report for any active job/team-member whose
// current (still open) interval has run past STALE_HOURS. No extra queries —
// this reuses the same data already rendered on the Live Overview.
function findStaleSessions(report) {
  if (!report) return []
  const now = Date.now()
  const out = []

  for (const dept of Object.keys(report.individual)) {
    for (const { emp, jobs } of report.individual[dept]) {
      for (const job of jobs) {
        if (!job.isActive) continue
        const last = job.events[job.events.length - 1]
        const hours = (now - new Date(last.event_timestamp).getTime()) / 3_600_000
        if (hours >= STALE_HOURS) {
          out.push({ kind: 'worker', dept, emp, job, hours })
        }
      }
    }
  }

  for (const [lineId, jobs] of Object.entries(report.assembly)) {
    for (const entry of jobs) {
      for (const m of entry.team) {
        const last = m.events[m.events.length - 1]
        if (!last || (last.event_type !== 'START' && last.event_type !== 'RESUME')) continue
        const hours = (now - new Date(last.event_timestamp).getTime()) / 3_600_000
        if (hours >= STALE_HOURS) {
          out.push({
            kind: 'assembly', lineId, memberName: m.full_name, hours,
            job: entry.job, members: entry.members, isActive: entry.isActive, holdReason: entry.holdReason,
          })
        }
      }
    }
  }

  out.sort((a, b) => b.hours - a.hours)
  return out
}

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

// Short display labels for the live view; falls back to HOLD_REASON_LABEL
// (constants.js is the single source of truth for the pickable reasons)
const HOLD_SHORT = {
  missing_parts_sfm:          'Missing Parts (SFM)',
  poor_quality_sfm:           'Poor Quality (SFM)',
  missing_parts_supply_chain: 'Missing Parts (Supply Chain)',
  poor_quality_supply_chain:  'Poor Quality (Supply Chain)',
  CLOCKED_OUT:                'Clocked Out',
}

const holdLabel = key => HOLD_SHORT[key] ?? HOLD_REASON_LABEL[key] ?? key

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
  const [localMembers, setLocalMembers] = useState(() => action.members ?? [])
  const [deleteJobArm, setDeleteJobArm] = useState(false)
  const [editingRecord, setEditingRecord] = useState(null)   // record passed to EditTimestampsModal

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
  function handlePauseWorker(reason = null) {
    run(async () => {
      await pauseJob(emp.employee_id, job.job_id, reason)
      await rebalanceEmployeeSplit(emp.employee_id, job.job_id)
    })
  }
  function handleResumeWorker() {
    run(() => resumeJob(emp.employee_id, job.job_id))
  }
  function handleCompleteWorker() {
    // Manager complete = force-close the whole machine, even if the weld
    // grid isn't fully covered (the manual override for stuck jobs)
    run(async () => {
      await completeJob(emp.employee_id, job.job_id, { force: true })
      await rebalanceEmployeeSplit(emp.employee_id, job.job_id)
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

  // Assembly individual member toggle — keeps modal open, updates local state
  async function handleToggleMember(member) {
    setBusyMember(member.employee_id); setError('')
    try {
      const currentlyActive = member.lastEvent === 'START' || member.lastEvent === 'RESUME'
      await managerToggleAssemblyMember(member.employee_id, job.job_id, lineId, currentlyActive, localMembers)
      setLocalMembers(prev => prev.map(m =>
        m.employee_id === member.employee_id
          ? { ...m, lastEvent: currentlyActive ? 'PAUSE' : 'RESUME' }
          : m
      ))
    } catch (e) {
      console.error(e); setError('Action failed — check connection.')
    } finally {
      setBusyMember(null)
    }
  }

  const visibleMembers = localMembers.filter(m => m.lastEvent !== 'COMPLETE')
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
    <>
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
            isActive ? 'bg-amber-500/20 text-amber-400' : action.holdReason === 'CLOCKED_OUT' ? 'bg-amber-900/40 text-amber-400' : 'bg-red-900/40 text-red-400'
          }`}>
            {isActive ? 'Active' : action.holdReason === 'CLOCKED_OUT' ? 'Clocked Out' : 'On Hold'}
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
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setEditingRecord({
                          job_id: job.job_id, employee_id: m.employee_id, department: 'assembly',
                          full_name: m.full_name, po_number: job.po_number, part_number: job.part_number,
                        })}
                        className="text-xs text-amber-500 underline hover:text-amber-300">
                        Edit log
                      </button>
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
                  </div>
                )
              })}
            </div>
            <div className="border-t border-stone-700 mt-4 mb-4" />
          </div>
        )}

        {/* Hold/pause reason picker */}
        {holdStep ? (
          <>
            <p className="text-stone-400 text-sm mb-3">Select {isAssembly ? 'hold' : 'pause'} reason:</p>
            <div className="space-y-2 mb-4">
              {holdReasonsFor(isAssembly ? 'assembly' : emp?.department).map(r => (
                <button key={r.key} disabled={busy}
                  className="w-full text-left px-4 py-3 rounded-xl bg-stone-700 hover:bg-orange-900/40
                             border border-stone-600 hover:border-orange-700 text-stone-200 text-sm"
                  onClick={() => isAssembly ? handleHoldAssembly(r.key) : handlePauseWorker(r.key)}>
                  {r.label}
                </button>
              ))}
              {!isAssembly && (
                <button disabled={busy}
                  className="w-full text-left px-4 py-3 rounded-xl bg-stone-700/50 hover:bg-stone-700
                             border border-stone-600 text-stone-400 text-sm"
                  onClick={() => handlePauseWorker(null)}>
                  Other / Just Pause
                </button>
              )}
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
                    onClick={() => setHoldStep(true)}>
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
            {/* Fix the historical log directly — same tool as History → Edit,
                reachable here so a stale/wrong session can be corrected on the spot */}
            {!isAssembly && (
              <button disabled={busy}
                className="w-full py-3 rounded-xl border border-stone-600 bg-stone-700/40 text-stone-300 text-base hover:bg-stone-700"
                onClick={() => setEditingRecord({
                  job_id: job.job_id, employee_id: emp.employee_id, department: emp.department,
                  full_name: emp.full_name, po_number: job.po_number, part_number: job.part_number,
                })}>
                📝 Edit Log
              </button>
            )}
            {/* Add Worker only makes sense for assembly (shared team jobs) */}
            {isAssembly && (
              <button disabled={busy}
                className="w-full py-3 rounded-xl border border-stone-600 bg-stone-700/40 text-stone-400 text-base hover:bg-stone-700"
                onClick={openAddWorker}>
                + Add Team Member
              </button>
            )}
            <button disabled={busy}
              onClick={() => {
                if (!deleteJobArm) { setDeleteJobArm(true); return }
                run(() => deleteCreatedJob(job.job_id))
              }}
              className={`w-full py-3 rounded-xl border text-sm transition-colors disabled:opacity-40 ${
                deleteJobArm
                  ? 'border-red-500 bg-red-600/30 text-red-200 font-bold'
                  : 'border-red-900/60 bg-red-950/20 text-red-400/80 hover:bg-red-950/40'
              }`}>
              {deleteJobArm ? 'Tap again — deletes the job and ALL its time' : '🗑 Delete Job'}
            </button>
            <button className="w-full mt-2 text-sm text-stone-500 underline pt-1" onClick={onDone}>Close</button>
          </div>
        )}
        {busy && <p className="text-stone-500 text-xs text-center mt-3 animate-pulse">Working…</p>}
      </div>
    </div>
    {editingRecord && (
      <EditTimestampsModal
        record={editingRecord}
        onClose={() => setEditingRecord(null)}
        onSaved={() => { setEditingRecord(null); onDone() }}
      />
    )}
    </>
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
  const [warning, setWarning]       = useState('')  // non-blocking warning requiring confirmation
  const [confirmed, setConfirmed]   = useState(false)

  // weld / kitting / paint
  const [target, setTarget] = useState(null)
  const [activityType, setActivityType] = useState(null)   // weld only: tack / weld / tack_weld
  const [workType, setWorkType]         = useState(null)    // weld only: parts / frames / parts_frames

  // assembly
  const [lines, setLines]           = useState([])
  const [lineId, setLineId]         = useState(null)
  const [lineName, setLineName]     = useState('')
  const [selectedIds, setSelectedIds] = useState(new Set())

  const isAssembly = dept === 'assembly'
  const isWeld     = dept === 'weld'
  const ACTIVITY_LABEL = { tack: 'Tack', weld: 'Weld', tack_weld: 'Tack & Weld' }

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
    setBusy(true); setError(''); setWarning('')
    try {
      const { job, created } = await findOrCreateJob(poNumber.trim().toUpperCase(), partNumber.trim().toUpperCase(), dept)
      if (!created && !confirmed) {
        const alreadyDone = await employeeHasCompletedJob(target.employee_id, job.job_id)
        if (alreadyDone) {
          setWarning(`${target.full_name} has already completed this job. Their previous time will be kept. Press Confirm again to proceed.`)
          setConfirmed(true)
          setBusy(false)
          return
        }
      }
      const ts = localInputToISO(startTime)
      await managerStartWorkerOnJob(target.employee_id, job.job_id, null, ts, activityType, workType)
      onDone()
    } catch (e) {
      console.error(e); setError('Failed to create job.')
    } finally { setBusy(false) }
  }

  // ── Confirm: assembly ─────────────────────────────────────────────────────
  async function handleConfirmAssembly() {
    if (!poNumber.trim() || !partNumber.trim()) { setError('PO number and part number are required.'); return }
    if (selectedIds.size === 0) { setError('Select at least one team member.'); return }
    setBusy(true); setError(''); setWarning('')
    try {
      const { job, created } = await findOrCreateJob(poNumber.trim().toUpperCase(), partNumber.trim().toUpperCase(), 'assembly')
      if (!created && !confirmed) {
        setWarning(`This job already exists in the system. Previous time will be kept. Press Confirm again to proceed.`)
        setConfirmed(true)
        setBusy(false)
        return
      }
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
                    <button key={e.employee_id} onClick={() => { setTarget(e); setStep(isWeld ? 'activity' : 'details') }}
                      className="w-full px-4 py-3 rounded-xl bg-stone-700 hover:bg-stone-600 border border-stone-600 text-stone-200 text-sm text-left">
                      {e.full_name}
                    </button>
                  ))}
                </div>
            }
            <button className="w-full text-sm text-stone-500 underline" onClick={() => setStep('dept')}>Back</button>
          </>
        )}

        {/* Weld only — same two questions the worker's own clock-on screen asks */}
        {step === 'activity' && (
          <>
            <p className="text-stone-300 text-sm mb-1">
              What's <strong className="text-stone-100">{target?.full_name}</strong> doing?
            </p>
            <p className="text-stone-500 text-xs mb-4">Step 1 of 2</p>
            <div className="flex flex-col gap-2 mb-2">
              <button className="py-4 rounded-xl bg-amber-500/20 border border-amber-600 text-amber-300 text-lg font-semibold"
                onClick={() => { setActivityType('tack'); setStep('work') }}>Tack</button>
              <button className="py-4 rounded-xl bg-stone-700 border border-stone-600 text-stone-200 text-lg font-semibold"
                onClick={() => { setActivityType('weld'); setStep('work') }}>Weld</button>
              <button className="py-4 rounded-xl border border-stone-600 text-stone-300 text-lg"
                onClick={() => { setActivityType('tack_weld'); setStep('work') }}>Tack &amp; Weld</button>
            </div>
            <button className="w-full text-sm text-stone-500 underline mt-1" onClick={() => setStep('employee')}>Back</button>
          </>
        )}

        {step === 'work' && (
          <>
            <p className="text-stone-300 text-sm mb-1">Working on?</p>
            <p className="text-stone-500 text-xs mb-4">
              Step 2 of 2 · <span className="text-amber-400">{ACTIVITY_LABEL[activityType]}</span>
            </p>
            <div className="flex flex-col gap-2 mb-2">
              <button className="py-4 rounded-xl bg-amber-500/20 border border-amber-600 text-amber-300 text-lg font-semibold"
                onClick={() => { setWorkType('parts'); setStep('details') }}>Parts</button>
              <button className="py-4 rounded-xl bg-stone-700 border border-stone-600 text-stone-200 text-lg font-semibold"
                onClick={() => { setWorkType('frames'); setStep('details') }}>Frames</button>
              <button className="py-4 rounded-xl border border-stone-600 text-stone-300 text-lg"
                onClick={() => { setWorkType('parts_frames'); setStep('details') }}>Parts &amp; Frames</button>
            </div>
            <button className="w-full text-sm text-stone-500 underline mt-1" onClick={() => setStep('activity')}>Back</button>
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
              <p className="text-stone-400 text-sm mb-4">
                Worker: <strong className="text-stone-200">{target.full_name}</strong>
                {isWeld && <> · <span className="text-amber-400">{ACTIVITY_LABEL[activityType]}</span></>}
              </p>
            )}
            {step === 'asm_details' && (
              <p className="text-stone-400 text-sm mb-4">
                Line: <strong className="text-stone-200">{lineName}</strong> · {selectedIds.size} member{selectedIds.size !== 1 ? 's' : ''} selected
              </p>
            )}

            <label className="block text-xs text-stone-500 uppercase tracking-widest mb-1">Scan Barcode</label>
            <input
              type="text"
              placeholder="▌ Scan or paste barcode (PO/PART)"
              autoComplete="off" autoCorrect="off" spellCheck={false}
              className="w-full bg-stone-900 border-2 border-stone-600 rounded-xl px-4 py-3 text-stone-100 text-sm mb-4 focus:outline-none focus:border-amber-500 placeholder-stone-600"
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  const parsed = parseJobBarcode(e.target.value)
                  if (parsed) { setPoNumber(parsed.poNumber); setPartNumber(parsed.partNumber); e.target.value = '' }
                }
              }}
            />

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

            {warning && (
              <div className="bg-amber-900/40 border border-amber-600 rounded-xl px-4 py-3 text-amber-300 text-sm mb-3">
                ⚠ {warning}
              </div>
            )}
            <button disabled={busy}
              onClick={step === 'details' ? handleConfirmSingle : handleConfirmAssembly}
              className="w-full py-3 rounded-xl bg-emerald-700/30 border border-emerald-600 text-emerald-300 text-base mb-2">
              {busy ? 'Starting…' : confirmed ? 'Confirm' : step === 'details' ? `Clock In ${target?.full_name}` : `Start Job · ${selectedIds.size} on team`}
            </button>
            <button className="w-full text-sm text-stone-500 underline"
              onClick={() => setStep(step === 'details' ? (isWeld ? 'work' : 'employee') : 'asm_team')}>
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
function Dot({ active, onHold }) {
  return (
    <span className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${
      active ? 'bg-emerald-400' : onHold ? 'bg-red-500' : 'bg-orange-500'
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
                <span className="ml-2 text-xs text-red-400 font-normal">{subLabel}</span>
              )}
            </p>
            <p className="text-stone-400 text-sm truncate">
              PO {job.po_number} &nbsp;·&nbsp; {job.part_number}
              {job.holdReason && (
                <span className={`ml-2 text-xs ${job.holdReason === 'CLOCKED_OUT' ? 'text-amber-400' : 'text-red-400'}`}>
                  {job.holdReason === 'CLOCKED_OUT' ? '🕐' : '⏸'} {holdLabel(job.holdReason)}
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
        <Dot active={isActive} onHold={!isActive && !!holdReason} />
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
            <p className={`text-xs mt-0.5 ${holdReason === 'CLOCKED_OUT' ? 'text-amber-400' : 'text-red-400'}`}>
              {holdReason === 'CLOCKED_OUT' ? '🕐' : '⏸'} {holdLabel(holdReason)}
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
// accent: Tailwind border-color class e.g. 'border-amber-500'
function Section({ title, badge, badgeColour = 'bg-stone-700 text-stone-300', accent = 'border-stone-600', children, empty }) {
  return (
    <div className={`bg-stone-900 rounded-2xl border border-stone-700 overflow-hidden border-t-2 ${accent}`}>
      <div className="flex items-center gap-3 px-4 py-3 border-b border-stone-700">
        <h2 className="text-sm font-bold uppercase tracking-widest text-stone-200">{title}</h2>
        {badge != null && (
          <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${badgeColour}`}>
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

// ── Edit timestamps modal ─────────────────────────────────────────────────────
function EditTimestampsModal({ record, onClose, onSaved }) {
  const [events, setEvents]   = useState(null)
  const [saving, setSaving]   = useState(false)  // saving all changes
  const [editVal, setEditVal] = useState({})     // eventId → local datetime string
  const [origVal, setOrigVal] = useState({})     // eventId → value as loaded (change detection)
  const [error, setError]     = useState('')
  const [deleteArm, setDeleteArm] = useState(null)  // eventId armed for delete (second tap confirms)
  const [addType, setAddType] = useState('PAUSE')
  const [addTime, setAddTime] = useState('')
  const [adding, setAdding]   = useState(false)

  async function reloadEvents() {
    const evs = await loadJobEvents(record.job_id, record.employee_id)
    setEvents(evs)
    const defaults = {}
    for (const ev of evs) defaults[ev.event_id] = toLocalInput(new Date(ev.event_timestamp))
    setEditVal(defaults)
    setOrigVal(defaults)
  }

  const changedIds = events
    ? events.map(ev => ev.event_id).filter(id => editVal[id] && editVal[id] !== origVal[id])
    : []

  async function handleDelete(eventId) {
    if (deleteArm !== eventId) { setDeleteArm(eventId); return }
    setDeleteArm(null); setError('')
    try {
      await deleteJobEvent(eventId)
      await reloadEvents()
      onSaved()
    } catch { setError('Failed to delete — check connection.') }
  }

  async function handleAdd() {
    if (!addTime) return
    setAdding(true); setError('')
    try {
      await addJobEvent({
        jobId:        record.job_id,
        employeeId:   record.employee_id,
        eventType:    addType,
        isoTimestamp: localInputToISO(addTime)
      })
      setAddTime('')
      await reloadEvents()
      onSaved()
    } catch { setError('Failed to add event — check connection.') }
    finally { setAdding(false) }
  }

  useEffect(() => {
    reloadEvents().catch(() => setError('Could not load events.'))
  }, [record.job_id, record.employee_id])

  function toLocalInput(date) {
    const y  = date.getFullYear()
    const mo = String(date.getMonth() + 1).padStart(2, '0')
    const d  = String(date.getDate()).padStart(2, '0')
    const h  = String(date.getHours()).padStart(2, '0')
    const mi = String(date.getMinutes()).padStart(2, '0')
    return `${y}-${mo}-${d}T${h}:${mi}`
  }

  // One save for every edited row — the list only re-sorts once, after saving
  async function handleSaveAll() {
    if (!changedIds.length) return
    setSaving(true); setError('')
    try {
      for (const id of changedIds) {
        await updateEventTimestamp(id, localInputToISO(editVal[id]))
      }
      await reloadEvents()
      onSaved()
    } catch { setError('Failed to save — check connection.') }
    finally { setSaving(false) }
  }

  const TYPE_COLOUR = { START: 'text-emerald-400', RESUME: 'text-emerald-400', PAUSE: 'text-orange-400', COMPLETE: 'text-blue-400', AUTO_LOGOUT: 'text-red-400' }

  return (
    <div className="fixed inset-0 bg-black/80 flex items-start justify-center z-50 overflow-y-auto py-6 px-4">
      <div className="bg-stone-900 border border-stone-700 rounded-2xl w-full max-w-lg">
        <div className="px-6 py-5 border-b border-stone-700">
          <p className="text-xs text-stone-500 uppercase tracking-widest mb-1">{record.department} · {record.full_name}</p>
          <p className="text-xl font-bold text-stone-100">PO {record.po_number}</p>
          <p className="text-stone-400 text-sm">Part: {record.part_number}</p>
        </div>

        <div className="px-6 py-4 space-y-3">
          {error && <p className="text-red-400 text-sm bg-red-900/20 rounded-xl px-4 py-3">{error}</p>}
          {!events && !error && <p className="text-stone-500 animate-pulse text-sm text-center py-4">Loading events…</p>}
          {events?.map(ev => (
            <div key={ev.event_id} className="bg-stone-800 rounded-xl px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <span className={`text-xs font-bold uppercase tracking-wide ${TYPE_COLOUR[ev.event_type] ?? 'text-stone-400'}`}>
                  {ev.event_type}
                </span>
                <div className="flex items-center gap-3">
                  {ev.split_count > 1 && (
                    <span className="text-xs text-stone-600">÷{ev.split_count}</span>
                  )}
                  <button
                    onClick={() => handleDelete(ev.event_id)}
                    className={`text-xs px-2 py-1 rounded-lg border transition-colors ${
                      deleteArm === ev.event_id
                        ? 'bg-red-600/40 border-red-500 text-red-200 font-bold'
                        : 'border-stone-700 text-stone-600 hover:text-red-400 hover:border-red-800'
                    }`}>
                    {deleteArm === ev.event_id ? 'Tap to confirm' : '✕'}
                  </button>
                </div>
              </div>
              {ev.hold_reason && (
                <p className="text-xs text-orange-400/90 -mt-1 mb-2">{holdLabel(ev.hold_reason)}</p>
              )}
              <input
                type="datetime-local"
                value={editVal[ev.event_id] ?? ''}
                onChange={e => setEditVal(prev => ({ ...prev, [ev.event_id]: e.target.value }))}
                className={`w-full bg-stone-700 border rounded-lg px-3 py-2 text-stone-100 text-sm outline-none focus:border-amber-500 ${
                  editVal[ev.event_id] !== origVal[ev.event_id] ? 'border-amber-500' : 'border-stone-600'
                }`}
              />
            </div>
          ))}
        </div>

        {events && (
          <div className="px-6 pb-4">
            <p className="text-xs text-stone-500 uppercase tracking-widest mb-2">Add missed event</p>
            <div className="flex gap-2 items-center">
              <select
                value={addType}
                onChange={e => setAddType(e.target.value)}
                className="bg-stone-700 border border-stone-600 rounded-lg px-2 py-2 text-stone-100 text-sm outline-none">
                <option value="START">START</option>
                <option value="PAUSE">PAUSE</option>
                <option value="RESUME">RESUME</option>
                <option value="COMPLETE">COMPLETE</option>
              </select>
              <input
                type="datetime-local"
                value={addTime}
                onChange={e => setAddTime(e.target.value)}
                className="flex-1 bg-stone-700 border border-stone-600 focus:border-amber-500 rounded-lg px-3 py-2 text-stone-100 text-sm outline-none"
              />
              <button
                disabled={adding || !addTime}
                onClick={handleAdd}
                className="bg-emerald-600/30 border border-emerald-600 text-emerald-300 text-xs px-3 py-2 rounded-lg hover:bg-emerald-600/50 transition-colors disabled:opacity-40">
                {adding ? '…' : '+ Add'}
              </button>
            </div>
          </div>
        )}

        <div className="px-6 pb-6 flex gap-3">
          <button className="btn-ghost flex-1" onClick={onClose}>Close</button>
          <button
            disabled={saving || changedIds.length === 0}
            onClick={handleSaveAll}
            className="flex-1 bg-amber-600/30 border border-amber-600 text-amber-300 py-3 rounded-xl text-sm font-semibold hover:bg-amber-600/50 transition-colors disabled:opacity-40">
            {saving ? 'Saving…' : changedIds.length ? `Save Changes (${changedIds.length})` : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── History view ──────────────────────────────────────────────────────────────
function HistoryView({ breakRules }) {
  const today = new Date()
  const fmt   = d => d.toISOString().slice(0, 10)

  const [fromDate, setFromDate] = useState(fmt(new Date(today.getFullYear(), today.getMonth(), 1)))
  const [toDate,   setToDate]   = useState(fmt(today))
  const [dept,     setDept]     = useState('')
  const [records,  setRecords]  = useState(null)
  const [allRecords, setAllRecords] = useState(null)
  const [mode,     setMode]     = useState('individual')  // 'individual' | 'by_job'
  const [expanded, setExpanded] = useState(null)          // expanded job group key
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [editing,  setEditing]  = useState(null)
  const [lineNames, setLineNames] = useState({})

  useEffect(() => {
    fetchAssemblyLines()
      .then(ls => setLineNames(Object.fromEntries(ls.map(l => [l.line_id, l.line_name]))))
      .catch(console.error)
  }, [])

  // Small context tag per worker record: weld CAT / paint process / assembly line
  function recordTag(r) {
    if (r.department === 'assembly') {
      return r.line_id != null ? (lineNames[r.line_id] ?? `Line ${r.line_id}`) : null
    }
    if (!r.sub_department) return null
    const cat = /^cat\s*(\d+)$/i.exec(r.sub_department)
    if (cat) return `CAT ${cat[1]}`
    return SUB_DEPT_LABEL[r.sub_department] ?? r.sub_department
  }

  const DEPT_OPTS = [
    { value: '', label: 'All Departments' },
    { value: 'weld',    label: 'Weld' },
    { value: 'kitting', label: 'Kitting' },
    { value: 'paint',   label: 'Paint' },
    { value: 'assembly', label: 'Assembly' },
  ]

  async function search() {
    setLoading(true); setError(''); setRecords(null)
    try {
      const fromISO = fromDate ? new Date(fromDate + 'T00:00:00').toISOString() : undefined
      const toISO   = toDate   ? new Date(toDate   + 'T23:59:59').toISOString() : undefined
      const data = await loadJobHistory({ fromDate: fromISO, toDate: toISO, department: dept || undefined })
      setAllRecords(data)
      // Individual view only keeps records that have a COMPLETE event
      const completed = data.filter(r => r.events.some(e => e.event_type === 'COMPLETE'))
      completed.sort((a, b) => {
        const aEnd = Math.max(...a.events.map(e => new Date(e.event_timestamp)))
        const bEnd = Math.max(...b.events.map(e => new Date(e.event_timestamp)))
        return bEnd - aEnd
      })
      setRecords(completed)
    } catch { setError('Failed to load history — check connection.') }
    finally { setLoading(false) }
  }

  useEffect(() => { search() }, [])

  const DEPT_COLOUR = { weld: 'text-blue-400', kitting: 'text-orange-400', paint: 'text-red-400', assembly: 'text-emerald-400' }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-5 space-y-4">
      {/* Filters */}
      <div className="bg-stone-900 rounded-2xl border border-stone-700 p-4 space-y-3">
        <p className="text-xs text-stone-500 uppercase tracking-widest">Filter</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-stone-600 block mb-1">From</label>
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
              className="w-full bg-stone-800 border border-stone-600 focus:border-amber-500 rounded-xl px-3 py-2.5 text-stone-100 text-sm outline-none" />
          </div>
          <div>
            <label className="text-xs text-stone-600 block mb-1">To</label>
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
              className="w-full bg-stone-800 border border-stone-600 focus:border-amber-500 rounded-xl px-3 py-2.5 text-stone-100 text-sm outline-none" />
          </div>
        </div>
        <div>
          <label className="text-xs text-stone-600 block mb-1">Department</label>
          <select value={dept} onChange={e => setDept(e.target.value)}
            className="w-full bg-stone-800 border border-stone-600 focus:border-amber-500 rounded-xl px-3 py-2.5 text-stone-100 text-sm outline-none">
            {DEPT_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <button onClick={search} disabled={loading}
          className="w-full bg-amber-600/30 border border-amber-600 text-amber-300 py-3 rounded-xl text-sm font-semibold hover:bg-amber-600/50 transition-colors disabled:opacity-40">
          {loading ? 'Searching…' : 'Search'}
        </button>
      </div>

      {error && <p className="text-red-400 text-sm bg-red-900/20 rounded-xl px-4 py-3">{error}</p>}

      {/* View mode toggle */}
      <div className="flex rounded-xl overflow-hidden border border-stone-700">
        {[['individual', 'By Worker'], ['by_job', 'By Job']].map(([m, label]) => (
          <button key={m} onClick={() => setMode(m)}
            className={`flex-1 py-2.5 text-sm font-semibold transition-colors ${
              mode === m ? 'bg-amber-600/30 text-amber-300' : 'bg-stone-900 text-stone-500'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {mode === 'by_job' && allRecords !== null && (() => {
        const DEPT_ORDER = ['kitting', 'weld', 'paint', 'assembly']
        const groups = new Map()
        for (const r of allRecords) {
          const key = `${r.po_number}|${r.part_number}`
          if (!groups.has(key)) groups.set(key, {
            key, po: r.po_number, part: r.part_number,
            depts: new Map(), latest: 0, total: 0, allComplete: true
          })
          const g  = groups.get(key)
          const ms = calcElapsed(r.events, breakRules)
          const d  = g.depts.get(r.department) ?? { total: 0, workers: [] }
          d.total += ms
          d.workers.push({ record: r, ms })
          g.depts.set(r.department, d)
          g.total += ms
          g.latest = Math.max(g.latest, ...r.events.map(e => +new Date(e.event_timestamp)))
          if (!r.events.some(e => e.event_type === 'COMPLETE')) g.allComplete = false
        }
        const jobGroups = [...groups.values()].sort((a, b) => b.latest - a.latest)

        return (
          <>
            <p className="text-xs text-stone-600 px-1">{jobGroups.length} job{jobGroups.length !== 1 ? 's' : ''} · totals include work still in progress</p>
            {jobGroups.length === 0 && (
              <div className="text-center py-16 text-stone-600">
                <p className="text-4xl mb-4">📋</p>
                <p>No jobs in this range</p>
              </div>
            )}
            <div className="space-y-2">
              {jobGroups.map(g => {
                const open = expanded === g.key
                const deptEntries = DEPT_ORDER.filter(d => g.depts.has(d))
                  .concat([...g.depts.keys()].filter(d => !DEPT_ORDER.includes(d)))
                return (
                  <div key={g.key} className="bg-stone-900 border border-stone-700 rounded-2xl overflow-hidden">
                    <div className="px-4 py-4 cursor-pointer hover:bg-stone-800/50 transition-colors"
                      onClick={() => setExpanded(open ? null : g.key)}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <p className="text-stone-100 font-semibold truncate">PO {g.po}</p>
                            <span className={`text-xs ${g.allComplete ? 'text-emerald-500' : 'text-amber-500'}`}>
                              {g.allComplete ? '✓ complete' : '● in progress'}
                            </span>
                          </div>
                          <p className="text-stone-500 text-xs mb-2">Part: {g.part}</p>
                          {/* Dept chips: stacked on phones/scanners, one row on desktop */}
                          <div className="flex flex-col items-start gap-1.5 sm:flex-row sm:flex-wrap">
                            {deptEntries.map(d => (
                              <span key={d} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-stone-800 border border-stone-700 text-xs">
                                <span className={`font-bold uppercase ${DEPT_COLOUR[d] ?? 'text-stone-400'}`}>{d}</span>
                                <span className="font-mono text-stone-300 tabular-nums">{formatDuration(g.depts.get(d).total)}</span>
                              </span>
                            ))}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="font-mono font-bold text-xl text-stone-200 tabular-nums">{formatDuration(g.total)}</p>
                          <p className="text-stone-600 text-xs mt-1">{open ? '▲ hide detail' : '▼ detail'}</p>
                        </div>
                      </div>
                    </div>
                    {open && (
                      <div className="border-t border-stone-700 px-4 py-3 space-y-3 bg-stone-950/40">
                        {deptEntries.map(d => {
                          const workers = g.depts.get(d).workers
                            .sort((a, b) => {
                              if (d === 'paint') {
                                // Process flow order: blast → prep → paint → pack
                                const ORD = { blast: 0, prep: 1, paint: 2, pack: 3 }
                                const ao = ORD[a.record.sub_department] ?? 9
                                const bo = ORD[b.record.sub_department] ?? 9
                                if (ao !== bo) return ao - bo
                              }
                              return b.ms - a.ms
                            })
                          return (
                          <div key={d}>
                            <p className={`text-xs font-bold uppercase mb-1 ${DEPT_COLOUR[d] ?? 'text-stone-400'}`}>{d}</p>
                            {workers.map(({ record, ms }, i) => {
                              // Subtle divider when the paint process changes
                              const proc = record.sub_department
                              const newProc = d === 'paint' && proc &&
                                (i === 0 || workers[i - 1].record.sub_department !== proc)
                              return (
                              <div key={`${record.job_id}_${record.employee_id}`}>
                                {newProc && (
                                  <p className={`text-[10px] uppercase tracking-widest text-stone-600 ${i > 0 ? 'mt-2 pt-1.5 border-t border-stone-800' : ''}`}>
                                    {SUB_DEPT_LABEL[proc] ?? proc}
                                  </p>
                                )}
                                <div className="flex items-center justify-between py-1">
                                <span className="text-sm text-stone-300 truncate">
                                  {record.full_name}
                                  {d !== 'paint' && recordTag(record) && (
                                    <span className="text-stone-500 text-xs ml-2">{recordTag(record)}</span>
                                  )}
                                  {!record.events.some(e => e.event_type === 'COMPLETE') && (
                                    <span className="text-amber-500 text-xs ml-2">● active</span>
                                  )}
                                </span>
                                <span className="flex items-center gap-3 shrink-0">
                                  <span className="font-mono text-sm text-stone-400 tabular-nums">{formatDuration(ms)}</span>
                                  <button onClick={e => { e.stopPropagation(); setEditing(record) }}
                                    className="text-xs text-amber-500 underline hover:text-amber-300">Edit</button>
                                </span>
                                </div>
                              </div>
                            )})}
                          </div>
                        )})}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )
      })()}

      {mode === 'individual' && records !== null && (
        <>
          <p className="text-xs text-stone-600 px-1">{records.length} completed job{records.length !== 1 ? 's' : ''}</p>
          {records.length === 0 && (
            <div className="text-center py-16 text-stone-600">
              <p className="text-4xl mb-4">📋</p>
              <p>No completed jobs in this range</p>
            </div>
          )}
          <div className="space-y-2">
            {records.map(r => {
              const elapsed = calcElapsed(r.events, breakRules)
              const completeEv = r.events.slice().reverse().find(e => e.event_type === 'COMPLETE')
              const completedAt = completeEv ? new Date(completeEv.event_timestamp) : null
              return (
                <div key={`${r.job_id}_${r.employee_id}`}
                  className="bg-stone-900 border border-stone-700 rounded-2xl px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-xs font-bold uppercase ${DEPT_COLOUR[r.department] ?? 'text-stone-400'}`}>
                          {r.department}{r.sub_department ? ` · ${r.sub_department}` : ''}
                        </span>
                      </div>
                      <p className="text-stone-100 font-semibold truncate">PO {r.po_number}</p>
                      <p className="text-stone-500 text-xs">Part: {r.part_number}</p>
                      <p className="text-stone-500 text-xs mt-0.5">{r.full_name}</p>
                      {completedAt && (
                        <p className="text-stone-600 text-xs mt-1">
                          Completed {completedAt.toLocaleDateString()} {completedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </p>
                      )}
                    </div>
                    <div className="shrink-0 text-right flex flex-col items-end gap-2">
                      <p className="font-mono font-bold text-xl text-stone-300 tabular-nums">{formatDuration(elapsed)}</p>
                      <button
                        onClick={() => setEditing(r)}
                        className="text-xs text-amber-500 underline hover:text-amber-300">
                        Edit timestamps
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {editing && (
        <EditTimestampsModal
          record={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { search() }}
        />
      )}
    </div>
  )
}

// ── Main report screen ────────────────────────────────────────────────────────
export default function ManagerReport({ onBack }) {
  const [tab, setTab]               = useState('live')   // 'live' | 'history'
  const [report, setReport]         = useState(null)
  const [lines, setLines]           = useState([])
  const [breakRules, setBreakRules] = useState([])
  const [loading, setLoading]       = useState(true)
  const [lastRefresh, setLastRefresh] = useState(null)
  const [error, setError]           = useState('')
  const [actionModal, setActionModal] = useState(null)
  const [showAddJob, setShowAddJob]   = useState(false)
  const timerRef = useRef(null)

  const lastCountRef = useRef(null)   // job_events row count at last full load
  const lastFullRef  = useRef(0)      // when the last full load happened

  async function refresh(force = false) {
    setError('')
    try {
      // Cheap probe first: only download the full picture when something
      // actually changed, or once a minute as a safety heartbeat
      const count = await fetchJobEventsCount()
      const changed   = count !== lastCountRef.current
      const heartbeat = Date.now() - lastFullRef.current >= FULL_REFRESH_MS
      if (!force && !changed && !heartbeat) {
        setLastRefresh(new Date())    // confirmed up to date — probe only
        return
      }
      const [data, rules, lineList] = await Promise.all([
        loadManagerReport(),
        fetchBreakRules(),
        fetchAssemblyLines()
      ])
      lastCountRef.current = count
      lastFullRef.current  = Date.now()
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
    refresh(true)
    timerRef.current = setInterval(() => {
      if (document.hidden) return   // tab in background — don't poll
      refresh()
    }, REFRESH_MS)
    return () => clearInterval(timerRef.current)
  }, [])

  const lineMap = Object.fromEntries(lines.map(l => [l.line_id, l.line_name]))

  // Count active workers across all individual depts
  const activeCount = report
    ? Object.values(report.individual).flat().filter(({ jobs }) => jobs.some(j => j.isActive)).length
    : 0

  const staleSessions = useMemo(() => findStaleSessions(report), [report])

  return (
    <div className="flex flex-col min-h-screen bg-stone-950">

      {/* Header */}
      <div className="bg-stone-900 border-b border-stone-700 px-5 py-4 flex items-center justify-between shrink-0 gap-3">
        <div className="min-w-0">
          <p className="text-xs text-stone-500 uppercase tracking-widest">Manager View</p>
          <p className="text-xl font-bold text-stone-100">SFM Job Tracker</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {tab === 'live' && lastRefresh && (
            <p className="text-xs text-stone-600 hidden sm:block">
              Updated {lastRefresh.toLocaleTimeString()}
            </p>
          )}
          {tab === 'live' && (
            <button
              className="bg-emerald-800/40 border border-emerald-700 text-emerald-300 px-4 py-2.5 rounded-xl text-sm"
              onClick={() => setShowAddJob(true)}
            >
              + Add Job
            </button>
          )}
          <button className="btn-danger px-4 py-2.5 text-sm" onClick={onBack}>
            ← Back
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="bg-stone-900 border-b border-stone-700 flex shrink-0">
        {[['live', 'Live Overview'], ['queue', 'Weekly Plan'], ['plan', 'Plan'], ['history', 'History']].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`flex-1 py-3 text-sm font-semibold transition-colors flex items-center justify-center gap-1.5 ${
              tab === key
                ? 'text-amber-400 border-b-2 border-amber-400'
                : 'text-stone-500 hover:text-stone-300'
            }`}>
            {label}
            {key === 'live' && staleSessions.length > 0 && (
              <span className="bg-red-600 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center leading-none">
                {staleSessions.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Weekly Plan tab (manager view of the same worker queue) */}
      {tab === 'queue' && <ManagerWeeklyPlan />}

      {/* Plan tab */}
      {tab === 'plan' && <PlanDashboard />}

      {/* History tab */}
      {tab === 'history' && <HistoryView breakRules={breakRules} />}

      {/* Live tab content */}
      {tab === 'live' && <div className="flex-1 overflow-y-auto px-4 py-5 space-y-5">

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
            {/* ── Stale sessions — active jobs left open past a normal shift ── */}
            {staleSessions.length > 0 && (
              <div className="bg-red-950/30 rounded-2xl border border-red-800 overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-red-800/60">
                  <span className="text-red-400">⚠</span>
                  <h2 className="text-sm font-bold uppercase tracking-widest text-red-300">Stale Sessions</h2>
                  <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-red-600/30 text-red-300">
                    {staleSessions.length}
                  </span>
                  <span className="text-xs text-red-400/70 ml-auto hidden sm:block">
                    Active {STALE_HOURS}h+ without a pause — likely a missed clock-off
                  </span>
                </div>
                {staleSessions.map((s, i) => (
                  <button key={i}
                    onClick={() => setActionModal(
                      s.kind === 'worker'
                        ? { type: 'worker', emp: s.emp, job: s.job }
                        : { type: 'assembly', job: s.job, lineId: s.lineId, lineName: lineMap[s.lineId] ?? `Line ${s.lineId}`, members: s.members, isActive: s.isActive, holdReason: s.holdReason }
                    )}
                    className="w-full flex items-center gap-3 px-4 py-3 border-t border-red-900/40 hover:bg-red-900/20 transition-colors text-left"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-stone-100 font-semibold truncate">
                        {s.kind === 'worker' ? s.emp.full_name : s.memberName}
                      </p>
                      <p className="text-stone-400 text-sm truncate">
                        PO {s.job.po_number} &nbsp;·&nbsp; {s.job.part_number}
                      </p>
                    </div>
                    <span className="text-red-300 font-mono font-bold text-lg tabular-nums shrink-0">
                      {Math.floor(s.hours)}h
                    </span>
                    <span className="text-stone-600 text-xs shrink-0">›</span>
                  </button>
                ))}
              </div>
            )}

            {/* ── Kitting ──────────────────────────────────────────────── */}
            {(() => {
              const workers = report.individual.kitting ?? []
              const active  = workers.filter(w => w.jobs.some(j => j.isActive)).length
              return (
                <Section
                  title="Kitting"
                  accent="border-t-orange-400"
                  badge={active > 0 ? `${active} active` : 'none active'}
                  badgeColour={active > 0 ? 'bg-orange-500/20 text-orange-400' : 'bg-stone-700 text-stone-500'}
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

              // Group by tier — sub_department like "1 WELD/FAB", "2 WELD/FAB", "3 WELD/FAB"
              const tierKey = sub => ['cat1','cat2','cat3'].includes(sub) ? sub : 'none'
              const TIER_LABEL = { cat1: 'CAT 1', cat2: 'CAT 2', cat3: 'CAT 3', none: 'Unassigned' }
              const grouped = ['cat1','cat2','cat3','none'].map(key => ({
                key,
                label: TIER_LABEL[key],
                workers: workers.filter(w => tierKey(w.emp.sub_department ?? '') === key)
                  .sort((a, b) => {
                    const aA = a.jobs.some(j => j.isActive) ? 0 : 1
                    const bA = b.jobs.some(j => j.isActive) ? 0 : 1
                    return aA - bA
                  })
              })).filter(g => g.workers.length > 0)

              return (
                <div className="bg-stone-900 rounded-2xl border border-stone-700 border-t-2 border-t-blue-500 overflow-hidden">
                  <div className="flex items-center gap-3 px-4 py-3 border-b border-stone-700">
                    <h2 className="text-sm font-bold uppercase tracking-widest text-stone-200">Weld Shop</h2>
                    <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${
                      active > 0 ? 'bg-blue-500/20 text-blue-400' : 'bg-stone-700 text-stone-500'
                    }`}>
                      {active > 0 ? `${active} active` : 'none active'}
                    </span>
                  </div>
                  {workers.length === 0 ? (
                    <p className="text-stone-600 text-sm px-4 py-5 text-center">No active jobs</p>
                  ) : (
                    <div>
                      {grouped.map(({ key, label, workers: grpWorkers }) => {
                        const grpActive = grpWorkers.filter(w => w.jobs.some(j => j.isActive)).length
                        return (
                          <div key={key} className="border-t border-stone-700/60">
                            <div className="flex items-center gap-2.5 px-4 py-2 bg-blue-950/40">
                              <span className="text-xs font-bold text-blue-300 uppercase tracking-widest">{label}</span>
                              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                                grpActive > 0 ? 'bg-blue-500/20 text-blue-400' : 'bg-stone-700/60 text-stone-500'
                              }`}>
                                {grpActive > 0 ? `${grpActive} active` : 'paused'}
                              </span>
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
                <div className="bg-stone-900 rounded-2xl border border-stone-700 border-t-2 border-t-red-500 overflow-hidden">
                  <div className="flex items-center gap-3 px-4 py-3 border-b border-stone-700">
                    <h2 className="text-sm font-bold uppercase tracking-widest text-stone-200">Paint Shop</h2>
                    <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${
                      active > 0 ? 'bg-red-500/20 text-red-400' : 'bg-stone-700 text-stone-500'
                    }`}>
                      {active > 0 ? `${active} active` : 'none active'}
                    </span>
                  </div>
                  {workers.length === 0 ? (
                    <p className="text-stone-600 text-sm px-4 py-5 text-center">No active jobs</p>
                  ) : (
                    <div>
                      {grouped.map(({ sub, label, workers: grpWorkers }) => {
                        const grpActive = grpWorkers.filter(w => w.jobs.some(j => j.isActive)).length
                        return (
                          <div key={sub} className="border-t border-stone-700/60">
                            <div className="flex items-center gap-2.5 px-4 py-2 bg-red-950/30">
                              <span className="text-xs font-bold text-red-300 uppercase tracking-widest">{label}</span>
                              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                                grpActive > 0 ? 'bg-red-500/20 text-red-400' : 'bg-stone-700/60 text-stone-500'
                              }`}>
                                {grpActive > 0 ? `${grpActive} active` : 'paused'}
                              </span>
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
              const asmLines = Object.entries(report.assembly).sort(([a], [b]) => {
                if (a === 'unassigned') return 1
                if (b === 'unassigned') return -1
                return Number(a) - Number(b)
              })
              const totalActive = asmLines.reduce((sum, [, jobs]) => sum + jobs.filter(j => j.isActive).length, 0)
              return (
                <div className="bg-stone-900 rounded-2xl border border-stone-700 border-t-2 border-t-emerald-500 overflow-hidden">
                  <div className="flex items-center gap-3 px-4 py-3 border-b border-stone-700">
                    <h2 className="text-sm font-bold uppercase tracking-widest text-stone-200">Assembly</h2>
                    <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${
                      totalActive > 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-stone-700 text-stone-500'
                    }`}>
                      {totalActive > 0 ? `${totalActive} active` : 'none active'}
                    </span>
                  </div>
                  {asmLines.length === 0 ? (
                    <p className="text-stone-600 text-sm px-4 py-5 text-center">No active jobs</p>
                  ) : (
                    <div>
                      {asmLines.map(([lineId, jobs]) => {
                        const activeJobs = jobs.filter(j => j.isActive).length
                        const onHoldJobs = jobs.filter(j => !j.isActive && !!j.holdReason).length
                        return (
                          <div key={lineId} className="border-t border-stone-700/60">
                            <div className="flex items-center gap-2.5 px-4 py-2 bg-emerald-950/40">
                              <span className="text-xs font-bold text-emerald-300 uppercase tracking-widest">
                                  {lineId === 'unassigned'
                                  ? 'No Line'
                                  : lineMap[lineId] ?? `Line ${lineId}`}
                              </span>
                              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                                activeJobs > 0 ? 'bg-emerald-500/20 text-emerald-400'
                                : onHoldJobs > 0 ? 'bg-red-900/40 text-red-400'
                                : 'bg-orange-900/40 text-orange-400'
                              }`}>
                                {activeJobs > 0 ? `${activeJobs} active`
                                : onHoldJobs > 0 ? 'on hold'
                                : 'paused'}
                              </span>
                            </div>
                            {jobs.map((entry, i) => (
                              <AssemblyJobRow key={i} entry={entry} breakRules={breakRules}
                                lineId={entry.lineId ?? null}
                                lineName={entry.lineId != null ? (lineMap[entry.lineId] ?? `Line ${entry.lineId}`) : 'No Line'}
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
      </div>}

      {actionModal && (
        <ManagerActionModal
          action={actionModal}
          onClose={() => setActionModal(null)}
          onDone={() => { setActionModal(null); refresh(true) }}
        />
      )}

      {showAddJob && (
        <AddJobModal
          onClose={() => setShowAddJob(false)}
          onDone={() => { setShowAddJob(false); refresh(true) }}
        />
      )}
    </div>
  )
}
