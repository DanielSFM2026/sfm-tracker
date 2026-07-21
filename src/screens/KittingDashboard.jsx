import { useCallback, useEffect, useRef, useState } from 'react'
import { findOrCreateJob, setJobStatus, completeJob, cancelMyJob } from '../lib/db'
import { parseJobBarcode, formatDuration } from '../lib/timeCalc'
import { supabase } from '../lib/supabase'
import WeeklyPlanPanel from '../components/WeeklyPlanPanel'
import { jobKey } from '../lib/plan'

const INACTIVITY_MS = 120_000

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

function ConfirmCompleteModal({ job, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl p-8 w-full max-w-sm text-center">
        <p className="text-3xl mb-3">✓</p>
        <h2 className="text-xl font-bold text-stone-100 mb-1">Mark Kit Complete?</h2>
        <p className="text-stone-400 text-sm mb-1">PO <strong className="text-stone-200">{job.po_number}</strong></p>
        <p className="text-stone-400 text-sm mb-6">Part <strong className="text-stone-200">{job.part_number}</strong></p>
        <div className="flex gap-3">
          <button className="flex-1 btn-secondary py-3" onClick={onCancel}>Back</button>
          <button className="flex-1 btn-green py-3" onClick={onConfirm}>Complete ✓</button>
        </div>
      </div>
    </div>
  )
}

function KitCard({ job, onComplete, onCancel }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const elapsed = job.startedAt ? now - new Date(job.startedAt).getTime() : 0

  return (
    <div className="bg-stone-800 border border-stone-700 rounded-2xl p-5 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-xs text-stone-500 uppercase tracking-widest">PO</p>
        <p className="text-xl font-bold text-stone-100 break-all">{job.po_number}</p>
        <p className="text-sm text-stone-400 break-all">{job.part_number}</p>
        {job.quantity != null && (
          <p className="text-sm text-stone-500 mt-0.5">Qty: {job.quantity}</p>
        )}
      </div>
      <div className="flex flex-col items-end gap-3 shrink-0">
        {elapsed > 0 && (
          <span className="text-amber-400 font-mono text-lg font-semibold tabular-nums">
            {formatDuration(elapsed)}
          </span>
        )}
        <div className="flex gap-2">
          <button
            onClick={() => onCancel(job)}
            title="Wrong scan — remove this kit"
            className="px-4 py-3 rounded-xl border border-red-900/60 bg-red-950/20 text-red-400 hover:bg-red-950/40 text-base">
            ✕
          </button>
          <button
            onClick={() => onComplete(job)}
            className="btn-green px-5 py-3 text-base">
            ✓ Done
          </button>
        </div>
      </div>
    </div>
  )
}

