import { useCallback, useEffect, useRef, useState } from 'react'
import {
  findOrCreateJob,
  startNewJob,
  holdJob,
  resumeJob,
  completeJob
} from '../lib/db'
import { isJobActive, calcElapsed, formatDuration, parseJobBarcode } from '../lib/timeCalc'
import { HOLD_REASONS, HOLD_REASON_LABEL } from '../lib/constants'

const INACTIVITY_MS = 75_000

const SUB_DEPT_LABEL = {
  blast: 'BLAST',
  pack:  'PACK',
  paint: 'PAINT',
  prep:  'PREP',
}

const WORK_LABEL = { parts: 'Parts', frames: 'Frames', parts_frames: 'Parts & Frames' }

// ── Work type picker (one-step — no tack/weld for paint) ─────────────────────
function WorkTypeModal({ onConfirm, onCancel, title = 'Working on?' }) {
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl p-8 w-full max-w-sm">
        <h2 className="text-2xl font-bold text-stone-100 mb-6 text-center">{title}</h2>
        <div className="flex flex-col gap-4">
          <button className="btn-primary  text-xl py-5" onClick={() => onConfirm('parts')}>Parts</button>
          <button className="btn-secondary text-xl py-5" onClick={() => onConfirm('frames')}>Frames</button>
          <button className="btn-ghost    text-xl py-5" onClick={() => onConfirm('parts_frames')}>
            Parts &amp; Frames
          </button>
          <button className="btn-ghost mt-1" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

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

// ── Confirm finish modal ──────────────────────────────────────────────────────
function ConfirmCompleteModal({ job, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl p-8 w-full max-w-sm">
        <h2 className="text-2xl font-bold text-stone-100 mb-2 text-center">Mark Completeed?</h2>
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

// ── Paint job card ────────────────────────────────────────────────────────────
function PaintJobCard({ job, breakRules, onHold, onResume, onComplete }) {
  const active = isJobActive(job.events)
  const lastPause = [...job.events].reverse().find(e => e.event_type === 'PAUSE')
  const holdReason = active ? null : lastPause?.hold_reason
  const lastTagged = [...job.events].reverse().find(e => e.work_type)
  const workLabel  = WORK_LABEL[lastTagged?.work_type] ?? null

  function computeElapsed() { return calcElapsed(job.events, breakRules) }
  const [elapsed, setElapsed] = useState(computeElapsed)

  useEffect(() => {
    setElapsed(computeElapsed())
    if (!active) return
    const id = setInterval(() => setElapsed(computeElapsed()), 1000)
    return () => clearInterval(id)
  }, [active, job.events, breakRules])

  return (
    <div className={`rounded-2xl p-5 border-2 transition-colors ${
      active ? 'bg-stone-800 border-amber-500' : 'border-stone-700'
    }`} style={active ? {} : { backgroundColor: '#1e1b18' }}>
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
          <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold uppercase mb-2 ${
            active ? 'bg-amber-500/20 text-amber-400' : 'bg-orange-900/40 text-orange-400'
          }`}>
            {active ? 'Active' : 'On Hold'}
          </span>
          <p className={`text-2xl font-mono font-bold ${active ? 'text-amber-400' : 'text-stone-400'}`}>
            {formatDuration(elapsed)}
          </p>
          {holdReason ? (
            <p className="text-xs text-orange-400 mt-1 max-w-[140px] text-right leading-tight">
              {HOLD_REASON_LABEL[holdReason] ?? holdReason}
            </p>
          ) : workLabel && (
            <p className="text-xs text-stone-500 mt-0.5">{workLabel}</p>
          )}
        </div>
      </div>

      <div className="flex gap-3">
        {active ? (
          <button className="btn-secondary flex-1" onClick={() => onHold(job.job_id)}>
            ⏸ Hold
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

// ── Main Paint dashboard ──────────────────────────────────────────────────────
export default function PaintDashboard({ employee, initialJobs, breakRules, onLogout }) {
  const [jobs, setJobs]     = useState(initialJobs ?? [])
  const [modal, setModal]   = useState(null)
  const [error, setError]   = useState('')
  const [scanning, setScanning] = useState(false)

  const scanInputRef = useRef(null)
  const bufferRef    = useRef('')
  const inactRef     = useRef(null)

  const subDeptLabel = SUB_DEPT_LABEL[employee.sub_department] ?? 'PAINT'

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
  }, [modal])

  function appendEvent(jobId, ev) {
    setJobs(prev => prev.map(j =>
      j.job_id === jobId ? { ...j, events: [...j.events, ev] } : j
    ))
  }

  // ── Barcode scan ────────────────────────────────────────────────────────────
  async function handleJobScan(raw) {
    const parsed = parseJobBarcode(raw)
    if (!parsed) {
      setError(`Could not parse barcode: "${raw}". Expected PO/PART`)
      return
    }
    setScanning(true)
    setError('')
    try {
      const { job, created } = await findOrCreateJob(parsed.poNumber, parsed.partNumber)
      const existing = jobs.find(j => j.job_id === job.job_id)
      setModal({
        type:       'work_type',
        action:     existing ? 'resume' : 'start',
        jobId:      job.job_id,
        wasCreated: created,
        job
      })
    } catch (err) {
      console.error(err)
      setError('Failed to look up job — check connection.')
    } finally {
      setScanning(false)
    }
  }

  async function handleWorkTypeConfirm(workType) {
    const { action, jobId, wasCreated, job: newJob } = modal
    setModal(null)
    try {
      if (action === 'start') {
        // Pause any currently active job first
        const active = jobs.find(j => isJobActive(j.events))
        if (active) {
          const pauseEv = await holdJob(employee.employee_id, active.job_id, null)
          appendEvent(active.job_id, pauseEv)
        }
        const events = await startNewJob(employee.employee_id, jobId, wasCreated, null, workType)
        setJobs(prev => [...prev, { ...newJob, events }])
      } else {
        // Resume
        const active = jobs.find(j => isJobActive(j.events))
        if (active && active.job_id !== jobId) {
          const pauseEv = await holdJob(employee.employee_id, active.job_id, null)
          appendEvent(active.job_id, pauseEv)
        }
        const ev = await resumeJob(employee.employee_id, jobId, null, workType)
        appendEvent(jobId, ev)
      }
    } catch (err) {
      console.error(err)
      setError('Action failed — check connection.')
    }
  }

  // ── Card actions ────────────────────────────────────────────────────────────
  function handleHold(jobId) {
    setModal({ type: 'hold', jobId })
  }

  async function handleHoldConfirm(reason) {
    const { jobId } = modal
    setModal(null)
    try {
      const ev = await holdJob(employee.employee_id, jobId, reason)
      appendEvent(jobId, ev)
    } catch (err) {
      console.error(err)
      setError('Hold failed.')
    }
  }

  function handleResume(jobId) {
    const job = jobs.find(j => j.job_id === jobId)
    setModal({ type: 'work_type', action: 'resume', jobId, job })
  }

  function handleComplete(jobId) {
    const job = jobs.find(j => j.job_id === jobId)
    setModal({ type: 'finish', jobId, job })
  }

  async function handleCompleteConfirm() {
    const { jobId } = modal
    setModal(null)
    try {
      await completeJob(employee.employee_id, jobId)
      setJobs(prev => prev.filter(j => j.job_id !== jobId))
    } catch (err) {
      console.error(err)
      setError('Complete failed.')
    }
  }

  return (
    <div className="flex flex-col min-h-screen">

      {/* Header */}
      <div className="bg-stone-900 border-b border-stone-700 px-5 py-4 flex items-center justify-between shrink-0 gap-3">
        <div className="min-w-0">
          <p className="text-xs text-stone-500 uppercase tracking-widest">
            Paint Shop &nbsp;·&nbsp;
            <span className="text-purple-400">{subDeptLabel}</span>
          </p>
          <p className="text-xl font-bold text-stone-100 truncate">{employee.full_name}</p>
        </div>
        <button className="btn-danger px-5 py-3 text-base" onClick={onLogout}>
          Done →
        </button>
      </div>

      {/* Scan input */}
      <div className="bg-stone-800 border-b border-stone-700 px-5 py-4 shrink-0">
        <p className="text-xs text-stone-500 uppercase tracking-widest mb-2">
          Scan a job barcode
        </p>
        <div className="relative">
          <input
            ref={scanInputRef}
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
                const val = bufferRef.current.trim()
                bufferRef.current = ''
                if (e.target) e.target.value = ''
                if (val) handleJobScan(val)
              }
            }}
            onInput={e => { bufferRef.current = e.target.value }}
            readOnly={scanning}
          />
          {scanning && (
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-amber-400 animate-pulse">…</span>
          )}
        </div>
        {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
      </div>

      {/* Job list */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {jobs.length === 0 ? (
          <div className="text-center py-16 text-stone-600">
            <p className="text-4xl mb-4">🎨</p>
            <p className="text-lg">No active jobs.</p>
            <p className="text-sm mt-1">Scan a job barcode above to get started.</p>
          </div>
        ) : (
          jobs.map(job => (
            <PaintJobCard
              key={job.job_id}
              job={job}
              breakRules={breakRules}
              onHold={handleHold}
              onResume={handleResume}
              onComplete={handleComplete}
            />
          ))
        )}
      </div>

      {/* Modals */}
      {modal?.type === 'work_type' && (
        <WorkTypeModal
          title="Working on?"
          onConfirm={handleWorkTypeConfirm}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.type === 'hold' && (
        <HoldModal
          onSelect={handleHoldConfirm}
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
    </div>
  )
}
