import { useCallback, useEffect, useRef, useState } from 'react'
import {
  findOrCreateJob,
  startNewJob,
  pauseJob,
  holdJob,
  resumeJob,
  completeJob,
  employeeHasCompletedJob,
} from '../lib/db'
import { isJobActive, calcElapsed, formatDuration, parseJobBarcode } from '../lib/timeCalc'
import { HOLD_REASONS, HOLD_REASON_LABEL } from '../lib/constants'

const INACTIVITY_MS = 75_000

function ManualScanModal({ onSubmit, onCancel }) {
  const [val, setVal] = useState('')
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl p-8 w-full max-w-sm">
        <h2 className="text-xl font-bold text-stone-100 mb-1 text-center">Enter Job Barcode</h2>
        <p className="text-stone-500 text-sm text-center mb-5">Format: PO/PART</p>
        <input
          autoFocus
          type="text"
          className="w-full bg-stone-900 border-2 border-stone-600 focus:border-amber-500
                     rounded-xl px-4 py-3 text-stone-100 text-lg outline-none mb-4"
          placeholder="e.g. 1234/AB-56"
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && val.trim()) onSubmit(val.trim()) }}
        />
        <div className="flex gap-3">
          <button className="btn-ghost flex-1" onClick={onCancel}>Cancel</button>
          <button className="btn-primary flex-1" onClick={() => val.trim() && onSubmit(val.trim())}>Go</button>
        </div>
      </div>
    </div>
  )
}

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

// ── Single job row (used inside booth group and standalone paused cards) ───────
function JobRow({ job, breakRules, active, onHold, onResume, onComplete }) {
  const lastPause  = [...job.events].reverse().find(e => e.event_type === 'PAUSE')
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
    <div className="flex items-center gap-3 py-3 border-b border-stone-700 last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-base font-bold text-stone-100 truncate">{job.po_number}</p>
        <p className="text-xs text-stone-400 truncate">Part: {job.part_number}</p>
        {workLabel && <p className="text-xs text-red-400 mt-0.5">{workLabel}</p>}
        {holdReason && (
          <p className="text-xs text-orange-400 mt-0.5">{HOLD_REASON_LABEL[holdReason] ?? holdReason}</p>
        )}
      </div>
      <div className="text-right shrink-0">
        <p className={`text-lg font-mono font-bold tabular-nums ${active ? 'text-amber-400' : 'text-stone-500'}`}>
          {formatDuration(elapsed)}
        </p>
      </div>
      <div className="flex gap-2 shrink-0">
        {active ? (
          <button className="btn-secondary px-3 py-2 text-sm" onClick={() => onHold(job.job_id)}>⏸</button>
        ) : (
          <button className="btn-primary px-3 py-2 text-sm" onClick={() => onResume(job.job_id)}>▶</button>
        )}
        <button className="btn-green px-3 py-2 text-sm" onClick={() => onComplete(job.job_id)}>✓</button>
      </div>
    </div>
  )
}

// ── Active booth group card ───────────────────────────────────────────────────
function BoothCard({ jobs, breakRules, onHold, onResume, onComplete }) {
  return (
    <div className="bg-stone-800 border-2 border-amber-500 rounded-2xl overflow-hidden">
      <div className="bg-amber-500/10 px-4 py-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-amber-400 uppercase tracking-widest">
          Booth — {jobs.length} job{jobs.length !== 1 ? 's' : ''} running
        </span>
        <span className="text-xs text-stone-500">time split ÷{jobs.length}</span>
      </div>
      <div className="px-4">
        {jobs.map(job => (
          <JobRow
            key={job.job_id}
            job={job}
            breakRules={breakRules}
            active
            onHold={onHold}
            onResume={onResume}
            onComplete={onComplete}
          />
        ))}
      </div>
    </div>
  )
}

