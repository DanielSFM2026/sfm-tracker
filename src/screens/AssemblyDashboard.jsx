import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchAssemblyLines,
  loadLineJobs,
  findOrCreateJob,
  findTeamMember,
  addTeamMemberToJob,
  removeTeamMemberFromJob,
  removeTeamMemberPermanently,
  logAssemblyTeamEvent,
  getManagerLineSplitCount,
  prepareManagerLineStart,
  onManagerLineEnd,
  fetchBreakRules
} from '../lib/db'
import { isJobActive, calcElapsed, formatDuration } from '../lib/timeCalc'
import { HOLD_REASONS, HOLD_REASON_LABEL } from '../lib/constants'

const INACTIVITY_MS = 120_000

// ── Hold reason modal ─────────────────────────────────────────────────────────
function HoldModal({ onSelect, onCancel }) {
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl p-8 w-full max-w-sm">
        <h2 className="text-2xl font-bold text-stone-100 mb-6 text-center">Hold Reason</h2>
        <div className="flex flex-col gap-3">
          {HOLD_REASONS.map(r => (
            <button key={r.key} className="btn-secondary text-base py-4" onClick={() => onSelect(r.key)}>
              {r.label}
            </button>
          ))}
          <button className="btn-ghost mt-2" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ── Confirm complete modal ────────────────────────────────────────────────────
function ConfirmCompleteModal({ job, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl p-8 w-full max-w-sm">
        <h2 className="text-2xl font-bold text-stone-100 mb-2 text-center">Mark Complete?</h2>
        <p className="text-stone-400 text-center mb-1">
          PO: <strong className="text-stone-200">{job.po_number}</strong>
        </p>
        <p className="text-stone-400 text-center mb-6">
          Part: <strong className="text-stone-200">{job.part_number}</strong>
        </p>
        <div className="flex gap-4">
          <button className="btn-ghost flex-1" onClick={onCancel}>Back</button>
          <button className="btn-green flex-1" onClick={onConfirm}>Complete ✓</button>
        </div>
      </div>
    </div>
  )
}

// ── Team edit modal ───────────────────────────────────────────────────────────
// Scan behaviour:
//   New badge      → add to job (START)
//   Active member  → clock them off for now (PAUSE)
//   Clocked-off    → clock them back on (START)
// ✕ button = permanent remove (COMPLETE for that person, they leave the team entirely)

function TeamEditModal({ job, lineId, managerId, onAdd, onClockOff, onRemovePermanently, onClose }) {
  const inputRef  = useRef(null)
  const bufferRef = useRef('')
  const [scanning, setScanning] = useState(false)
  const [error, setError]       = useState('')

  // Members who haven't been permanently removed (last event ≠ COMPLETE)
  const visibleTeam = (job.team ?? []).filter(m => {
    const last = m.events?.[m.events.length - 1]
    return last?.event_type !== 'COMPLETE'
  })
  const activeMembers    = visibleTeam.filter(m => isJobActive(m.events))
  const clockedOffMembers = visibleTeam.filter(m => !isJobActive(m.events))

  useEffect(() => {
    if (inputRef.current) inputRef.current.focus()
  }, [])

  async function handleScan(badgeCode) {
    setError('')
    if (!badgeCode) return
    setScanning(true)
    try {
      const member = await findTeamMember(badgeCode)
      if (!member) { setError(`Badge not recognised: ${badgeCode}`); return }
      if (member.employee_id === managerId) { setError("That's your own badge."); return }

      // Check if already on this job
      const existing = job.team?.find(m => m.employee_id === member.employee_id)
      const lastEv   = existing?.events?.[existing.events.length - 1]

      if (existing && lastEv?.event_type === 'COMPLETE') {
        setError(`${member.full_name} has been permanently removed from this job.`)
        return
      }

      if (existing && isJobActive(existing.events)) {
        // Currently on shift → clock them off
        const pauseEv = await removeTeamMemberFromJob(member.employee_id, job.job_id, lineId)
        onClockOff(job.job_id, member.employee_id, pauseEv)
        return
      }

      if (existing) {
        // Clocked off → clock them back on
        const startEv = await addTeamMemberToJob(member.employee_id, job.job_id, lineId)
        onClockOff(job.job_id, member.employee_id, startEv) // reuses same updater (adds event)
        return
      }

      // New member → add to job
      const startEv = await addTeamMemberToJob(member.employee_id, job.job_id, lineId)
      onAdd(job.job_id, {
        employee_id: member.employee_id,
        full_name:   member.full_name,
        badge_code:  member.badge_code,
        events:      [startEv]
      })
    } catch (err) {
      console.error(err)
      setError('Could not look up badge — check connection.')
    } finally {
      setScanning(false)
      if (inputRef.current) { inputRef.current.value = ''; inputRef.current.focus() }
      bufferRef.current = ''
    }
  }

  async function handleRemovePermanently(member) {
    try {
      const ev = await removeTeamMemberPermanently(member.employee_id, job.job_id, lineId)
      onRemovePermanently(job.job_id, member.employee_id, ev)
    } catch (err) {
      console.error(err)
      setError('Remove failed — check connection.')
    }
  }

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl p-8 w-full max-w-sm">
        <div className="flex items-center justify-between mb-5">
          <div>
            <p className="text-xs text-stone-500 uppercase tracking-widest">Team — PO {job.po_number}</p>
            <p className="text-sm text-stone-400">{job.part_number}</p>
          </div>
          <button className="btn-ghost px-4 py-2" onClick={onClose}>Done</button>
        </div>

        {/* Currently on shift */}
        {activeMembers.length > 0 && (
          <div className="mb-3">
            <p className="text-xs text-stone-500 uppercase tracking-widest mb-2">On shift</p>
            <div className="flex flex-wrap gap-2">
              {activeMembers.map(m => (
                <span
                  key={m.employee_id}
                  className="flex items-center gap-2 bg-stone-700 rounded-full px-3 py-1.5 text-sm text-stone-200"
                >
                  {m.full_name}
                  <button
                    className="text-stone-500 hover:text-red-400 leading-none text-base"
                    title="Permanently remove from job"
                    onClick={() => handleRemovePermanently(m)}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Clocked off */}
        {clockedOffMembers.length > 0 && (
          <div className="mb-4">
            <p className="text-xs text-stone-500 uppercase tracking-widest mb-2">Clocked off</p>
            <div className="flex flex-wrap gap-2">
              {clockedOffMembers.map(m => (
                <span
                  key={m.employee_id}
                  className="flex items-center gap-2 bg-stone-800 border border-stone-700 rounded-full px-3 py-1.5 text-sm text-stone-500"
                >
                  {m.full_name}
                  <button
                    className="text-stone-600 hover:text-red-500 leading-none text-base"
                    title="Permanently remove from job"
                    onClick={() => handleRemovePermanently(m)}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
            <p className="text-xs text-stone-600 mt-2">Scan their badge to clock back on</p>
          </div>
        )}

        {visibleTeam.length === 0 && (
          <p className="text-stone-600 text-sm mb-4">No team members on this job yet.</p>
        )}

        <p className="text-xs text-stone-500 uppercase tracking-widest mb-2">Scan badge</p>
        <div className="relative">
          <input
            ref={inputRef}
            type="text"
            className="w-full bg-stone-900 border-2 border-stone-600 focus:border-sky-500
                       rounded-xl px-4 py-3 text-stone-100 text-lg outline-none
                       transition-colors placeholder-stone-600"
            placeholder={scanning ? 'Looking up…' : '▌ Add · Clock on/off'}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            readOnly={scanning}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const val = bufferRef.current.trim()
                bufferRef.current = ''
                if (e.target) e.target.value = ''
                if (val) handleScan(val)
              }
            }}
            onInput={e => { bufferRef.current = e.target.value }}
          />
        </div>
        {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
      </div>
    </div>
  )
}

// ── Assembly job card ─────────────────────────────────────────────────────────
// Timer shows TOTAL TEAM TIME: manager's credited share + every team member's time.
// Manager's share is already split by the number of active lines (split_count in events).
// Team members always have split_count=1 (they're only ever on one job at a time).
// Rate example: manager on 2 lines + 2 team members → 0.5 + 1 + 1 = 2.5 s/s per job.

function AssemblyJobCard({ job, managerName, breakRules, onPause, onHold, onResume, onComplete, onEditTeam }) {
  const active     = isJobActive(job.events)
  const lastPause  = [...job.events].reverse().find(e => e.event_type === 'PAUSE')
  const isOnHold   = !active && !!lastPause?.hold_reason
  const holdReason = isOnHold ? lastPause.hold_reason : null

  // Members who haven't been permanently removed (last event ≠ COMPLETE)
  const visibleTeam   = (job.team ?? []).filter(m => {
    const last = m.events?.[m.events.length - 1]
    return last?.event_type !== 'COMPLETE'
  })
  const activeTeam    = visibleTeam.filter(m => isJobActive(m.events))
  const clockedOffTeam = visibleTeam.filter(m => !isJobActive(m.events))

  const anyActive = active || visibleTeam.some(m => isJobActive(m.events))

  function computeTotal() {
    const managerMs = calcElapsed(job.events, breakRules)
    const teamMs    = visibleTeam.reduce((sum, m) => sum + calcElapsed(m.events, breakRules), 0)
    return managerMs + teamMs
  }

  const [elapsed, setElapsed] = useState(computeTotal)

  useEffect(() => {
    setElapsed(computeTotal())
    if (!anyActive) return
    const id = setInterval(() => setElapsed(computeTotal()), 1000)
    return () => clearInterval(id)
  }, [anyActive, job.events, job.team, breakRules])

  // Status badge label + colour
  const statusLabel = active ? 'On Line' : isOnHold ? 'On Hold' : 'Paused'
  const statusCls   = active
    ? 'bg-amber-500/20 text-amber-400'
    : isOnHold
      ? 'bg-orange-900/40 text-orange-400'
      : 'bg-stone-700 text-stone-400'

  return (
    <div className={`rounded-2xl border-2 transition-colors overflow-hidden ${
      active ? 'bg-stone-800 border-amber-500' : 'border-stone-700'
    }`} style={active ? {} : { backgroundColor: '#1e1b18' }}>

      <div className="p-5 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs text-stone-500 uppercase tracking-widest">PO</p>
            <p className="text-xl font-bold text-stone-100">{job.po_number}</p>
            <p className="text-sm text-stone-400">Part: {job.part_number}</p>
            {job.quantity != null && (
              <p className="text-sm text-stone-500">Qty: {job.quantity}</p>
            )}
          </div>
          <div className="text-right shrink-0">
            <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold uppercase mb-2 ${statusCls}`}>
              {statusLabel}
            </span>
            <p className={`text-2xl font-mono font-bold ${active ? 'text-amber-400' : 'text-stone-400'}`}>
              {formatDuration(elapsed)}
            </p>
            {active && activeTeam.length > 0 && (
              <p className="text-xs text-sky-400 mt-0.5">{activeTeam.length + 1} on shift</p>
            )}
            {holdReason && (
              <p className="text-xs text-orange-400 mt-1 max-w-[140px] text-right leading-tight">
                {HOLD_REASON_LABEL[holdReason] ?? holdReason}
              </p>
            )}
          </div>
        </div>

        {/* LM chip + Team strip */}
        <div className="mt-3 space-y-2">
          {/* Line manager row */}
          <div className="flex items-center gap-2">
            <span className="text-xs bg-amber-500/15 border border-amber-500/30 text-amber-400
                             rounded-full px-2.5 py-1 flex items-center gap-1.5">
              <span className="font-semibold tracking-wide">LM</span>
              <span>{managerName}</span>
            </span>
          </div>
          {/* Team row — bright = on shift, dim = clocked off */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => onEditTeam(job.job_id)}
              className="text-xs text-stone-500 hover:text-sky-400 border border-stone-700
                         hover:border-sky-600 rounded-full px-2.5 py-1 transition-colors"
            >
              ✏ Team
            </button>
            {visibleTeam.length === 0 ? (
              <span className="text-xs text-stone-600">No members assigned</span>
            ) : (
              visibleTeam.map(m => {
                const on = isJobActive(m.events)
                return (
                  <span
                    key={m.employee_id}
                    className={`text-xs rounded-full px-2.5 py-1 ${
                      on
                        ? 'bg-stone-700 text-stone-300'
                        : 'bg-stone-800 border border-stone-700 text-stone-600'
                    }`}
                    title={on ? 'On shift' : 'Clocked off'}
                  >
                    {m.full_name}
                  </span>
                )
              })
            )}
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="px-5 pb-5 space-y-2">
        {active ? (
          <div className="flex gap-2">
            <button className="btn-secondary flex-1 text-base py-3" onClick={() => onPause(job.job_id)}>
              ⏸ Pause
            </button>
            <button
              className="flex-1 text-base py-3 btn rounded-xl border border-orange-700 bg-orange-950/40 text-orange-400"
              onClick={() => onHold(job.job_id)}
            >
              ⚠ Hold
            </button>
          </div>
        ) : (
          <button className="btn-primary w-full text-base py-3" onClick={() => onResume(job.job_id)}>
            ▶ Resume
          </button>
        )}
        <button className="btn-green w-full text-base py-3" onClick={() => onComplete(job.job_id)}>
          ✓ Complete
        </button>
      </div>
    </div>
  )
}

// ── Line selector view ────────────────────────────────────────────────────────
function LineSelectorView({ lines, managerName, onSelect, onLogout }) {
  return (
    <div className="flex flex-col min-h-screen">
      <div className="bg-stone-900 border-b border-stone-700 px-5 py-4 flex items-center justify-between shrink-0">
        <div>
          <p className="text-xs text-stone-500 uppercase tracking-widest">Assembly</p>
          <p className="text-xl font-bold text-stone-100">{managerName}</p>
        </div>
        <button className="btn-danger px-5 py-3 text-base" onClick={onLogout}>Done →</button>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center px-6 gap-8">
        <p className="text-stone-400 text-lg">Select your line</p>
        <div className="grid grid-cols-3 gap-4 w-full max-w-sm">
          {lines.map(line => (
            <button
              key={line.line_id}
              onClick={() => onSelect(line)}
              className="bg-stone-800 hover:bg-stone-700 active:bg-amber-500/20 border-2 border-stone-600
                         hover:border-amber-500 rounded-2xl py-8 text-xl font-bold text-stone-100
                         transition-colors"
            >
              {line.line_name}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Main Assembly dashboard ───────────────────────────────────────────────────
export default function AssemblyDashboard({ employee, breakRules: appBreakRules, onLogout }) {
  const [lines, setLines]           = useState([])
  const [selectedLine, setLine]     = useState(null)
  const [jobs, setJobs]             = useState([])
  const [modal, setModal]           = useState(null)
  const [error, setError]           = useState('')
  const [scanning, setScanning]     = useState(false)
  const [breakRules, setBreakRules] = useState(appBreakRules ?? [])

  const jobScanRef = useRef(null)
  const jobBufRef  = useRef('')
  const inactRef   = useRef(null)

  useEffect(() => {
    fetchAssemblyLines().then(setLines).catch(console.error)
    if (!appBreakRules?.length) {
      fetchBreakRules().then(setBreakRules).catch(console.error)
    }
  }, [])

  useEffect(() => {
    if (!selectedLine) return
    loadLineJobs(selectedLine.line_id, employee.employee_id)
      .then(setJobs)
      .catch(console.error)
  }, [selectedLine])

  const resetInactivity = useCallback(() => {
    if (inactRef.current) clearTimeout(inactRef.current)
    inactRef.current = setTimeout(onLogout, INACTIVITY_MS)
  }, [onLogout])

  useEffect(() => {
    resetInactivity()
    const evts = ['touchstart', 'mousedown', 'keydown']
    evts.forEach(e => window.addEventListener(e, resetInactivity, { passive: true }))
    return () => {
      if (inactRef.current) clearTimeout(inactRef.current)
      evts.forEach(e => window.removeEventListener(e, resetInactivity))
    }
  }, [resetInactivity])

  useEffect(() => {
    if (!modal && jobScanRef.current) jobScanRef.current.focus()
  }, [modal])

  // ── Local state helpers ────────────────────────────────────────────────────

  function appendJobEvent(jobId, ev) {
    setJobs(prev => prev.map(j =>
      j.job_id === jobId ? { ...j, events: [...j.events, ev] } : j
    ))
  }

  // Fire an event for the manager and optionally team members.
  //
  //   PAUSE (routine / end of shift)  → manager only; team members clock off individually
  //   PAUSE (hold reason present)     → manager + all active team (whole line stops)
  //   RESUME                          → manager only; team members rejoin via scan
  //   COMPLETE                        → manager + all active team (job fully done)
  //
  async function fireTeamEvent(jobId, eventType, holdReason = null, managerSplitCount = 1) {
    const job = jobs.find(j => j.job_id === jobId)

    const includeTeam = (eventType === 'PAUSE' && !!holdReason) || eventType === 'COMPLETE'
    const teamIds = includeTeam
      ? (job.team ?? []).filter(m => isJobActive(m.events)).map(m => m.employee_id)
      : []

    const managerEv = await logAssemblyTeamEvent(
      employee.employee_id, teamIds, jobId, eventType,
      selectedLine.line_id, holdReason, managerSplitCount
    )

    appendJobEvent(jobId, managerEv)

    if (teamIds.length > 0) {
      setJobs(prev => prev.map(j =>
        j.job_id !== jobId ? j : {
          ...j,
          team: (j.team ?? []).map(m =>
            teamIds.includes(m.employee_id)
              ? { ...m, events: [...(m.events ?? []), { event_type: eventType, event_timestamp: managerEv.event_timestamp }] }
              : m
          )
        }
      ))
    }
  }

  // ── Job scan ───────────────────────────────────────────────────────────────
  async function handleJobScan(raw) {
    const idx = raw.indexOf('/')
    if (idx < 1) {
      setError(`Could not parse: "${raw}". Expected PO/PART`)
      return
    }
    const poNumber   = raw.slice(0, idx).trim()
    const partNumber = raw.slice(idx + 1).trim()

    setScanning(true)
    setError('')
    try {
      const { job } = await findOrCreateJob(poNumber, partNumber)
      const existing = jobs.find(j => j.job_id === job.job_id)

      if (existing) {
        if (isJobActive(existing.events)) {
          setError(`PO ${poNumber} / ${partNumber} is already active on this line.`)
        } else {
          // Resuming an existing job — use current line split count
          const splitCount = await getManagerLineSplitCount(employee.employee_id)
          await fireTeamEvent(job.job_id, 'RESUME', null, splitCount)
        }
      } else {
        // New job on this line — update split for all other lines first
        const splitCount = await prepareManagerLineStart(employee.employee_id, selectedLine.line_id)
        const managerEv  = await logAssemblyTeamEvent(
          employee.employee_id, [], job.job_id, 'START',
          selectedLine.line_id, null, splitCount
        )
        setJobs(prev => [...prev, { ...job, events: [managerEv], team: [] }])
        setModal({ type: 'team', jobId: job.job_id })
      }
    } catch (err) {
      console.error(err)
      setError('Failed to look up job — check connection.')
    } finally {
      setScanning(false)
    }
  }

  // ── Card actions ───────────────────────────────────────────────────────────

  // Routine pause (end of shift, break) — no reason needed
  async function handlePause(jobId) {
    try {
      await fireTeamEvent(jobId, 'PAUSE', null, 1)
    } catch (err) {
      console.error(err)
      setError('Pause failed.')
    }
  }

  // Fault/quality hold — requires a reason
  function handleHold(jobId) {
    setModal({ type: 'hold', jobId })
  }

  async function handleHoldConfirm(reason) {
    const { jobId } = modal
    setModal(null)
    try {
      // PAUSE event — split_count doesn't matter for PAUSE
      await fireTeamEvent(jobId, 'PAUSE', reason, 1)
    } catch (err) {
      console.error(err)
      setError('Hold failed.')
    }
  }

  async function handleResume(jobId) {
    try {
      // Query current split count from DB (may have changed since this job was held)
      const splitCount = await getManagerLineSplitCount(employee.employee_id)
      await fireTeamEvent(jobId, 'RESUME', null, splitCount)
    } catch (err) {
      console.error(err)
      setError('Resume failed.')
    }
  }

  function handleComplete(jobId) {
    const job = jobs.find(j => j.job_id === jobId)
    setModal({ type: 'finish', jobId, job })
  }

  async function handleCompleteConfirm() {
    const { jobId } = modal
    setModal(null)
    try {
      await fireTeamEvent(jobId, 'COMPLETE', null, 1)
      setJobs(prev => prev.filter(j => j.job_id !== jobId))
      // Update remaining active lines' split_count after this job ends
      await onManagerLineEnd(employee.employee_id)
      // Reload this line's jobs from DB to reflect any split_count updates
      const fresh = await loadLineJobs(selectedLine.line_id, employee.employee_id)
      setJobs(fresh)
    } catch (err) {
      console.error(err)
      setError('Complete failed.')
    }
  }

  // ── Team edit ──────────────────────────────────────────────────────────────
  function handleEditTeam(jobId) {
    setModal({ type: 'team', jobId })
  }

  // New member added to job (never been on it before)
  function handleTeamAdd(jobId, member) {
    setJobs(prev => prev.map(j =>
      j.job_id === jobId ? { ...j, team: [...(j.team ?? []), member] } : j
    ))
  }

  // Clock on/off toggle: append the new event (PAUSE or START) to member's events
  function handleTeamClockToggle(jobId, employeeId, ev) {
    setJobs(prev => prev.map(j =>
      j.job_id !== jobId ? j : {
        ...j,
        team: (j.team ?? []).map(m =>
          m.employee_id === employeeId
            ? { ...m, events: [...(m.events ?? []), ev] }
            : m
        )
      }
    ))
  }

  // Permanent remove: append COMPLETE event to member's events (hides them from team strip)
  function handleTeamRemovePermanently(jobId, employeeId, ev) {
    setJobs(prev => prev.map(j =>
      j.job_id !== jobId ? j : {
        ...j,
        team: (j.team ?? []).map(m =>
          m.employee_id === employeeId
            ? { ...m, events: [...(m.events ?? []), ev] }
            : m
        )
      }
    ))
  }

  // ── Line not selected ──────────────────────────────────────────────────────
  if (!selectedLine) {
    return (
      <LineSelectorView
        lines={lines}
        managerName={employee.full_name}
        onSelect={line => setLine(line)}
        onLogout={onLogout}
      />
    )
  }

  const teamModalJob = modal?.type === 'team'
    ? jobs.find(j => j.job_id === modal.jobId)
    : null

  return (
    <div className="flex flex-col min-h-screen">

      {/* Header */}
      <div className="bg-stone-900 border-b border-stone-700 px-5 py-4 flex items-center justify-between shrink-0 gap-3">
        <div className="min-w-0">
          <p className="text-xs text-stone-500 uppercase tracking-widest">
            Assembly · {selectedLine.line_name}
          </p>
          <p className="text-xl font-bold text-stone-100 truncate">{employee.full_name}</p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            className="bg-stone-800 border border-stone-600 text-stone-400 px-4 py-3 rounded-xl text-sm"
            onClick={() => { setLine(null); setJobs([]) }}
          >
            ← Line
          </button>
          <button className="btn-danger px-5 py-3 text-base" onClick={onLogout}>
            Done →
          </button>
        </div>
      </div>

      {/* Job scan */}
      <div className="bg-stone-800 border-b border-stone-700 px-5 py-4 shrink-0">
        <p className="text-xs text-stone-500 uppercase tracking-widest mb-2">Scan job barcode</p>
        <div className="relative">
          <input
            ref={jobScanRef}
            type="text"
            className="w-full bg-stone-900 border-2 border-stone-600 focus:border-amber-500
                       rounded-xl px-4 py-3 text-stone-100 text-lg outline-none
                       transition-colors placeholder-stone-600"
            placeholder={scanning ? 'Looking up job…' : '▌ Ready to scan'}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const val = jobBufRef.current.trim()
                jobBufRef.current = ''
                if (e.target) e.target.value = ''
                if (val) handleJobScan(val)
              }
            }}
            onInput={e => { jobBufRef.current = e.target.value }}
            readOnly={scanning}
          />
          {scanning && (
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-amber-400 animate-pulse">…</span>
          )}
        </div>
        {error && (
          <p className="text-red-400 text-sm mt-2">
            {error}{' '}
            <button className="underline text-stone-500" onClick={() => setError('')}>✕</button>
          </p>
        )}
      </div>

      {/* Job cards */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {jobs.length === 0 ? (
          <div className="text-center py-16 text-stone-600">
            <p className="text-4xl mb-4">🏭</p>
            <p className="text-lg">No active jobs on {selectedLine.line_name}.</p>
            <p className="text-sm mt-1">Scan a job barcode above to begin.</p>
          </div>
        ) : (
          jobs.map(job => (
            <AssemblyJobCard
              key={job.job_id}
              job={job}
              managerName={employee.full_name}
              breakRules={breakRules}
              onPause={handlePause}
              onHold={handleHold}
              onResume={handleResume}
              onComplete={handleComplete}
              onEditTeam={handleEditTeam}
            />
          ))
        )}
      </div>

      {/* Modals */}
      {modal?.type === 'hold' && (
        <HoldModal onSelect={handleHoldConfirm} onCancel={() => setModal(null)} />
      )}
      {modal?.type === 'finish' && (
        <ConfirmCompleteModal
          job={modal.job}
          onConfirm={handleCompleteConfirm}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.type === 'team' && teamModalJob && (
        <TeamEditModal
          job={teamModalJob}
          lineId={selectedLine.line_id}
          managerId={employee.employee_id}
          onAdd={handleTeamAdd}
          onClockOff={handleTeamClockToggle}
          onRemovePermanently={handleTeamRemovePermanently}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  )
}
