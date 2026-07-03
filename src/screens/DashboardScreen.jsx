import { useCallback, useEffect, useRef, useState } from 'react'
import {
  findOrCreateJob,
  startNewJob,
  pauseJob,
  resumeJob,
  completeJob,
  employeeHasCompletedJob,
  sendJobAlert,
} from '../lib/db'
import { isJobActive, parseJobBarcode } from '../lib/timeCalc'
import JobCard from '../components/JobCard'
import AlertModal from '../components/AlertModal'

const INACTIVITY_TIMEOUT_MS = 75_000

// ── Manual barcode entry modal ────────────────────────────────────────────────
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

// ── Two-step action modal (Activity → Work type) ─────────────────────────────
function JobActionModal({ onConfirm, onCancel }) {
  const [step, setStep]             = useState(1)
  const [activityType, setActivity] = useState(null)

  function pickActivity(type) { setActivity(type); setStep(2) }
  function pickWorkType(workType) { onConfirm({ activityType, workType }) }

  const activityLabel = { tack: 'Tack', weld: 'Weld', tack_weld: 'Tack & Weld' }

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl p-8 w-full max-w-sm">
        {step === 1 ? (
          <>
            <h2 className="text-2xl font-bold text-stone-100 mb-1 text-center">What are you doing?</h2>
            <p className="text-stone-400 text-center text-sm mb-6">Step 1 of 2</p>
            <div className="flex flex-col gap-4">
              <button className="btn-primary  text-xl py-5" onClick={() => pickActivity('tack')}>Tack</button>
              <button className="btn-secondary text-xl py-5" onClick={() => pickActivity('weld')}>Weld</button>
              <button className="btn-ghost    text-xl py-5" onClick={() => pickActivity('tack_weld')}>Tack &amp; Weld</button>
              <button className="btn-ghost mt-1" onClick={onCancel}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-2xl font-bold text-stone-100 mb-1 text-center">Working on?</h2>
            <p className="text-stone-400 text-center text-sm mb-6">
              Step 2 of 2 &nbsp;·&nbsp;
              <span className="text-amber-400">{activityLabel[activityType]}</span>
            </p>
            <div className="flex flex-col gap-4">
              <button className="btn-primary  text-xl py-5" onClick={() => pickWorkType('parts')}>Parts</button>
              <button className="btn-secondary text-xl py-5" onClick={() => pickWorkType('frames')}>Frames</button>
              <button className="btn-ghost    text-xl py-5" onClick={() => pickWorkType('parts_frames')}>Parts &amp; Frames</button>
              <button className="btn-ghost mt-1" onClick={() => setStep(1)}>← Back</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Confirm complete modal ────────────────────────────────────────────────────
function ConfirmModal({ job, onConfirm, onCancel }) {
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

// ── Main dashboard ────────────────────────────────────────────────────────────
export default function DashboardScreen({ employee, initialJobs, initialSplitMode, breakRules, onLogout }) {
  const [jobs, setJobs]           = useState(initialJobs)
  const [splitMode, setSplitMode] = useState(initialSplitMode)
  const [error, setError]         = useState('')
  const [scanning, setScanning]   = useState(false)
  const [modal, setModal]         = useState(null)
  const [showManual, setShowManual] = useState(false)

  const scanInputRef  = useRef(null)
  const bufferRef     = useRef('')
  const inactivityRef = useRef(null)

  const activeJobIds = jobs.filter(j => isJobActive(j.events)).map(j => j.job_id)
  const activeCount  = activeJobIds.length

  const activeJobIdsRef = useRef(activeJobIds)
  useEffect(() => { activeJobIdsRef.current = activeJobIds }, [jobs])

  useEffect(() => { scanInputRef.current?.focus() }, [])
  useEffect(() => { if (!modal) scanInputRef.current?.focus() }, [modal])

  // ── Helpers ─────────────────────────────────────────────────────────────────

  // Get the activity_type and work_type from a job's most recent START/RESUME
  function getLastTag(events) {
    return [...events]
      .filter(e => e.event_type === 'START' || e.event_type === 'RESUME')
      .sort((a, b) => new Date(b.event_timestamp) - new Date(a.event_timestamp))[0] ?? {}
  }

  function appendEvent(jobId, ev) {
    setJobs(prev =>
      prev.map(j => j.job_id === jobId ? { ...j, events: [...j.events, ev] } : j)
    )
  }

  async function pauseActive() {
    const id = jobs.find(j => isJobActive(j.events))?.job_id
    if (!id) return
    const ev = await pauseJob(employee.employee_id, id)
    appendEvent(id, ev)
  }

  // When split count changes, close current intervals and reopen with newCount.
  // excludeJobId is the job being stopped (already paused before this call).
  async function updateSplitCounts(newCount, excludeJobId = null) {
    const targets = jobs.filter(j => isJobActive(j.events) && j.job_id !== excludeJobId)
    for (const j of targets) {
      const tag    = getLastTag(j.events)
      const pauseEv  = await pauseJob(employee.employee_id, j.job_id)
      appendEvent(j.job_id, pauseEv)
      const resumeEv = await resumeJob(
        employee.employee_id, j.job_id, tag.activity_type, tag.work_type, newCount
      )
      appendEvent(j.job_id, resumeEv)
    }
  }

  // ── Inactivity timer ────────────────────────────────────────────────────────
  const resetInactivity = useCallback(() => {
    if (inactivityRef.current) clearTimeout(inactivityRef.current)
    inactivityRef.current = setTimeout(onLogout, INACTIVITY_TIMEOUT_MS)
  }, [onLogout])

  useEffect(() => {
    resetInactivity()
    const evts = ['touchstart', 'mousedown', 'keydown']
    evts.forEach(ev => window.addEventListener(ev, resetInactivity, { passive: true }))
    return () => {
      if (inactivityRef.current) clearTimeout(inactivityRef.current)
      evts.forEach(ev => window.removeEventListener(ev, resetInactivity))
    }
  }, [resetInactivity])


  // ── Barcode scan ────────────────────────────────────────────────────────────
  async function handleJobScan(rawValue) {
    const parsed = parseJobBarcode(rawValue)
    if (!parsed) {
      setError(`Could not parse barcode: "${rawValue}". Expected format: PO/PART`)
      return
    }
    setScanning(true)
    setError('')
    try {
      const { job, created } = await findOrCreateJob(parsed.poNumber, parsed.partNumber)
      const existing = jobs.find(j => j.job_id === job.job_id)

      // Warn if this employee has already completed this job
      if (!created && !existing) {
        const alreadyDone = await employeeHasCompletedJob(employee.employee_id, job.job_id)
        if (alreadyDone) {
          setModal({ type: 'already_complete', job })
          return
        }
      }

      setModal({
        type:       'job_action',
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

  // ── Job action modal confirmed ──────────────────────────────────────────────
  async function handleActionConfirm({ activityType, workType }) {
    const { action, jobId, wasCreated, job: newJob } = modal
    setModal(null)
    try {
      if (action === 'edit') {
        // Pause + re-resume with corrected types; preserve current split count
        const currentSplit = splitMode ? activeCount : 1
        const pauseEv  = await pauseJob(employee.employee_id, jobId)
        appendEvent(jobId, pauseEv)
        const resumeEv = await resumeJob(employee.employee_id, jobId, activityType, workType, currentSplit)
        appendEvent(jobId, resumeEv)

      } else if (action === 'start') {
        if (splitMode) {
          // Lock in current split time, then open new intervals at the higher count
          const newCount = activeCount + 1
          await updateSplitCounts(newCount)
          const events = await startNewJob(employee.employee_id, jobId, wasCreated, activityType, workType, newCount)
          setJobs(prev => [...prev, { ...newJob, events }])
        } else {
          await pauseActive()
          const events = await startNewJob(employee.employee_id, jobId, wasCreated, activityType, workType, 1)
          setJobs(prev => [...prev, { ...newJob, events }])
        }

      } else {
        // resume
        if (splitMode) {
          const newCount = activeCount + 1
          await updateSplitCounts(newCount)
          const ev = await resumeJob(employee.employee_id, jobId, activityType, workType, newCount)
          appendEvent(jobId, ev)
        } else {
          await pauseActive()
          const ev = await resumeJob(employee.employee_id, jobId, activityType, workType, 1)
          appendEvent(jobId, ev)
        }
      }
    } catch (err) {
      console.error(err)
      setError('Action failed — check connection.')
    }
  }

  // ── Card actions ────────────────────────────────────────────────────────────
  async function handlePause(jobId) {
    try {
      const ev = await pauseJob(employee.employee_id, jobId)
      appendEvent(jobId, ev)

      if (splitMode) {
        // Remaining active jobs after this pause
        const remaining = jobs.filter(j => isJobActive(j.events) && j.job_id !== jobId)
        if (remaining.length > 0) {
          await updateSplitCounts(remaining.length, jobId)
        }
        // Auto-turn off split if 1 or fewer jobs remain
        if (remaining.length <= 1) {
          setSplitMode(false)
        }
      }
    } catch (err) {
      console.error(err)
      setError('Pause failed.')
    }
  }

  function handleResumeClick(jobId) {
    setModal({ type: 'job_action', action: 'resume', jobId })
  }

  function handleEditClick(jobId) {
    setModal({ type: 'job_action', action: 'edit', jobId })
  }

  function handleCompleteClick(jobId) {
    const job = jobs.find(j => j.job_id === jobId)
    setModal({ type: 'confirm', job })
  }

  async function handleCompleteConfirm() {
    const jobId = modal.job.job_id
    setModal(null)
    try {
      await completeJob(employee.employee_id, jobId)
      setJobs(prev => prev.filter(j => j.job_id !== jobId))

      if (splitMode) {
        const remaining = jobs.filter(j => isJobActive(j.events) && j.job_id !== jobId)
        if (remaining.length > 0) {
          await updateSplitCounts(remaining.length, jobId)
        }
        if (remaining.length <= 1) {
          setSplitMode(false)
        }
      }
    } catch (err) {
      console.error(err)
      setError('Complete failed.')
    }
  }

  // ── Split mode toggle ────────────────────────────────────────────────────────
  async function handleSplitToggle() {
    const turningOff = splitMode
    setSplitMode(v => !v)

    if (turningOff) {
      const activeJobs = jobs.filter(j => isJobActive(j.events))
      if (activeJobs.length < 2) return

      // Find the most recently started job — it keeps running
      const sorted = [...activeJobs].sort((a, b) => {
        const aT = getLastTag(a.events).event_timestamp ?? ''
        const bT = getLastTag(b.events).event_timestamp ?? ''
        return bT < aT ? -1 : 1
      })
      const keeper = sorted[0]

      // Pause ALL active jobs (locks in the split-divided time)
      for (const job of sorted) {
        try {
          const ev = await pauseJob(employee.employee_id, job.job_id)
          appendEvent(job.job_id, ev)
        } catch (err) { console.error(err) }
      }

      // Resume only the keeper at full rate (split_count=1)
      try {
        const tag = getLastTag(keeper.events)
        const ev  = await resumeJob(employee.employee_id, keeper.job_id, tag.activity_type, tag.work_type, 1)
        appendEvent(keeper.job_id, ev)
      } catch (err) { console.error(err) }
    }
  }

  function handleLogout() { onLogout() }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      const val = bufferRef.current.trim()
      bufferRef.current = ''
      if (e.target) e.target.value = ''
      if (val) handleJobScan(val)
    }
  }

  function handleInput(e) { bufferRef.current = e.target.value }

  return (
    <div className="flex flex-col min-h-screen">

      {/* Header */}
      <div className="bg-stone-900 border-b border-stone-700 px-5 py-4 flex items-center justify-between shrink-0 gap-3">
        <div className="min-w-0">
          <p className="text-xs text-stone-500 uppercase tracking-widest">Logged in</p>
          <p className="text-xl font-bold text-stone-100 truncate">{employee.full_name}</p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleSplitToggle}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-sm font-semibold transition-colors ${
              splitMode
                ? 'bg-sky-500/20 border-sky-500 text-sky-400'
                : 'bg-stone-800 border-stone-600 text-stone-400'
            }`}
          >
            <span className="text-base leading-none">⚡</span>
            <span>
              Split
              {splitMode && activeCount > 1 && (
                <span className="ml-1 text-sky-300">÷{activeCount}</span>
              )}
            </span>
          </button>

          <button className="btn-danger px-5 py-3 text-base" onClick={handleLogout}>
            Done →
          </button>
        </div>
      </div>

      {/* Split mode banner */}
      {splitMode && (
        <div className="bg-sky-900/40 border-b border-sky-700 px-5 py-2 shrink-0">
          <p className="text-sky-300 text-sm font-medium text-center">
            ⚡ Split mode on — new jobs run alongside existing ones, time divided equally
          </p>
        </div>
      )}

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
            inputMode="none"
            className="w-full bg-stone-900 border-2 border-stone-600 focus:border-amber-500
                       rounded-xl px-4 py-3 text-stone-100 text-lg outline-none
                       transition-colors placeholder-stone-600"
            placeholder={scanning ? 'Looking up job…' : '▌ Ready to scan'}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
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
            <p className="text-4xl mb-4">📋</p>
            <p className="text-lg">No active jobs.</p>
            <p className="text-sm mt-1">Scan a job barcode above to get started.</p>
          </div>
        ) : (
          jobs.map(job => (
            <JobCard
              key={job.job_id}
              job={job}
              breakRules={breakRules}
              splitMode={splitMode}
              allJobs={jobs}
              onPause={handlePause}
              onResume={handleResumeClick}
              onEdit={handleEditClick}
              onComplete={handleCompleteClick}
              onAlert={j => setModal({ type: 'alert', job: j })}
            />
          ))
        )}
      </div>

      {/* Manual entry modal */}
      {showManual && (
        <ManualScanModal
          onSubmit={v => { setShowManual(false); handleJobScan(v) }}
          onCancel={() => setShowManual(false)}
        />
      )}

      {/* Modals */}
      {modal?.type === 'already_complete' && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-4">
          <div className="bg-stone-800 border border-stone-600 rounded-2xl p-6 w-full max-w-sm text-center">
            <p className="text-2xl mb-3">⚠️</p>
            <h2 className="text-lg font-bold text-stone-100 mb-2">Already Completed</h2>
            <p className="text-stone-400 text-sm mb-1">PO <strong className="text-stone-200">{modal.job.po_number}</strong></p>
            <p className="text-stone-400 text-sm mb-5">Part <strong className="text-stone-200">{modal.job.part_number}</strong></p>
            <p className="text-stone-400 text-sm mb-6">You've already completed this job. Do you want to continue working on it? Your previous time will be kept.</p>
            <div className="flex gap-3">
              <button className="flex-1 btn-secondary py-3" onClick={() => setModal(null)}>Cancel</button>
              <button className="flex-1 btn-green py-3" onClick={() => {
                const { job } = modal
                setModal({ type: 'job_action', action: 'start', jobId: job.job_id, wasCreated: false, job })
              }}>Continue</button>
            </div>
          </div>
        </div>
      )}
      {modal?.type === 'job_action' && (
        <JobActionModal
          onConfirm={handleActionConfirm}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.type === 'confirm' && (
        <ConfirmModal
          job={modal.job}
          onConfirm={handleCompleteConfirm}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.type === 'alert' && (
        <AlertModal
          context={`Weld Shop · PO ${modal.job.po_number} · ${modal.job.part_number}`}
          onSend={async (message) => {
            await sendJobAlert({
              jobId:        modal.job.job_id,
              employeeId:   employee.employee_id,
              lineId:       null,
              poNumber:     modal.job.po_number,
              partNumber:   modal.job.part_number,
              message,
              employeeName: employee.full_name,
              lineName:     'Weld Shop',
            })
          }}
          onCancel={() => setModal(null)}
        />
      )}
    </div>
  )
}
