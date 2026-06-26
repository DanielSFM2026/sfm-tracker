import { useCallback, useEffect, useRef, useState } from 'react'
import { loadWorkerJobs, addTeamMemberToJob, removeTeamMemberFromJob } from '../lib/db'
import { calcElapsed, formatDuration, isJobActive } from '../lib/timeCalc'

const INACTIVITY_MS = 120_000

export default function AssemblyWorkerScreen({ employee, breakRules, onLogout }) {
  const [jobs, setJobs]   = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const inactRef = useRef(null)

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
    loadWorkerJobs(employee.employee_id)
      .then(setJobs)
      .catch(err => { console.error(err); setError('Could not load jobs.') })
      .finally(() => setLoading(false))
  }, [employee.employee_id])

  async function handleClockOff(job) {
    try {
      const ev = await removeTeamMemberFromJob(employee.employee_id, job.job_id, job.line_id)
      setJobs(prev => prev.map(j =>
        j.job_id === job.job_id
          ? { ...j, events: [...j.events, { ...ev, split_count: 1 }] }
          : j
      ))
    } catch (err) {
      console.error(err)
      setError('Clock off failed — check connection.')
    }
  }

  async function handleClockOn(job) {
    try {
      const ev = await addTeamMemberToJob(employee.employee_id, job.job_id, job.line_id)
      setJobs(prev => prev.map(j =>
        j.job_id === job.job_id
          ? { ...j, events: [...j.events, { ...ev, split_count: 1 }] }
          : j
      ))
    } catch (err) {
      console.error(err)
      setError('Clock on failed — check connection.')
    }
  }

  return (
    <div className="flex flex-col min-h-screen bg-stone-950">

      {/* Header */}
      <div className="bg-stone-900 border-b border-stone-700 px-5 py-4 flex items-center justify-between shrink-0">
        <div>
          <p className="text-xs text-stone-500 uppercase tracking-widest">Assembly</p>
          <p className="text-xl font-bold text-stone-100">{employee.full_name}</p>
        </div>
        <button className="btn-danger px-4 py-2.5 text-sm" onClick={onLogout}>
          ✕ Done
        </button>
      </div>

      {/* Info banner */}
      <div className="bg-amber-500/10 border-b border-amber-500/20 px-5 py-3">
        <p className="text-xs text-amber-400 text-center">
          Your time is managed by your Line Manager · Clock off below if leaving early
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-5 space-y-4">

        {loading && (
          <p className="text-center text-stone-600 py-10 animate-pulse">Loading…</p>
        )}

        {error && (
          <div className="bg-red-900/40 border border-red-700 rounded-xl px-4 py-3 text-red-300 text-sm text-center">
            {error}
          </div>
        )}

        {!loading && jobs.length === 0 && (
          <div className="text-center py-16">
            <p className="text-4xl mb-4">🏭</p>
            <p className="text-stone-400 font-semibold">No active jobs</p>
            <p className="text-stone-600 text-sm mt-1">Your Line Manager will assign you to a job</p>
          </div>
        )}

        {jobs.map(job => (
          <WorkerJobCard
            key={job.job_id}
            job={job}
            breakRules={breakRules}
            onClockOff={() => handleClockOff(job)}
            onClockOn={() => handleClockOn(job)}
          />
        ))}
      </div>
    </div>
  )
}

function WorkerJobCard({ job, breakRules, onClockOff, onClockOn }) {
  const active = isJobActive(job.events)

  function compute() { return calcElapsed(job.events, breakRules) }
  const [elapsed, setElapsed] = useState(compute)

  useEffect(() => {
    setElapsed(compute())
    if (!active) return
    const id = setInterval(() => setElapsed(compute()), 1000)
    return () => clearInterval(id)
  }, [active, job.events, breakRules])

  return (
    <div className={`rounded-2xl p-5 border-2 transition-colors ${
      active ? 'bg-stone-800 border-amber-500' : 'border-stone-700 bg-stone-900'
    }`}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <p className="text-xs text-stone-500 uppercase tracking-widest">PO</p>
          <p className="text-xl font-bold text-stone-100">{job.po_number}</p>
          <p className="text-sm text-stone-400">{job.part_number}</p>
          {job.quantity != null && (
            <p className="text-sm text-stone-500">Qty: {job.quantity}</p>
          )}
        </div>
        <div className="text-right shrink-0">
          <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold uppercase mb-2 ${
            active ? 'bg-amber-500/20 text-amber-400' : 'bg-stone-700 text-stone-400'
          }`}>
            {active ? 'Clocked On' : 'Clocked Off'}
          </span>
          <p className={`text-2xl font-mono font-bold ${active ? 'text-amber-400' : 'text-stone-500'}`}>
            {formatDuration(elapsed)}
          </p>
          <p className="text-xs text-stone-600 mt-0.5">My time</p>
        </div>
      </div>

      {active ? (
        <button
          className="btn-secondary w-full py-3 text-base"
          onClick={onClockOff}
        >
          ⏸ Clock Off
        </button>
      ) : (
        <button
          className="btn-primary w-full py-3 text-base"
          onClick={onClockOn}
        >
          ▶ Clock Back On
        </button>
      )}
    </div>
  )
}
