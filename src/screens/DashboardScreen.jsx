import { useCallback, useEffect, useRef, useState } from 'react'
import {
  findOrCreateJob,
  startNewJob,
  pauseJob,
  resumeJob,
  completeJob
} from '../lib/db'
import { isJobActive, getOpenStart, parseJobBarcode } from '../lib/timeCalc'
import JobCard from '../components/JobCard'

const INACTIVITY_TIMEOUT_MS = 75_000 // 75 seconds

// ── Two-step action modal (Activity → Work type) ─────────────────────────────
function JobActionModal({ onConfirm, onCancel }) {
  const [step, setStep]             = useState(1)
  const [activityType, setActivity] = useState(null)

  function pickActivity(type) {
    setActivity(type)
    setStep(2)
  }

  function pickWorkType(workType) {
    onConfirm({ activityType, workType })
  }

  const activityLabel = { tack: 'Tack', weld: 'Weld', tack_weld: 'Tack & Weld' }

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl p-8 w-full max-w-sm">
        {step === 1 ? (
          <>
            <h2 className="text-2xl font-bold text-stone-100 mb-1 text-center">
              What are you doing?
            </h2>
            <p className="text-stone-400 text-center text-sm mb-6">Step 1 of 2</p>
            <div className="flex flex-col gap-4">
              <button className="btn-primary  text-xl py-5" onClick={() => pickActivity('tack')}>
                Tack
              </button>
              <button className="btn-secondary text-xl py-5" onClick={() => pickActivity('weld')}>
                Weld
              </button>
              <button className="btn-ghost    text-xl py-5" onClick={() => pickActivity('tack_weld')}>
                Tack &amp; Weld
              </button>
              <button className="btn-ghost mt-1" onClick={onCancel}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-2xl font-bold text-stone-100 mb-1 text-center">
              Working on?
            </h2>
            <p className="text-stone-400 text-center text-sm mb-6">
              Step 2 of 2 &nbsp;·&nbsp;
              <span className="text-amber-400">{activityLabel[activityType]}</span>
            </p>
            <div className="flex flex-col gap-4">
              <button className="btn-primary  text-xl py-5" onClick={() => pickWorkType('parts')}>
                Parts
              </button>
              <button className="btn-secondary text-xl py-5" onClick={() => pickWorkType('frames')}>
                Frames
              </button>
              <button className="btn-ghost    text-xl py-5" onClick={() => pickWorkType('parts_frames')}>
                Parts &amp; Frames
              </button>
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
  const [error, setError]       = useState('')
  const [scanning, setScanning] = useState(false)
  const [modal, setModal]       = useState(null)

  const scanInputRef  = useRef(null)
  const bufferRef     = useRef('')
  const inactivityRef = useRef(null)

  const activeJobId  = jobs.find(j => isJobActive(j.events))?.job_id ?? null
  const activeJobIds = jobs.filter(j => isJobActive(j.events)).map(j => j.job_id)

  // Ref so inactivity callback always sees the current set of active jobs
  const activeJobIdsRef = useRef(activeJobIds)
  useEffect(() => { activeJobIdsRef.current = activeJobIds }, [jobs])

  const activeCount = jobs.filter(j => isJobActive(j.events)).length

  // ── Inactivity timer ────────────────────────────────────────────────────────
  const resetInactivity = useCallback(() => {
    if (inactivityRef.current) clearTimeout(inactivityRef.current)
    inactivityRef.current = setTimeout(() => {
      // Just reset the screen — jobs keep running until welder manually pauses
      onLogout()
    }, INACTIVITY_TIMEOUT_MS)
  }, [employee.employee_id, onLogout])

  useEffect(() => {
    resetInactivity()
    const evts = ['touchstart', 'mousedown', 'keydown']
    evts.forEach(ev => window.addEventListener(ev, resetInactivity, { passive: true }))
    return () => {
      if (inactivityRef.current) clearTimeout(inactivityRef.current)
      evts.forEach(ev => window.removeEventListener(ev, resetInactivity))
    }
  }, [resetInactivity])

  useEffect(() => {
    if (!modal && scanInputRef.current) scanInputRef.current.focus()
  }, [modal])

  // ── Local state helpers ─────────────────────────────────────────────────────
  function appendEvent(jobId, eventData) {
    setJobs(prev =>
      prev.map(j =>
        j.job_id === jobId ? { ...j, events: [...j.events, eventData] } : j
      )
    )
  }

  // Pauses whichever job is currently active (used in normal mode only)
  async function pauseActive() {
    if (!activeJobId) return
    const ev = await pauseJob(employee.employee_id, activeJobId)
    appendEvent(activeJobId, ev)
  }

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
        // Pause and re-resume with corrected types (always single-job operation)
        const pauseEv  = await pauseJob(employee.employee_id, jobId)
        appendEvent(jobId, pauseEv)
        const resumeEv = await resumeJob(employee.employee_id, jobId, activityType, workType)
        appendEvent(jobId, resumeEv)

      } else if (action === 'start') {
        // In normal mode, pause whatever is currently active first
        if (!splitMode) await pauseActive()
        const events = await startNewJob(
          employee.employee_id, jobId, wasCreated, activityType, workType
        )
        setJobs(prev => [...prev, { ...newJob, events }])

      } else {
        // resume — in normal mode pause current first; in split mode just resume alongside
        if (!splitMode) await pauseActive()
        const ev = await resumeJob(employee.employee_id, jobId, activityType, workType)
        appendEvent(jobId, ev)
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
      // Turning split OFF — pause all active jobs except the most recently started
      const activeJobs = jobs.filter(j => isJobActive(j.events))
      if (activeJobs.length > 1) {
        // Sort by when each job's current interval started (most recent first)
        const sorted = activeJobs
          .map(j => {
            const last = [...j.events]
              .filter(e => e.event_type === 'START' || e.event_type === 'RESUME')
              .sort((a, b) => new Date(b.event_timestamp) - new Date(a.event_timestamp))[0]
            return { jobId: j.job_id, t: new Date(last.event_timestamp) }
          })
          .sort((a, b) => b.t - a.t)

        // Pause everything except the most recently started
        for (const { jobId } of sorted.slice(1)) {
          try {
            const ev = await pauseJob(employee.employee_id, jobId)
            appendEvent(jobId, ev)
          } catch (err) {
            console.error(err)
          }
        }
      }
    }
  }

  // ── Explicit logout ─────────────────────────────────────────────────────────
  function handleLogout() {
    // Just reset the screen — jobs keep running until welder manually pauses
    onLogout()
  }

  // ── Scanner input ───────────────────────────────────────────────────────────
  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      const val = bufferRef.current.trim()
      bufferRef.current = ''
      if (e.target) e.target.value = ''
      if (val) handleJobScan(val)
    }
  }

  function handleInput(e) {
    bufferRef.current = e.target.value
  }

  return (
    <div className="flex flex-col min-h-screen">

      {/* Header */}
      <div className="bg-stone-900 border-b border-stone-700 px-5 py-4 flex items-center justify-between shrink-0 gap-3">
        <div className="min-w-0">
          <p className="text-xs text-stone-500 uppercase tracking-widest">Logged in</p>
          <p className="text-xl font-bold text-stone-100 truncate">{employee.full_name}</p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Split mode toggle */}
          <button
            onClick={handleSplitToggle}
            className={`flex items-center gap-2 px-4 py-3 rounded-xl border text-sm font-semibold transition-colors ${
              splitMode
                ? 'bg-sky-500/20 border-sky-500 text-sky-400'
                : 'bg-stone-800 border-stone-600 text-stone-400'
            }`}
          >
            <span className="text-lg leading-none">⚡</span>
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
        <p className="text-xs text-stone-500 uppercase tracking-widest mb-2">
          Scan a job barcode to start or add a job
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
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            readOnly={scanning}
            style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
          />
          {scanning && (
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-amber-400 animate-pulse">
              …
            </span>
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
            />
          ))
        )}
      </div>

      {/* Modals */}
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
    </div>
  )
}