// ── Standalone paused/held job card ──────────────────────────────────────────
function PaintJobCard({ job, breakRules, onHold, onResume, onComplete }) {
  const lastPause  = [...job.events].reverse().find(e => e.event_type === 'PAUSE')
  const holdReason = lastPause?.hold_reason
  return (
    <div className={`rounded-2xl border overflow-hidden ${holdReason ? 'border-red-700' : 'border-stone-700'}`}
         style={{ backgroundColor: '#1e1b18' }}>
      <div className={`px-4 py-2 ${holdReason ? 'bg-red-950/40' : 'bg-stone-800/60'}`}>
        <span className={`text-xs font-semibold uppercase tracking-widest ${holdReason ? 'text-red-400' : 'text-orange-400'}`}>
          {holdReason ? `On Hold — ${HOLD_REASON_LABEL[holdReason] ?? holdReason}` : 'Paused'}
        </span>
      </div>
      <div className="px-4">
        <JobRow
          job={job}
          breakRules={breakRules}
          active={false}
          onHold={onHold}
          onResume={onResume}
          onComplete={onComplete}
        />
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
  const [showManual, setShowManual] = useState(false)

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

  useEffect(() => { scanInputRef.current?.focus() }, [])
  useEffect(() => { if (!modal) scanInputRef.current?.focus() }, [modal])

  const activeCount = jobs.filter(j => isJobActive(j.events)).length

  function appendEvent(jobId, ev) {
    setJobs(prev => prev.map(j =>
      j.job_id === jobId ? { ...j, events: [...j.events, ev] } : j
    ))
  }

  // PAUSE+RESUME all currently active jobs (except excludeJobId) at newCount split
  async function updateSplitCounts(newCount, excludeJobId = null) {
    const targets = jobs.filter(j => isJobActive(j.events) && j.job_id !== excludeJobId)
    for (const j of targets) {
      const lastTagged = [...j.events].reverse().find(e => e.work_type)
      const wt = lastTagged?.work_type ?? null
      const pauseEv  = await pauseJob(employee.employee_id, j.job_id)
      appendEvent(j.job_id, pauseEv)
      const resumeEv = await resumeJob(employee.employee_id, j.job_id, null, wt, newCount)
      appendEvent(j.job_id, resumeEv)
    }
  }

  // ── Barcode scan ────────────────────────────────────────────────────────────
  async function handleJobScan(raw) {
    const parsed = parseJobBarcode(raw)
    if (!parsed) { setError(`Could not parse barcode: "${raw}". Expected PO/PART`); return }
    setScanning(true); setError('')
    try {
      const { job, created } = await findOrCreateJob(parsed.poNumber, parsed.partNumber, 'paint')
      const existing = jobs.find(j => j.job_id === job.job_id)
      if (existing && isJobActive(existing.events)) {
        setError(`${job.po_number} is already active.`)
        return
      }
      if (!created && !existing) {
        const alreadyDone = await employeeHasCompletedJob(employee.employee_id, job.job_id)
        if (alreadyDone) {
          setModal({ type: 'already_complete', job })
          return
        }
      }
      setModal({ type: 'work_type', action: existing ? 'resume' : 'start', jobId: job.job_id, wasCreated: created, job })
    } catch (err) {
      console.error(err); setError('Failed to look up job — check connection.')
    } finally {
      setScanning(false)
    }
  }

  async function handleWorkTypeConfirm(workType) {
    const { action, jobId, wasCreated, job: newJob } = modal
    setModal(null)
    try {
      const newCount = activeCount + 1
      if (action === 'start') {
        await updateSplitCounts(newCount)
        const events = await startNewJob(employee.employee_id, jobId, wasCreated, null, workType, newCount)
        setJobs(prev => [...prev, { ...newJob, events }])
      } else {
        await updateSplitCounts(newCount, jobId)
        const ev = await resumeJob(employee.employee_id, jobId, null, workType, newCount)
        appendEvent(jobId, ev)
      }
    } catch (err) {
      console.error(err); setError('Action failed — check connection.')
    }
  }

  // ── Card actions ────────────────────────────────────────────────────────────
  function handleHold(jobId) { setModal({ type: 'hold', jobId }) }

  async function handleHoldConfirm(reason) {
    const { jobId } = modal
    setModal(null)
    try {
      const ev = await holdJob(employee.employee_id, jobId, reason)
      appendEvent(jobId, ev)
      const remaining = jobs.filter(j => isJobActive(j.events) && j.job_id !== jobId).length
      if (remaining > 0) await updateSplitCounts(remaining, jobId)
    } catch (err) {
      console.error(err); setError('Hold failed.')
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
      const remaining = jobs.filter(j => isJobActive(j.events) && j.job_id !== jobId).length
      if (remaining > 0) await updateSplitCounts(remaining, jobId)
      setJobs(prev => prev.filter(j => j.job_id !== jobId))
    } catch (err) {
      console.error(err); setError('Complete failed.')
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
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs text-stone-500 uppercase tracking-widest">Scan a job barcode</p>
          <button onClick={() => setShowManual(true)} className="text-xs text-stone-500 hover:text-stone-300 underline">
            ⌨ Type manually
          </button>
        </div>
        <div className="relative">
          <input
            ref={scanInputRef}
            type="text"
            className="w-full bg-stone-900 border-2 border-stone-600 focus:border-amber-500
                       rounded-xl px-4 py-3 text-stone-100 text-lg outline-none
                       transition-colors placeholder-stone-600"
            placeholder={scanning ? 'Looking up job…' : '▌ Ready to scan'}
            inputMode="none"
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
        ) : (() => {
          const activeJobs  = jobs.filter(j => isJobActive(j.events))
          const pausedJobs  = jobs.filter(j => !isJobActive(j.events))
          return (
            <>
              {activeJobs.length > 0 && (
                <BoothCard
                  jobs={activeJobs}
                  breakRules={breakRules}
                  onHold={handleHold}
                  onResume={handleResume}
                  onComplete={handleComplete}
                />
              )}
              {pausedJobs.map(job => (
                <PaintJobCard
                  key={job.job_id}
                  job={job}
                  breakRules={breakRules}
                  onHold={handleHold}
                  onResume={handleResume}
                  onComplete={handleComplete}
                />
              ))}
            </>
          )
        })()}
      </div>

      {/* Modals */}
      {showManual && (
        <ManualScanModal
          onSubmit={v => { setShowManual(false); handleJobScan(v) }}
          onCancel={() => setShowManual(false)}
        />
      )}
      {modal?.type === 'already_complete' && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-4">
          <div className="bg-stone-800 border border-stone-600 rounded-2xl p-6 w-full max-w-sm text-center">
            <p className="text-2xl mb-3">⚠️</p>
            <h2 className="text-xl font-bold text-stone-100 mb-2">Already Completed</h2>
            <p className="text-stone-400 text-sm mb-1">PO: <strong className="text-stone-200">{modal.job.po_number}</strong></p>
            <p className="text-stone-400 text-sm mb-5">You've already completed this job. Previous time is kept.</p>
            <div className="flex gap-3">
              <button className="btn-ghost flex-1" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn-primary flex-1" onClick={() => setModal({ type: 'work_type', action: 'start', jobId: modal.job.job_id, wasCreated: false, job: modal.job })}>
                Continue
              </button>
            </div>
          </div>
        </div>
      )}
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
