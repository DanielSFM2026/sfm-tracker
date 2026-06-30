import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchAssemblyLines, loadMyAssemblyJobs, findOrCreateJob, findTeamMember,
  addTeamMemberToJob, removeTeamMemberFromJob, removeTeamMemberPermanently,
  startAssemblyJob, holdAssemblyJob, completeAssemblyJob, fetchBreakRules,
  prepareManagerLineStart, onManagerLineEnd, setJobStatus, sendJobAlert
} from '../lib/db'
import { isJobActive, calcElapsed, formatDuration } from '../lib/timeCalc'
import { HOLD_REASONS } from '../lib/constants'

const INACTIVITY_MS = 120_000

// ── Alert modal ───────────────────────────────────────────────────────────────
function AlertModal({ job, lineName, employee, onSend, onCancel }) {
  const [message, setMessage] = useState('')
  const [busy, setBusy]       = useState(false)
  const [sent, setSent]       = useState(false)
  const [error, setError]     = useState('')

  async function handleSend() {
    if (!message.trim()) return
    setBusy(true); setError('')
    try {
      await onSend(message.trim())
      setSent(true)
    } catch {
      setError('Failed to send alert — check connection.')
    } finally {
      setBusy(false)
    }
  }

  if (sent) return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl p-6 w-full max-w-sm text-center">
        <p className="text-3xl mb-3">✓</p>
        <p className="text-stone-100 font-bold mb-1">Alert Sent</p>
        <p className="text-stone-400 text-sm mb-5">Management has been notified.</p>
        <button className="w-full btn-secondary py-3" onClick={onCancel}>Close</button>
      </div>
    </div>
  )

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl p-6 w-full max-w-sm">
        <h2 className="text-lg font-bold text-stone-100 mb-1">Report Issue</h2>
        <p className="text-stone-500 text-sm mb-4">
          {lineName} · PO {job.po_number} · {job.part_number}
        </p>
        <textarea
          autoFocus
          rows={4}
          value={message}
          onChange={e => setMessage(e.target.value)}
          placeholder="Describe the issue…"
          className="w-full bg-stone-700 border border-stone-600 rounded-xl px-4 py-3 text-stone-100
                     text-sm resize-none focus:outline-none focus:border-red-500 mb-3"
        />
        {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
        <div className="flex gap-3">
          <button className="flex-1 btn-secondary py-3" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            disabled={busy || !message.trim()}
            onClick={handleSend}
            className="flex-1 py-3 rounded-xl bg-red-900/40 border border-red-700 text-red-300 text-base disabled:opacity-40">
            {busy ? 'Sending…' : '⚑ Send Alert'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Hold reason modal ─────────────────────────────────────────────────────────
function HoldReasonModal({ onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl p-6 w-full max-w-sm">
        <h2 className="text-lg font-bold text-stone-100 mb-1">Hold Job</h2>
        <p className="text-stone-500 text-sm mb-4">Select a reason</p>
        <div className="space-y-2">
          {HOLD_REASONS.map(r => (
            <button key={r.key}
              className="w-full text-left px-4 py-3 rounded-xl bg-stone-700 hover:bg-orange-900/40
                         border border-stone-600 hover:border-orange-700 text-stone-200 text-sm"
              onClick={() => onConfirm(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
        <button className="w-full mt-4 text-sm text-stone-500 underline" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

// ── Confirm complete modal ────────────────────────────────────────────────────
function ConfirmCompleteModal({ job, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl p-6 w-full max-w-sm text-center">
        <p className="text-2xl mb-3">✓</p>
        <h2 className="text-lg font-bold text-stone-100 mb-1">Mark Complete?</h2>
        <p className="text-stone-400 text-sm mb-5">PO {job.po_number} · {job.part_number}</p>
        <div className="flex gap-3">
          <button className="flex-1 btn-secondary py-3" onClick={onCancel}>Cancel</button>
          <button className="flex-1 btn-green py-3" onClick={onConfirm}>Complete</button>
        </div>
      </div>
    </div>
  )
}

// ── Line picker modal ─────────────────────────────────────────────────────────
function LinePickerModal({ lines, job, onSelect, onCancel }) {
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl p-6 w-full max-w-sm">
        <h2 className="text-lg font-bold text-stone-100 mb-1">Which line?</h2>
        <p className="text-stone-500 text-sm mb-4">
          PO {job.po_number} · {job.part_number}
          {job.quantity ? ` · Qty ${job.quantity}` : ''}
        </p>
        <div className="space-y-2">
          {lines.map(l => (
            <button key={l.line_id}
              className="w-full text-left px-4 py-4 rounded-xl bg-stone-700 hover:bg-amber-500/20
                         border border-stone-600 hover:border-amber-500 text-stone-100 font-semibold text-lg"
              onClick={() => onSelect(l.line_id)}>
              {l.line_name}
            </button>
          ))}
        </div>
        <button className="w-full mt-4 text-sm text-stone-500 underline" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

// ── Team edit modal (LM only — add/remove members by scanning) ────────────────
function TeamEditModal({ job, lineId, managerId, onAdd, onClockOff, onRemovePermanently, onClose }) {
  const inputRef  = useRef(null)
  const bufferRef = useRef('')
  const [scanning, setScanning] = useState(false)
  const [error, setError]       = useState('')

  const visibleTeam = (job.team ?? []).filter(m => {
    const last = m.events?.[m.events.length - 1]
    return last?.event_type !== 'COMPLETE'
  })
  const activeMembers     = visibleTeam.filter(m => isJobActive(m.events))
  const clockedOffMembers = visibleTeam.filter(m => !isJobActive(m.events))

  useEffect(() => { if (inputRef.current) inputRef.current.focus() }, [])

  async function handleScan(badgeCode) {
    setError('')
    if (!badgeCode) return
    setScanning(true)
    try {
      const member = await findTeamMember(badgeCode)
      if (!member) { setError(`Badge not recognised: ${badgeCode}`); return }
      if (member.employee_id === managerId) { setError("That's your own badge."); return }

      const existing = job.team?.find(m => m.employee_id === member.employee_id)
      const lastEv   = existing?.events?.[existing.events.length - 1]

      if (existing && lastEv?.event_type === 'COMPLETE') {
        setError(`${member.full_name} has been permanently removed from this job.`)
        return
      }
      if (existing && isJobActive(existing.events)) {
        const ev = await removeTeamMemberFromJob(member.employee_id, job.job_id, lineId)
        onClockOff(job.job_id, member.employee_id, ev)
        return
      }
      if (existing) {
        const ev = await addTeamMemberToJob(member.employee_id, job.job_id, lineId)
        onClockOff(job.job_id, member.employee_id, ev)
        return
      }
      const ev = await addTeamMemberToJob(member.employee_id, job.job_id, lineId)
      onAdd(job.job_id, {
        employee_id:    member.employee_id,
        full_name:      member.full_name,
        badge_code:     member.badge_code,
        is_line_manager: member.is_line_manager ?? false,
        events: [ev]
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

  function MemberRow({ member, label }) {
    return (
      <div className="flex items-center justify-between py-1.5">
        <span className={`text-sm ${label === 'on' ? 'text-stone-200' : 'text-stone-500'}`}>
          {member.full_name}
        </span>
        <button onClick={() => handleRemovePermanently(member)}
          className="text-stone-600 hover:text-red-400 text-xs px-2 py-1 rounded transition-colors">
          ✕ Remove
        </button>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl p-6 w-full max-w-sm">
        <div className="flex items-center justify-between mb-5">
          <div>
            <p className="text-xs text-stone-500 uppercase tracking-widest">Team — PO {job.po_number}</p>
            <p className="text-sm text-stone-400">{job.part_number}</p>
          </div>
          <button className="btn-ghost px-4 py-2" onClick={onClose}>Done</button>
        </div>

        <input
          ref={inputRef}
          placeholder={scanning ? 'Looking up…' : '▌ Scan badge to add / toggle'}
          disabled={scanning}
          className="w-full bg-stone-700 border border-stone-600 rounded-xl px-4 py-3
                     text-stone-100 text-base outline-none placeholder-stone-500 mb-4"
          autoComplete="off" autoCorrect="off" spellCheck={false}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              const v = bufferRef.current.trim()
              bufferRef.current = ''
              if (e.target) e.target.value = ''
              if (v) handleScan(v)
            }
          }}
          onInput={e => { bufferRef.current = e.target.value }}
        />
        {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

        {activeMembers.length > 0 && (
          <div className="mb-3">
            <p className="text-xs text-stone-500 uppercase tracking-widest mb-1">On shift</p>
            {activeMembers.map(m => <MemberRow key={m.employee_id} member={m} label="on" />)}
          </div>
        )}
        {clockedOffMembers.length > 0 && (
          <div>
            <p className="text-xs text-stone-500 uppercase tracking-widest mb-1">Clocked off</p>
            {clockedOffMembers.map(m => <MemberRow key={m.employee_id} member={m} label="off" />)}
          </div>
        )}
        {visibleTeam.length === 0 && (
          <p className="text-stone-600 text-sm text-center py-2">No team members yet</p>
        )}
      </div>
    </div>
  )
}

// ── Job card ──────────────────────────────────────────────────────────────────
function AssemblyJobCard({ job, currentEmployee, breakRules, isLM, onToggleSelf, onToggleOther, onHold, onComplete, onEditTeam, onAlert }) {
  // Derive active state from events, not job.status — DB status can lag behind
  const jobActive  = job.team.some(m => isJobActive(m.events))
  const isOnHold   = !jobActive && job.team.some(m =>
    [...m.events].reverse().find(e => e.event_type === 'PAUSE')?.hold_reason
  )
  const holdReason = isOnHold
    ? job.team.flatMap(m => m.events)
        .filter(e => e.event_type === 'PAUSE' && e.hold_reason)
        .sort((a, b) => new Date(b.event_timestamp) - new Date(a.event_timestamp))[0]?.hold_reason
    : null

  // Visible team: not permanently removed
  const visibleTeam = job.team.filter(m => {
    const last = m.events[m.events.length - 1]
    return last?.event_type !== 'COMPLETE'
  })

  const anyPersonActive = visibleTeam.some(m => isJobActive(m.events))
  const activeCount     = visibleTeam.filter(m => isJobActive(m.events)).length

  function computeTotal() {
    // Sum ALL team members (including permanently removed) to match manager report
    return (job.team ?? []).reduce((sum, m) => sum + calcElapsed(m.events, breakRules), 0)
  }
  const [elapsed, setElapsed] = useState(computeTotal)
  useEffect(() => {
    setElapsed(computeTotal())
    if (!anyPersonActive) return
    const id = setInterval(() => setElapsed(computeTotal()), 1000)
    return () => clearInterval(id)
  }, [anyPersonActive, job.team, breakRules])

  const statusLabel = jobActive ? 'On Line' : isOnHold ? 'On Hold' : 'Paused'
  const statusCls   = jobActive
    ? 'bg-amber-500/20 text-amber-400'
    : isOnHold
    ? 'bg-orange-900/40 text-orange-400'
    : 'bg-stone-700 text-stone-400'

  const HOLD_SHORT = {
    missing_parts_sfm:          'Missing Parts (SFM)',
    poor_quality_sfm:           'Poor Quality (SFM)',
    missing_parts_supply_chain: 'Missing Parts (Supply Chain)',
    poor_quality_supply_chain:  'Poor Quality (Supply Chain)',
  }

  return (
    <div className={`rounded-2xl border-2 overflow-hidden transition-colors ${
      jobActive ? 'bg-stone-800 border-amber-500' : 'border-stone-700 bg-stone-900'
    }`}>

      {/* Line badge */}
      {job.line_name && (
        <div className={`border-b px-5 py-2.5 flex items-center justify-between ${
          jobActive ? 'bg-sky-900/30 border-sky-700/40' : 'bg-stone-900/80 border-stone-700/60'
        }`}>
          <span className="text-sm font-bold text-sky-300 uppercase tracking-wider">
            {job.line_name}
          </span>
          {holdReason && (
            <span className="text-xs text-orange-400">⚠ {HOLD_SHORT[holdReason] ?? holdReason}</span>
          )}
        </div>
      )}

      <div className="p-5">
        {/* Header row: job info + timer */}
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <p className="text-xs text-stone-500 uppercase tracking-widest">PO</p>
            <p className="text-xl font-bold text-stone-100">{job.po_number}</p>
            <p className="text-sm text-stone-400">{job.part_number}</p>
            {job.quantity != null && <p className="text-sm text-stone-500">Qty: {job.quantity}</p>}
          </div>
          <div className="text-right shrink-0">
            <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold uppercase mb-2 ${statusCls}`}>
              {statusLabel}
            </span>
            <p className={`text-2xl font-mono font-bold ${anyPersonActive ? 'text-amber-400' : 'text-stone-500'}`}>
              {formatDuration(elapsed)}
            </p>
            {activeCount > 0 && (
              <p className="text-xs text-sky-400 mt-0.5">{activeCount} on line</p>
            )}
          </div>
        </div>

        {/* Team chips — everyone is shown; your chip is tappable */}
        <div className="flex flex-wrap gap-2 mb-4">
          {visibleTeam.map(m => {
            const isMe     = m.employee_id === currentEmployee.employee_id
            const isThisLM = m.is_line_manager
            const active   = isJobActive(m.events)
            const tappable = isMe || isLM

            return (
              <button
                key={m.employee_id}
                disabled={!tappable}
                onClick={() => {
                  if (isMe) onToggleSelf(job.job_id)
                  else if (isLM) onToggleOther(job.job_id, m.employee_id)
                }}
                title={tappable ? (active ? 'Tap to clock off' : 'Tap to clock on') : undefined}
                className={[
                  'text-xs rounded-full px-3 py-1.5 flex items-center gap-1.5 transition-all border',
                  active
                    ? isMe
                      ? 'bg-amber-500/30 border-amber-500 text-amber-200 ring-2 ring-amber-500 font-semibold'
                      : 'bg-stone-700 border-stone-600 text-stone-200'
                    : isMe
                      ? 'bg-stone-800 border-stone-600 text-stone-500'
                      : 'bg-stone-800 border-stone-700 text-stone-600',
                  tappable ? 'cursor-pointer active:scale-95' : 'cursor-default select-none',
                ].join(' ')}
              >
                {isThisLM && <span className="font-bold text-[10px] tracking-wider text-amber-500">LM</span>}
                {isMe ? '● You' : m.full_name}
              </button>
            )
          })}

          {/* LM: edit team button */}
          {isLM && (
            <button
              onClick={() => onEditTeam(job.job_id)}
              className="text-xs text-stone-500 hover:text-sky-400 border border-stone-700
                         hover:border-sky-600 rounded-full px-2.5 py-1.5 transition-colors">
              + Team
            </button>
          )}
        </div>

        {/* Action buttons — all assembly users */}
        <div className="flex gap-2">
          {jobActive && (
            <button
              className="flex-1 py-3 text-base rounded-xl border border-orange-700 bg-orange-950/40 text-orange-400"
              onClick={() => onHold(job.job_id)}>
              ⚠ Hold
            </button>
          )}
          <button
            className="btn-green flex-1 py-3 text-base"
            onClick={() => onComplete(job.job_id)}>
            ✓ Complete
          </button>
          <button
            className="py-3 px-4 text-base rounded-xl border border-red-800 bg-red-950/40 text-red-400"
            onClick={() => onAlert(job)}>
            ⚑
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main dashboard ────────────────────────────────────────────────────────────
export default function AssemblyDashboard({ employee, breakRules: appBreakRules, onLogout }) {
  const [jobs, setJobs]         = useState([])
  const [lines, setLines]       = useState([])
  const [modal, setModal]       = useState(null)
  const [error, setError]       = useState('')
  const [scanning, setScanning] = useState(false)
  const [breakRules, setBreakRules] = useState(appBreakRules ?? [])

  const isLM     = !!employee.is_line_manager
  const scanRef  = useRef(null)
  const bufRef   = useRef('')
  const inactRef = useRef(null)

  // Inactivity logout
  const resetInactivity = useCallback(() => {
    if (inactRef.current) clearTimeout(inactRef.current)
    inactRef.current = setTimeout(onLogout, INACTIVITY_MS)
  }, [onLogout])

  useEffect(() => {
    resetInactivity()
    const evts = ['touchstart','mousedown','keydown']
    evts.forEach(e => window.addEventListener(e, resetInactivity, { passive: true }))
    return () => {
      if (inactRef.current) clearTimeout(inactRef.current)
      evts.forEach(e => window.removeEventListener(e, resetInactivity))
    }
  }, [resetInactivity])

  // Load jobs + lines
  useEffect(() => {
    loadMyAssemblyJobs(employee.employee_id).then(setJobs).catch(console.error)
    fetchAssemblyLines().then(setLines).catch(console.error)
    if (!appBreakRules?.length) fetchBreakRules().then(setBreakRules).catch(console.error)
  }, [employee.employee_id])

  // Refocus scan input when modal closes (LM only)
  useEffect(() => {
    if (!modal && scanRef.current) scanRef.current.focus()
  }, [modal])

  // ── State helpers ────────────────────────────────────────────────────────────
  function appendMemberEvent(jobId, employeeId, ev) {
    setJobs(prev => prev.map(j =>
      j.job_id !== jobId ? j : {
        ...j,
        team: j.team.map(m =>
          m.employee_id === employeeId
            ? { ...m, events: [...m.events, ev] }
            : m
        )
      }
    ))
  }

  function setJobStatusLocal(jobId, status) {
    setJobs(prev => prev.map(j => j.job_id === jobId ? { ...j, status } : j))
  }

  // ── Job scan (LM only) ───────────────────────────────────────────────────────
  async function handleJobScan(raw) {
    const idx = raw.indexOf('/')
    if (idx < 1) { setError(`Could not parse: "${raw}". Expected PO/PART`); return }
    const po   = raw.slice(0, idx).trim()
    const part = raw.slice(idx + 1).trim()
    setScanning(true); setError('')
    try {
      const { job, created } = await findOrCreateJob(po, part, 'assembly')
      if (jobs.find(j => j.job_id === job.job_id)) {
        setError(`PO ${po} / ${part} is already on your list.`)
        return
      }
      // Job already exists in DB — confirm before joining
      if (!created) {
        setModal({ type: 'job_exists_confirm', job })
        return
      }
      setModal({ type: 'line_pick', job })
    } catch (err) {
      console.error(err)
      setError('Failed to look up job — check connection.')
    } finally {
      setScanning(false)
    }
  }

  // ── Line picked → start job → open team modal ────────────────────────────────
  async function handleLineSelect(lineId) {
    const { job } = modal
    setModal(null)
    try {
      const ev       = await startAssemblyJob(employee.employee_id, job.job_id, lineId)
      const lineName = lines.find(l => l.line_id === lineId)?.line_name ?? `Line ${lineId}`
      // Reload all jobs — startAssemblyJob called prepareManagerLineStart which may have
      // updated split_counts on existing jobs; reload picks all of that up correctly.
      const fresh = await loadMyAssemblyJobs(employee.employee_id)
      // If the new job isn't in DB yet (race), append it manually
      if (!fresh.find(j => j.job_id === job.job_id)) {
        fresh.push({
          ...job,
          status:    'in_progress',
          line_id:   lineId,
          line_name: lineName,
          team: [{
            employee_id:     employee.employee_id,
            full_name:       employee.full_name,
            badge_code:      employee.badge_code,
            is_line_manager: true,
            events: [{ event_type: 'START', event_timestamp: ev.event_timestamp, split_count: ev.split_count ?? 1 }]
          }]
        })
      }
      setJobs(fresh)
      setModal({ type: 'team', jobId: job.job_id })
    } catch (err) {
      console.error(err)
      setError('Failed to start job.')
    }
  }

  // ── Toggle self on/off ────────────────────────────────────────────────────────
  async function handleToggleSelf(jobId) {
    const job = jobs.find(j => j.job_id === jobId)
    const me  = job.team.find(m => m.employee_id === employee.employee_id)
    if (!me) return
    const amActive = isJobActive(me.events)
    try {
      if (amActive) {
        // Clock off — PAUSE this person. If LM, recalculate split on remaining jobs then reload.
        const ev = await removeTeamMemberFromJob(employee.employee_id, jobId, job.line_id)
        appendMemberEvent(jobId, employee.employee_id, ev)
        const othersStillOn = job.team
          .filter(m => m.employee_id !== employee.employee_id)
          .some(m => isJobActive(m.events))
        if (!othersStillOn) {
          await setJobStatus(jobId, 'paused')
          setJobStatusLocal(jobId, 'paused')
        }
        if (isLM) {
          await onManagerLineEnd(employee.employee_id)
          loadMyAssemblyJobs(employee.employee_id).then(setJobs).catch(console.error)
        }
      } else {
        // Clock on — if LM, prepareManagerLineStart updates other jobs' split_count in DB,
        // then reload all jobs so those cards reflect the new split immediately.
        const splitCount = isLM
          ? await prepareManagerLineStart(employee.employee_id, job.line_id)
          : 1
        const ev = await addTeamMemberToJob(employee.employee_id, jobId, job.line_id, splitCount)
        appendMemberEvent(jobId, employee.employee_id, ev)
        if (job.status === 'paused') {
          await setJobStatus(jobId, 'in_progress')
          setJobStatusLocal(jobId, 'in_progress')
        }
        if (isLM) {
          loadMyAssemblyJobs(employee.employee_id).then(setJobs).catch(console.error)
        }
      }
    } catch (err) {
      console.error(err)
      setError('Could not update — check connection.')
    }
  }

  // ── LM toggles someone else ──────────────────────────────────────────────────
  async function handleToggleOther(jobId, targetId) {
    if (!isLM) return
    const job    = jobs.find(j => j.job_id === jobId)
    const member = job.team.find(m => m.employee_id === targetId)
    if (!member) return
    const wasActive = isJobActive(member.events)
    try {
      if (wasActive) {
        const ev = await removeTeamMemberFromJob(targetId, jobId, job.line_id)
        appendMemberEvent(jobId, targetId, ev)
        const othersStillOn = job.team
          .filter(m => m.employee_id !== targetId)
          .some(m => isJobActive(m.events))
        if (!othersStillOn) {
          await setJobStatus(jobId, 'paused')
          setJobStatusLocal(jobId, 'paused')
        }
      } else {
        const ev = await addTeamMemberToJob(targetId, jobId, job.line_id)
        appendMemberEvent(jobId, targetId, ev)
        if (job.status === 'paused') {
          await setJobStatus(jobId, 'in_progress')
          setJobStatusLocal(jobId, 'in_progress')
        }
      }
    } catch (err) {
      console.error(err)
      setError('Could not update — check connection.')
    }
  }

  // ── Hold ──────────────────────────────────────────────────────────────────────
  async function handleHoldConfirm(reason) {
    const { jobId } = modal
    setModal(null)
    const job       = jobs.find(j => j.job_id === jobId)
    const activeIds = job.team.filter(m => isJobActive(m.events)).map(m => m.employee_id)
    try {
      const events = await holdAssemblyJob(jobId, job.line_id, reason, activeIds)
      const now    = events[0]?.event_timestamp ?? new Date().toISOString()
      setJobs(prev => prev.map(j =>
        j.job_id !== jobId ? j : {
          ...j,
          status: 'paused',
          team: j.team.map(m =>
            activeIds.includes(m.employee_id)
              ? { ...m, events: [...m.events, { event_type: 'PAUSE', hold_reason: reason, event_timestamp: now, split_count: 1 }] }
              : m
          )
        }
      ))
    } catch (err) {
      console.error(err)
      setError('Hold failed.')
    }
  }

  // ── Complete ──────────────────────────────────────────────────────────────────
  async function handleCompleteConfirm() {
    const { jobId } = modal
    setModal(null)
    const job       = jobs.find(j => j.job_id === jobId)
    const activeIds = job.team
      .filter(m => {
        const last = m.events[m.events.length - 1]
        return last?.event_type !== 'COMPLETE' && isJobActive(m.events)
      })
      .map(m => m.employee_id)
    try {
      await completeAssemblyJob(jobId, job.line_id, activeIds)
      setJobs(prev => prev.filter(j => j.job_id !== jobId))
    } catch (err) {
      console.error(err)
      setError('Complete failed.')
    }
  }

  // ── Team modal handlers ───────────────────────────────────────────────────────
  function handleTeamAdd(jobId, member) {
    setJobs(prev => prev.map(j =>
      j.job_id === jobId ? { ...j, team: [...(j.team ?? []), member] } : j
    ))
  }

  function handleTeamClockToggle(jobId, employeeId, ev) {
    appendMemberEvent(jobId, employeeId, ev)
  }

  function handleTeamRemovePermanently(jobId, employeeId, ev) {
    appendMemberEvent(jobId, employeeId, ev)
  }

  const teamModalJob = modal?.type === 'team' ? jobs.find(j => j.job_id === modal.jobId) : null

  return (
    <div className="flex flex-col min-h-screen bg-stone-950">

      {/* Header */}
      <div className="bg-stone-900 border-b border-stone-700 px-5 py-4 flex items-center justify-between shrink-0">
        <div>
          <p className="text-xs text-stone-500 uppercase tracking-widest">
            Assembly{isLM ? ' · Line Manager' : ''}
          </p>
          <p className="text-xl font-bold text-stone-100">{employee.full_name}</p>
        </div>
        <button className="btn-danger px-4 py-2.5 text-sm" onClick={onLogout}>✕ Done</button>
      </div>

      {/* Job scan input — all assembly users */}
      <div className="bg-stone-900/60 border-b border-stone-800 px-4 py-3">
          <input
            ref={scanRef}
            type="text"
            inputMode="none"
            placeholder={scanning ? 'Looking up job…' : '▌ Scan job barcode to start'}
            disabled={scanning}
            autoComplete="off" autoCorrect="off" spellCheck={false}
            className="w-full bg-stone-800 border border-stone-600 rounded-xl px-4 py-3
                       text-stone-100 text-base outline-none placeholder-stone-600"
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const v = bufRef.current.trim()
                bufRef.current = ''
                if (e.target) e.target.value = ''
                if (v) handleJobScan(v)
              }
            }}
            onInput={e => { bufRef.current = e.target.value }}
          />
        </div>

      {error && (
        <div className="mx-4 mt-3 bg-red-900/40 border border-red-700 rounded-xl px-4 py-3 text-red-300 text-sm flex items-center justify-between">
          <span>{error}</span>
          <button className="underline ml-3 shrink-0" onClick={() => setError('')}>Dismiss</button>
        </div>
      )}

      {/* Job list */}
      <div className="flex-1 overflow-y-auto px-4 py-5 space-y-4">
        {jobs.length === 0 && (
          <div className="text-center py-20">
            <p className="text-5xl mb-4">🏭</p>
            <p className="text-stone-400 font-semibold text-lg">No active jobs</p>
            <p className="text-stone-600 text-sm mt-2">
              Scan a job barcode above to get started
            </p>
          </div>
        )}

        {[...jobs]
          .sort((a, b) => (a.line_id ?? 0) - (b.line_id ?? 0))
          .map(job => (
          <AssemblyJobCard
            key={job.job_id}
            job={job}
            currentEmployee={employee}
            breakRules={breakRules}
            isLM={isLM}
            onToggleSelf={handleToggleSelf}
            onToggleOther={handleToggleOther}
            onHold={jobId => setModal({ type: 'hold', jobId })}
            onComplete={jobId => setModal({ type: 'finish', jobId, job: jobs.find(j => j.job_id === jobId) })}
            onEditTeam={jobId => setModal({ type: 'team', jobId })}
            onAlert={job => setModal({ type: 'alert', job })}
          />
        ))}
      </div>

      {/* Modals */}
      {modal?.type === 'job_exists_confirm' && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-4">
          <div className="bg-stone-800 border border-stone-600 rounded-2xl p-6 w-full max-w-sm text-center">
            <p className="text-2xl mb-3">⚠️</p>
            <h2 className="text-lg font-bold text-stone-100 mb-2">Job Already Exists</h2>
            <p className="text-stone-400 text-sm mb-1">PO <strong className="text-stone-200">{modal.job.po_number}</strong></p>
            <p className="text-stone-400 text-sm mb-5">Part <strong className="text-stone-200">{modal.job.part_number}</strong></p>
            <p className="text-stone-400 text-sm mb-6">This job is already in the system. Do you want to continue working on it?</p>
            <div className="flex gap-3">
              <button className="flex-1 btn-secondary py-3" onClick={() => setModal(null)}>Cancel</button>
              <button className="flex-1 btn-green py-3" onClick={() => setModal({ type: 'line_pick', job: modal.job })}>Continue</button>
            </div>
          </div>
        </div>
      )}
      {modal?.type === 'line_pick' && (
        <LinePickerModal
          lines={lines}
          job={modal.job}
          onSelect={handleLineSelect}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.type === 'hold' && (
        <HoldReasonModal
          onConfirm={handleHoldConfirm}
          onCancel={() => setModal(null)}
        />
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
          lineId={teamModalJob.line_id}
          managerId={employee.employee_id}
          onAdd={handleTeamAdd}
          onClockOff={handleTeamClockToggle}
          onRemovePermanently={handleTeamRemovePermanently}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'alert' && (
        <AlertModal
          job={modal.job}
          lineName={lines.find(l => l.line_id === modal.job.line_id)?.line_name ?? 'Assembly'}
          employee={employee}
          onSend={async (message) => {
            const lineName = lines.find(l => l.line_id === modal.job.line_id)?.line_name ?? 'Assembly'
            await sendJobAlert({
              jobId:        modal.job.job_id,
              employeeId:   employee.employee_id,
              lineId:       modal.job.line_id,
              poNumber:     modal.job.po_number,
              partNumber:   modal.job.part_number,
              message,
              employeeName: employee.full_name,
              lineName,
            })
          }}
          onCancel={() => setModal(null)}
        />
      )}
    </div>
  )
}