export default function KittingDashboard({ employee, onLogout }) {
  const [jobs, setJobs]     = useState([])
  const [modal, setModal]   = useState(null)
  const [error, setError]   = useState('')
  const [scanning, setScanning] = useState(false)
  const [showManual, setShowManual] = useState(false)
  const [showPlan, setShowPlan]     = useState(false)

  const scanRef   = useRef(null)
  const bufRef    = useRef('')
  const inactRef  = useRef(null)

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

  // Load any kitting jobs currently in_progress for this employee
  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('job_events')
        .select('job_id, event_type, event_timestamp, jobs(job_id, po_number, part_number, quantity, status)')
        .eq('employee_id', employee.employee_id)
        .eq('jobs.department', 'kitting')
        .in('event_type', ['START', 'COMPLETE'])
        .order('event_timestamp', { ascending: true })

      if (!data) return
      const seen = new Map()
      for (const row of data) {
        if (!row.jobs) continue
        const prev = seen.get(row.job_id)
        seen.set(row.job_id, {
          job: row.jobs,
          lastEvent: row.event_type,
          startedAt: prev?.startedAt ?? (row.event_type === 'START' ? row.event_timestamp : null),
        })
      }
      setJobs([...seen.values()]
        .filter(({ lastEvent }) => lastEvent !== 'COMPLETE')
        .map(({ job, startedAt }) => ({ ...job, startedAt }))
      )
    }
    load().catch(console.error)
  }, [employee.employee_id])

  useEffect(() => { scanRef.current?.focus() }, [])
  useEffect(() => { if (!modal) scanRef.current?.focus() }, [modal])

  async function handleScan(raw) {
    const parsed = parseJobBarcode(raw)
    if (!parsed) { setError(`Could not parse: "${raw}". Expected PO/PART`); return }
    addKit(parsed.poNumber, parsed.partNumber)
  }

  // Shared by the scanner and the Weekly Plan picker
  async function addKit(poNumber, partNumber) {
    setScanning(true); setError('')
    try {
      const { job } = await findOrCreateJob(poNumber, partNumber, 'kitting')
      if (jobs.find(j => j.job_id === job.job_id)) {
        setError(`${poNumber} is already on your list.`)
        return
      }
      // Record that this person picked up the kit
      await supabase.from('job_events').insert({
        employee_id: employee.employee_id,
        job_id: job.job_id,
        event_type: 'START',
        event_timestamp: new Date().toISOString(),
      })
      await setJobStatus(job.job_id, 'in_progress')
      setJobs(prev => [...prev, { ...job, startedAt: new Date().toISOString() }])
    } catch (err) {
      console.error(err)
      setError('Failed to look up job — check connection.')
    } finally {
      setScanning(false)
    }
  }

  async function handleCompleteConfirm() {
    const { job } = modal
    setModal(null)
    try {
      await completeJob(employee.employee_id, job.job_id)
      setJobs(prev => prev.filter(j => j.job_id !== job.job_id))
    } catch (err) {
      console.error(err)
      setError('Complete failed — check connection.')
    }
  }

  async function handleCancelJobConfirm() {
    const { job } = modal
    setModal(null)
    try {
      await cancelMyJob(job.job_id, employee.employee_id)
      setJobs(prev => prev.filter(j => j.job_id !== job.job_id))
    } catch (err) {
      console.error(err)
      setError('Cancel failed — check connection.')
    }
  }

  return (
    <div className="flex flex-col min-h-screen">

      {/* Header */}
      <div className="bg-stone-900 border-b border-stone-700 px-5 py-4 flex items-center justify-between shrink-0 gap-3">
        <div className="min-w-0">
          <p className="text-xs text-stone-500 uppercase tracking-widest">Kitting</p>
          <p className="text-xl font-bold text-stone-100">{employee.full_name}</p>
        </div>
        <button className="btn-danger px-5 py-3 text-base" onClick={onLogout}>
          Done →
        </button>
      </div>

      {/* Scan input */}
      <div className="bg-stone-800 border-b border-stone-700 px-5 py-4 shrink-0">
        <button onClick={() => setShowPlan(true)}
          className="w-full mb-4 py-4 rounded-2xl bg-amber-500 hover:bg-amber-400 active:scale-[0.99]
                     text-stone-950 font-extrabold text-lg flex items-center justify-center gap-2 transition-all
                     shadow-lg shadow-amber-500/10">
          📋 Weekly Plan
        </button>
        <div className="flex items-center justify-between mb-2 gap-2">
          <p className="text-xs text-stone-500 uppercase tracking-widest">Or scan barcode to add kit</p>
          <button onClick={() => setShowManual(true)} className="text-xs text-stone-500 hover:text-stone-300 underline">
            ⌨ Type manually
          </button>
        </div>
        <div className="relative">
          <input
            ref={scanRef}
            type="text"
            className="w-full bg-stone-900 border-2 border-stone-600 focus:border-amber-500
                       rounded-xl px-4 py-3 text-stone-100 text-lg outline-none
                       transition-colors placeholder-stone-600"
            placeholder={scanning ? 'Looking up…' : '▌ Ready to scan'}
            inputMode="none"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            readOnly={scanning}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const val = bufRef.current.trim()
                bufRef.current = ''
                if (e.target) e.target.value = ''
                if (val) handleScan(val)
              }
            }}
            onInput={e => { bufRef.current = e.target.value }}
          />
          {scanning && (
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-amber-400 animate-pulse">…</span>
          )}
        </div>
        {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
      </div>

      {/* Kit list */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {jobs.length === 0 ? (
          <div className="text-center py-16 text-stone-600">
            <p className="text-4xl mb-4">📦</p>
            <p className="text-lg">No kits in progress.</p>
            <p className="text-sm mt-1">Scan a barcode above to add one.</p>
          </div>
        ) : (
          jobs.map(job => (
            <KitCard key={job.job_id} job={job}
              onComplete={job => setModal({ job })}
              onCancel={job => setModal({ job, cancel: true })} />
          ))
        )}
      </div>

      {showManual && (
        <ManualScanModal
          onSubmit={v => { setShowManual(false); handleScan(v) }}
          onCancel={() => setShowManual(false)}
        />
      )}
      {showPlan && (
        <WeeklyPlanPanel
          department="kitting"
          title="Kitting"
          operatorName={employee.full_name}
          activeKeys={new Set(jobs.map(j => jobKey(j.po_number, j.part_number)))}
          onPick={(po, part) => { setShowPlan(false); addKit(po, part) }}
          onClose={() => setShowPlan(false)}
        />
      )}
      {modal && !modal.cancel && (
        <ConfirmCompleteModal
          job={modal.job}
          onConfirm={handleCompleteConfirm}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.cancel && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
          <div className="bg-stone-800 border border-stone-600 rounded-2xl p-8 w-full max-w-sm text-center">
            <h2 className="text-xl font-bold text-stone-100 mb-2">Remove This Kit?</h2>
            <p className="text-stone-400 text-sm mb-1">PO <strong className="text-stone-200">{modal.job.po_number}</strong></p>
            <p className="text-stone-400 text-sm mb-5">{modal.job.part_number}</p>
            <p className="text-stone-500 text-sm mb-6">
              Use this for a wrong scan — your time on it is discarded, not counted.
            </p>
            <div className="flex gap-3">
              <button className="btn-ghost flex-1" onClick={() => setModal(null)}>Back</button>
              <button
                className="flex-1 py-3 rounded-xl bg-red-600/30 border border-red-600 text-red-200 font-semibold"
                onClick={handleCancelJobConfirm}>
                Remove ✕
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
