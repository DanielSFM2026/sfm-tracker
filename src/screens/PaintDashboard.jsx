import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createPaintBatch,
  loadActivePaintBatch,
  loadAvailablePaintBatches,
  loadAvailablePoolJobs,
  getBoothStatus,
  joinOrCreatePrepBooth,
  addJobToPaintBatch,
  removeJobFromPaintBatch,
  getPaintBatchStartTime,
  startPaintBatchStage,
  completePaintBatchStage,
  addBatchMember,
  addActiveBatchMember,
  findTeamMember,
} from '../lib/db'
import { parseJobBarcode, formatDuration } from '../lib/timeCalc'

const INACTIVITY_MS = 75_000

const STAGE_LABEL   = { blast: 'Blast', prep: 'Prep', paint: 'Paint', pack: 'Pack' }
const STAGE_COLOUR  = { blast: 'text-orange-400', prep: 'text-yellow-400', paint: 'text-red-400', pack: 'text-emerald-400' }
const STAGE_BORDER  = { blast: 'border-orange-500', prep: 'border-yellow-500', paint: 'border-red-500', pack: 'border-emerald-500' }
const STAGE_BG      = { blast: 'bg-orange-500/10', prep: 'bg-yellow-500/10', paint: 'bg-red-500/10', pack: 'bg-emerald-500/10' }
const PREV_LABEL    = { prep: 'Blast', paint: 'Prep', pack: 'Paint' }
const WORK_LABEL    = { parts: 'Parts', frames: 'Frames', parts_frames: 'Parts & Frames' }

// ── Shared: Work type modal ───────────────────────────────────────────────────
function WorkTypeModal({ onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl p-8 w-full max-w-sm">
        <h2 className="text-2xl font-bold text-stone-100 mb-6 text-center">Working on?</h2>
        <div className="flex flex-col gap-4">
          <button className="btn-primary  text-xl py-5" onClick={() => onConfirm('parts')}>Parts</button>
          <button className="btn-secondary text-xl py-5" onClick={() => onConfirm('frames')}>Frames</button>
          <button className="btn-ghost    text-xl py-5" onClick={() => onConfirm('parts_frames')}>Parts &amp; Frames</button>
          <button className="btn-ghost mt-1" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ── Shared: Manual scan modal ─────────────────────────────────────────────────
function ManualScanModal({ title, placeholder, onSubmit, onCancel }) {
  const [val, setVal] = useState('')
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl p-8 w-full max-w-sm">
        <h2 className="text-xl font-bold text-stone-100 mb-4 text-center">{title}</h2>
        <input
          autoFocus
          type="text"
          className="w-full bg-stone-900 border-2 border-stone-600 focus:border-amber-500
                     rounded-xl px-4 py-3 text-stone-100 text-lg outline-none mb-4"
          placeholder={placeholder}
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

// ── Shared: Confirm modal ─────────────────────────────────────────────────────
function ConfirmModal({ title, message, confirmLabel = 'Confirm', onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl p-8 w-full max-w-sm text-center">
        <h2 className="text-xl font-bold text-stone-100 mb-3">{title}</h2>
        {message && <p className="text-stone-400 text-sm mb-6">{message}</p>}
        <div className="flex gap-3">
          <button className="btn-ghost flex-1" onClick={onCancel}>Cancel</button>
          <button className="btn-green flex-1" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}

// ── Booth picker modal ────────────────────────────────────────────────────────
function BoothPickerModal({ boothStatus, selectedCount, onPick, onCancel }) {
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl p-8 w-full max-w-sm">
        <h2 className="text-2xl font-bold text-stone-100 mb-2 text-center">Which Booth?</h2>
        <p className="text-stone-500 text-sm text-center mb-6">Loading {selectedCount} job{selectedCount !== 1 ? 's' : ''} into…</p>
        <div className="flex flex-col gap-3">
          {[1, 2, 3].map(n => {
            const b = boothStatus[n]
            const jobCount = b?.paint_batch_jobs?.[0]?.count ?? 0
            const members  = b?.paint_batch_members ?? []
            return (
              <button key={n} onClick={() => onPick(n)}
                className={`rounded-2xl border-2 px-5 py-4 text-left transition-colors
                  ${b ? 'border-yellow-500 bg-yellow-500/10 hover:bg-yellow-500/20' : 'border-stone-600 bg-stone-900 hover:border-yellow-400'}`}>
                <div className="flex items-center justify-between">
                  <p className="text-xl font-bold text-stone-100">Booth {n}</p>
                  {b ? (
                    <span className="text-yellow-400 text-sm font-semibold">{jobCount} job{jobCount !== 1 ? 's' : ''} loading</span>
                  ) : (
                    <span className="text-stone-500 text-sm">Empty</span>
                  )}
                </div>
                {members.length > 0 && (
                  <p className="text-xs text-stone-500 mt-1">{members.map(m => m.employees?.full_name).join(', ')}</p>
                )}
              </button>
            )
          })}
        </div>
        <button className="btn-ghost w-full mt-4" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

// ── Shared: Job list ──────────────────────────────────────────────────────────
function JobList({ jobs, onRemove }) {
  if (!jobs.length) return <p className="text-stone-600 text-sm text-center py-4">No jobs scanned yet</p>
  return (
    <div className="space-y-2">
      {jobs.map(bj => {
        const j = bj.jobs ?? bj
        return (
          <div key={bj.job_id ?? j.job_id} className="flex items-center gap-3 bg-stone-900 rounded-xl px-4 py-3">
            <div className="flex-1 min-w-0">
              <p className="text-stone-100 font-semibold truncate">{j.po_number}</p>
              <p className="text-xs text-stone-500 truncate">Part: {j.part_number}</p>
              {bj.work_type && <p className="text-xs text-red-400 mt-0.5">{WORK_LABEL[bj.work_type]}</p>}
            </div>
            {onRemove && (
              <button onClick={() => onRemove(bj.job_id ?? j.job_id)}
                className="text-stone-600 hover:text-red-400 text-2xl leading-none px-1">×</button>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Shared: Team member chips ─────────────────────────────────────────────────
function TeamChips({ members }) {
  if (!members.length) return <p className="text-stone-600 text-sm py-1">No team members added yet</p>
  return (
    <div className="flex flex-wrap gap-2">
      {members.map(m => (
        <span key={m.employee_id}
          className="bg-stone-700 text-stone-200 text-sm px-3 py-1.5 rounded-full">
          {m.full_name ?? m.employees?.full_name}
        </span>
      ))}
    </div>
  )
}

// ── Shared: Scan input bar ────────────────────────────────────────────────────
function ScanBar({ scanRef, bufRef, onScan, scanning, label, onManual }) {
  useEffect(() => { scanRef.current?.focus() }, [])
  return (
    <div className="bg-stone-800 border-b border-stone-700 px-5 py-4 shrink-0">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-stone-500 uppercase tracking-widest">{label}</p>
        {onManual && (
          <button onClick={onManual} className="text-xs text-stone-500 hover:text-stone-300 underline">
            ⌨ Type manually
          </button>
        )}
      </div>
      <div className="relative">
        <input
          ref={scanRef}
          type="text"
          inputMode="none"
          className="w-full bg-stone-900 border-2 border-stone-600 focus:border-amber-500
                     rounded-xl px-4 py-3 text-stone-100 text-lg outline-none
                     transition-colors placeholder-stone-600"
          placeholder={scanning ? 'Looking up…' : '▌ Ready to scan'}
          autoComplete="off" autoCorrect="off" spellCheck={false}
          readOnly={scanning}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              const v = bufRef.current.trim()
              bufRef.current = ''
              if (e.target) e.target.value = ''
              if (v) onScan(v)
            }
          }}
          onInput={e => { bufRef.current = e.target.value }}
        />
        {scanning && <span className="absolute right-4 top-1/2 -translate-y-1/2 text-amber-400 animate-pulse">…</span>}
      </div>
    </div>
  )
}

// ── Live timer hook ───────────────────────────────────────────────────────────
function useElapsed(startedAt) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!startedAt) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startedAt])
  return startedAt ? now - new Date(startedAt).getTime() : 0
}

// ── Available batch card (for queue view) ─────────────────────────────────────
function AvailableBatchCard({ batch, prevStage, onClaim }) {
  const jobs = batch.paint_batch_jobs ?? []
  return (
    <div className="bg-stone-800 border border-stone-700 rounded-2xl p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <p className="text-xs text-stone-500 uppercase tracking-widest mb-1">
            {batch.booth_number ? `Booth ${batch.booth_number}` : `Batch #${batch.batch_number}`}
            {' · from '}{STAGE_LABEL[prevStage] ?? prevStage}
          </p>
          <p className="text-stone-400 text-sm">{jobs.length} job{jobs.length !== 1 ? 's' : ''}</p>
        </div>
        <button className="btn-primary px-5 py-2 shrink-0" onClick={() => onClaim(batch)}>
          Pick Up →
        </button>
      </div>
      <div className="space-y-1.5">
        {jobs.map(bj => (
          <div key={bj.job_id} className="flex items-center gap-2 text-sm">
            <span className="text-stone-300 font-medium">{bj.jobs?.po_number}</span>
            <span className="text-stone-600">·</span>
            <span className="text-stone-500">{bj.jobs?.part_number}</span>
            {bj.work_type && <span className="text-red-400 text-xs ml-auto">{WORK_LABEL[bj.work_type]}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Active batch panel (timer + complete button) ──────────────────────────────
function ActiveBatchPanel({ batch, jobs: jobsProp, stage, startedAt, team, onComplete, onAddMember }) {
  const elapsed  = useElapsed(startedAt)
  const colour   = STAGE_COLOUR[stage]
  const border   = STAGE_BORDER[stage]
  const bg       = STAGE_BG[stage]
  const jobs     = jobsProp ?? batch.paint_batch_jobs ?? []
  const teamSize = Math.max(1, team.length)
  const [scanning, setScanning] = useState(false)
  const [scanErr,  setScanErr]  = useState('')

  async function handleBadgeScan(raw) {
    setScanning(true); setScanErr('')
    try {
      const member = await findTeamMember(raw)
      if (!member) { setScanErr(`Badge not recognised: "${raw}"`); return }
      if (team.find(m => m.employee_id === member.employee_id)) { setScanErr(`${member.full_name} already on team.`); return }
      await addActiveBatchMember(batch.batch_id, member.employee_id, stage, jobs)
      onAddMember(member)
    } catch { setScanErr('Could not look up badge — check connection.') }
    finally { setScanning(false) }
  }

  return (
    <div className={`rounded-2xl border-2 ${border} overflow-hidden`}>
      <div className={`${bg} px-5 py-3 flex items-center justify-between`}>
        <div>
          <p className={`text-xs font-semibold uppercase tracking-widest ${colour}`}>
            {STAGE_LABEL[stage]} · {batch.booth_number ? `Booth ${batch.booth_number}` : `Batch #${batch.batch_number}`}
          </p>
          <p className="text-stone-400 text-sm mt-0.5">
            {jobs.length} job{jobs.length !== 1 ? 's' : ''} · {teamSize} worker{teamSize !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="text-right">
          <p className={`text-3xl font-mono font-bold tabular-nums ${colour}`}>
            {formatDuration(elapsed * teamSize)}
          </p>
          {teamSize > 1 && (
            <p className="text-xs text-stone-500 mt-0.5">{formatDuration(elapsed)} × {teamSize}</p>
          )}
        </div>
      </div>

      <div className="bg-stone-800 px-5 py-4 space-y-4">
        <JobList jobs={jobs} />

        <div>
          <p className="text-xs text-stone-500 uppercase tracking-widest mb-2">Team</p>
          <TeamChips members={team} />
          {scanErr && <p className="text-red-400 text-xs mt-2">{scanErr}</p>}
          <TeamBadgeScan
            team={team}
            onScan={handleBadgeScan}
            scanning={scanning}
            accentClass={`focus:border-${stage === 'blast' ? 'orange' : stage === 'prep' ? 'yellow' : stage === 'paint' ? 'red' : 'emerald'}-400`}
          />
        </div>

        <button className="btn-green w-full py-4 text-lg mt-2" onClick={onComplete}>
          ✓ Complete {STAGE_LABEL[stage]}
        </button>
      </div>
    </div>
  )
}

// ── BLAST VIEW ────────────────────────────────────────────────────────────────
function BlastView({ employee, onLogout, resetInactivity }) {
  const [phase, setPhase]       = useState('loading')   // loading | idle | setup | active
  const [batch, setBatch]       = useState(null)
  const [jobs, setJobs]         = useState([])
  const [team, setTeam]         = useState([{ employee_id: employee.employee_id, full_name: employee.full_name }])
  const [startedAt, setStartedAt] = useState(null)
  const [modal, setModal]       = useState(null)
  const [error, setError]       = useState('')
  const [scanning, setScanning] = useState(false)

  const scanRef    = useRef(null)
  const bufRef     = useRef('')
  const phaseRef   = useRef(phase)
  const batchIdRef = useRef(null)
  useEffect(() => { phaseRef.current = phase }, [phase])

  async function loadBatch(silent = false) {
    try {
      const b = await loadActivePaintBatch(employee.employee_id, 'blast')
      if (!b) { if (!silent) setPhase('idle'); return }
      // Don't clobber local job list if same batch and already in setup/active
      if (batchIdRef.current !== b.batch_id) {
        batchIdRef.current = b.batch_id
        setBatch(b)
        setJobs(b.paint_batch_jobs ?? [])
        const t = await getPaintBatchStartTime(b.batch_id)
        const members = (b.paint_batch_members ?? []).map(m => ({
          employee_id: m.employee_id,
          full_name: m.employees?.full_name ?? m.employee_id,
        }))
        setTeam(members.length ? members : [{ employee_id: employee.employee_id, full_name: employee.full_name }])
        setStartedAt(t)
        setPhase(t ? 'active' : 'setup')
      } else if (phaseRef.current === 'active') {
        // Sync team changes from DB while active
        const members = (b.paint_batch_members ?? []).map(m => ({
          employee_id: m.employee_id,
          full_name: m.employees?.full_name ?? m.employee_id,
        }))
        if (members.length) setTeam(members)
      }
    } catch { if (!silent) setPhase('idle') }
  }

  useEffect(() => {
    loadBatch()
    const id = setInterval(() => loadBatch(true), 6000)
    return () => clearInterval(id)
  }, [employee.employee_id])

  useEffect(() => { if (!modal) setTimeout(() => scanRef.current?.focus(), 50) }, [modal])

  async function handleNewBatch() {
    try {
      const b = await createPaintBatch(employee.employee_id)
      setBatch(b)
      setJobs([])
      setTeam([{ employee_id: employee.employee_id, full_name: employee.full_name }])
      setPhase('setup')
    } catch { setError('Could not create batch — check connection.') }
  }

  async function handleJobScan(raw) {
    const parsed = parseJobBarcode(raw)
    if (!parsed) { setError(`Could not parse barcode: "${raw}". Expected PO/PART`); return }
    setModal({ type: 'work_type', parsed })
  }

  async function handleWorkTypeConfirm(workType) {
    const { parsed } = modal
    setModal(null)
    setScanning(true); setError('')
    try {
      const job = await addJobToPaintBatch(batch.batch_id, parsed.poNumber, parsed.partNumber, workType)
      setJobs(prev => {
        if (prev.find(bj => bj.job_id === job.job_id)) return prev
        return [...prev, { job_id: job.job_id, work_type: workType, jobs: job }]
      })
    } catch { setError('Failed to add job — check connection.') }
    finally { setScanning(false) }
  }

  async function handleRemoveJob(jobId) {
    try {
      await removeJobFromPaintBatch(batch.batch_id, jobId)
      setJobs(prev => prev.filter(bj => bj.job_id !== jobId))
    } catch { setError('Could not remove job.') }
  }

  async function handleBadgeScan(raw) {
    setScanning(true); setError('')
    try {
      const member = await findTeamMember(raw)
      if (!member) { setError(`Badge not recognised: "${raw}"`); return }
      if (team.find(m => m.employee_id === member.employee_id)) {
        setError(`${member.full_name} is already on the team.`); return
      }
      if (batch?.batch_id) await addBatchMember(batch.batch_id, member.employee_id, 'blast')
      setTeam(prev => [...prev, { employee_id: member.employee_id, full_name: member.full_name }])
    } catch { setError('Could not look up badge — check connection.') }
    finally { setScanning(false) }
  }

  async function handleStartBlast() {
    if (!jobs.length) { setError('Add at least one job before starting.'); return }
    setModal({ type: 'confirm_start' })
  }

  async function handleStartConfirm() {
    setModal(null)
    try {
      const memberIds = team.map(m => m.employee_id)
      const t = await startPaintBatchStage(batch.batch_id, 'blast', memberIds, jobs)
      setStartedAt(t)
      setPhase('active')
    } catch { setError('Failed to start — check connection.') }
  }

  async function handleComplete() {
    setModal({ type: 'confirm_complete' })
  }

  async function handleCompleteConfirm() {
    setModal(null)
    setPhase('loading')
    try {
      const memberIds = team.map(m => m.employee_id)
      await completePaintBatchStage(batch.batch_id, 'blast', memberIds, jobs)
      batchIdRef.current = null
      setBatch(null); setJobs([]); setStartedAt(null)
      setTeam([{ employee_id: employee.employee_id, full_name: employee.full_name }])
      setPhase('idle')
    } catch { setError('Failed to complete — check connection.'); setPhase('active') }
  }

  if (phase === 'loading') return <div className="flex-1 flex items-center justify-center"><p className="text-stone-500 animate-pulse">Loading…</p></div>

  return (
    <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
      {error && <p className="text-red-400 text-sm bg-red-900/20 rounded-xl px-4 py-3">{error}</p>}

      {phase === 'idle' && (
        <div className="text-center py-16">
          <p className="text-5xl mb-4">💨</p>
          <p className="text-stone-400 text-lg mb-6">No active blast batch</p>
          <button className="btn-primary px-8 py-4 text-lg" onClick={handleNewBatch}>
            + New Batch
          </button>
        </div>
      )}

      {(phase === 'setup' || phase === 'active') && (
        <>
          {phase === 'active' ? (
            <ActiveBatchPanel
              batch={batch}
              jobs={jobs}
              stage="blast"
              startedAt={startedAt}
              team={team}
              onComplete={handleComplete}
              onAddMember={m => setTeam(prev => [...prev, m])}
            />
          ) : (
            <div className="bg-stone-800 border-2 border-orange-500/40 rounded-2xl overflow-hidden">
              <div className="bg-orange-500/10 px-5 py-3">
                <p className="text-xs font-semibold text-orange-400 uppercase tracking-widest">
                  Batch #{batch?.batch_number} · Setup
                </p>
              </div>
              <div className="px-5 py-4 space-y-4">
                {/* Job scan */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs text-stone-500 uppercase tracking-widest">Jobs</p>
                    <div className="flex gap-3">
                      <button onClick={() => setModal({ type: 'manual_job' })} className="text-xs text-stone-500 hover:text-stone-300 underline">⌨ Type manually</button>
                    </div>
                  </div>
                  <div className="relative mb-3">
                    <input
                      ref={scanRef}
                      type="text"
                      inputMode="none"
                      className="w-full bg-stone-900 border-2 border-stone-600 focus:border-orange-400 rounded-xl px-4 py-3 text-stone-100 outline-none placeholder-stone-600"
                      placeholder={scanning ? 'Looking up…' : '▌ Scan job barcode'}
                      autoComplete="off" autoCorrect="off" spellCheck={false}
                      readOnly={scanning}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          const v = bufRef.current.trim(); bufRef.current = ''
                          if (e.target) e.target.value = ''
                          if (v) handleJobScan(v)
                        }
                      }}
                      onInput={e => { bufRef.current = e.target.value }}
                    />
                    {scanning && <span className="absolute right-4 top-1/2 -translate-y-1/2 text-orange-400 animate-pulse">…</span>}
                  </div>
                  <JobList jobs={jobs} onRemove={handleRemoveJob} />
                </div>

                {/* Team scan */}
                <div>
                  <p className="text-xs text-stone-500 uppercase tracking-widest mb-2">Team</p>
                  <TeamBadgeScan
                    team={team}
                    onScan={handleBadgeScan}
                    scanning={scanning}
                    accentClass="focus:border-orange-400"
                  />
                </div>

                <button
                  className="btn-primary w-full py-4 text-lg mt-2"
                  disabled={!jobs.length}
                  onClick={handleStartBlast}
                >
                  ▶ Start Blast
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {modal?.type === 'work_type'       && <WorkTypeModal onConfirm={handleWorkTypeConfirm} onCancel={() => setModal(null)} />}
      {modal?.type === 'manual_job'      && <ManualScanModal title="Enter Job Barcode" placeholder="PO/PART" onSubmit={v => { setModal(null); handleJobScan(v) }} onCancel={() => setModal(null)} />}
      {modal?.type === 'confirm_start'   && <ConfirmModal title="Start Blast?" message={`${jobs.length} job${jobs.length !== 1 ? 's' : ''} · ${team.length} team member${team.length !== 1 ? 's' : ''}`} confirmLabel="Start Blast ▶" onConfirm={handleStartConfirm} onCancel={() => setModal(null)} />}
      {modal?.type === 'confirm_complete'&& <ConfirmModal title="Complete Blast?" message="Batch will move to the Prep queue." confirmLabel="Complete ✓" onConfirm={handleCompleteConfirm} onCancel={() => setModal(null)} />}
    </div>
  )
}

// ── Badge scan sub-input (reusable for team building) ─────────────────────────
function TeamBadgeScan({ team, onScan, scanning, accentClass = 'focus:border-amber-500' }) {
  const ref = useRef(null)
  const buf = useRef('')
  return (
    <div>
      <TeamChips members={team} />
      <div className="relative mt-3">
        <input
          ref={ref}
          type="text"
          inputMode="none"
          className={`w-full bg-stone-900 border-2 border-stone-600 ${accentClass} rounded-xl px-4 py-3 text-stone-100 outline-none placeholder-stone-600`}
          placeholder="▌ Scan badge to add team member"
          autoComplete="off" autoCorrect="off" spellCheck={false}
          readOnly={scanning}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              const v = buf.current.trim(); buf.current = ''
              if (e.target) e.target.value = ''
              if (v) { onScan(v); setTimeout(() => ref.current?.focus(), 50) }
            }
          }}
          onInput={e => { buf.current = e.target.value }}
        />
        {scanning && <span className="absolute right-4 top-1/2 -translate-y-1/2 text-amber-400 animate-pulse">…</span>}
      </div>
    </div>
  )
}

// ── PREP VIEW — selects individual jobs from blast pool into a booth ───────────
function PrepView({ employee }) {
  const [phase, setPhase]             = useState('loading')  // loading | pool | setup | active
  const [poolJobs, setPoolJobs]       = useState([])
  const [selected, setSelected]       = useState(new Set())
  const [boothStatus, setBoothStatus] = useState({ 1: null, 2: null, 3: null })
  const [batch, setBatch]             = useState(null)
  const [jobs, setJobs]               = useState([])
  const [team, setTeam]               = useState([{ employee_id: employee.employee_id, full_name: employee.full_name }])
  const [startedAt, setStartedAt]     = useState(null)
  const [modal, setModal]             = useState(null)
  const [error, setError]             = useState('')
  const [scanning, setScanning]       = useState(false)

  const phaseRef   = useRef('loading')
  const batchIdRef = useRef(null)
  useEffect(() => { phaseRef.current = phase }, [phase])

  async function loadState(silent = false) {
    try {
      const active = await loadActivePaintBatch(employee.employee_id, 'prep')
      if (active) {
        const isNew = batchIdRef.current !== active.batch_id
        batchIdRef.current = active.batch_id
        const members = (active.paint_batch_members ?? [])
          .filter(m => m.stage === 'prep')
          .map(m => ({ employee_id: m.employee_id, full_name: m.employees?.full_name ?? m.employee_id }))
        if (isNew) {
          setBatch(active)
          setJobs(active.paint_batch_jobs ?? [])
          setTeam(members.length ? members : [{ employee_id: employee.employee_id, full_name: employee.full_name }])
          const t = await getPaintBatchStartTime(active.batch_id)
          setStartedAt(t)
          setPhase(t ? 'active' : 'setup')
        } else {
          // Sync team + jobs without disrupting local state
          if (members.length) setTeam(members)
          if (phaseRef.current === 'setup' || phaseRef.current === 'active') {
            setJobs(active.paint_batch_jobs ?? [])
          }
        }
        return
      }
      // No active batch — only update pool data, don't interrupt setup flow
      if (phaseRef.current === 'pool' || !silent) {
        const [pool, booths] = await Promise.all([loadAvailablePoolJobs(), getBoothStatus()])
        setPoolJobs(pool)
        setBoothStatus(booths)
        if (!silent) setPhase('pool')
      }
    } catch { if (!silent) setPhase('pool') }
  }

  useEffect(() => {
    loadState()
    const id = setInterval(() => loadState(true), 6000)
    return () => clearInterval(id)
  }, [employee.employee_id])

  async function refreshPool() {
    const [pool, booths] = await Promise.all([loadAvailablePoolJobs(), getBoothStatus()])
    setPoolJobs(pool); setBoothStatus(booths)
  }

  function toggleJob(id) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  async function handleBoothPick(boothNumber) {
    setModal(null)
    try {
      const b = await joinOrCreatePrepBooth(boothNumber, employee.employee_id, [...selected])
      batchIdRef.current = b.batch_id
      setBatch(b)
      setJobs(b.paint_batch_jobs ?? [])
      setSelected(new Set())
      const members = (b.paint_batch_members ?? [])
        .filter(m => m.stage === 'prep')
        .map(m => ({ employee_id: m.employee_id, full_name: m.employees?.full_name ?? m.employee_id }))
      setTeam(members.length ? members : [{ employee_id: employee.employee_id, full_name: employee.full_name }])
      const t = await getPaintBatchStartTime(b.batch_id)
      setStartedAt(t)
      setPhase(t ? 'active' : 'setup')
    } catch { setError('Could not join/create booth — check connection.') }
  }

  async function handleBadgeScan(raw) {
    setScanning(true); setError('')
    try {
      const member = await findTeamMember(raw)
      if (!member) { setError(`Badge not recognised: "${raw}"`); return }
      if (team.find(m => m.employee_id === member.employee_id)) { setError(`${member.full_name} already on team.`); return }
      if (batch?.batch_id) await addBatchMember(batch.batch_id, member.employee_id, 'prep')
      setTeam(prev => [...prev, { employee_id: member.employee_id, full_name: member.full_name }])
    } catch { setError('Could not look up badge.') }
    finally { setScanning(false) }
  }

  async function handleStartConfirm() {
    setModal(null)
    try {
      const memberIds = team.map(m => m.employee_id)
      const t = await startPaintBatchStage(batch.batch_id, 'prep', memberIds, jobs)
      setStartedAt(t); setPhase('active')
    } catch { setError('Failed to start — check connection.') }
  }

  async function handleCompleteConfirm() {
    setModal(null)
    setPhase('loading')
    try {
      const memberIds = team.map(m => m.employee_id)
      await completePaintBatchStage(batch.batch_id, 'prep', memberIds, jobs)
      batchIdRef.current = null
      setBatch(null); setJobs([]); setStartedAt(null)
      setTeam([{ employee_id: employee.employee_id, full_name: employee.full_name }])
      await refreshPool()
      setPhase('pool')
    } catch { setError('Failed to complete — check connection.'); setPhase('active') }
  }

  if (phase === 'loading') return <div className="flex-1 flex items-center justify-center"><p className="text-stone-500 animate-pulse">Loading…</p></div>

  return (
    <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
      {error && <p className="text-red-400 text-sm bg-red-900/20 rounded-xl px-4 py-3">{error}</p>}

      {phase === 'active' && (
        <ActiveBatchPanel batch={batch} jobs={jobs} stage="prep" startedAt={startedAt} team={team}
          onComplete={() => setModal({ type: 'confirm_complete' })}
          onAddMember={m => setTeam(prev => [...prev, m])} />
      )}

      {phase === 'setup' && (
        <div className="bg-stone-800 border-2 border-yellow-500/40 rounded-2xl overflow-hidden">
          <div className="bg-yellow-500/10 px-5 py-3">
            <p className="text-xs font-semibold text-yellow-400 uppercase tracking-widest">
              {batch?.booth_number ? `Booth ${batch.booth_number}` : `Batch #${batch?.batch_number}`} · Add your team
            </p>
          </div>
          <div className="px-5 py-4 space-y-4">
            <div>
              <p className="text-xs text-stone-500 uppercase tracking-widest mb-2">Jobs in this booth</p>
              <JobList jobs={jobs} />
            </div>
            <div>
              <p className="text-xs text-stone-500 uppercase tracking-widest mb-2">Your team</p>
              <TeamBadgeScan team={team} onScan={handleBadgeScan} scanning={scanning} accentClass="focus:border-yellow-400" />
            </div>
            <div className="flex gap-3">
              <button className="btn-primary flex-1 py-4 text-lg" onClick={() => setModal({ type: 'confirm_start' })}>
                ▶ Start Prep
              </button>
            </div>
          </div>
        </div>
      )}

      {phase === 'pool' && (
        <>
          <div className="flex items-center justify-between">
            <p className="text-xs text-stone-500 uppercase tracking-widest">Available from Blast</p>
            <button onClick={refreshPool} className="text-xs text-stone-500 underline">Refresh</button>
          </div>

          {poolJobs.length === 0 ? (
            <div className="text-center py-16 text-stone-600">
              <p className="text-4xl mb-4">⏳</p>
              <p className="text-lg">No blasted jobs available yet</p>
            </div>
          ) : (
            <>
              <p className="text-xs text-stone-500">Tap jobs to select them for this booth</p>
              <div className="space-y-2">
                {poolJobs.map(bj => {
                  const sel = selected.has(bj.id)
                  return (
                    <button key={bj.id} onClick={() => toggleJob(bj.id)}
                      className={`w-full flex items-center gap-3 rounded-xl px-4 py-3 border-2 transition-colors text-left
                        ${sel ? 'bg-yellow-500/10 border-yellow-500' : 'bg-stone-900 border-stone-700 hover:border-stone-500'}`}>
                      <div className={`w-5 h-5 rounded border-2 shrink-0 flex items-center justify-center
                        ${sel ? 'bg-yellow-500 border-yellow-500' : 'border-stone-600'}`}>
                        {sel && <span className="text-black text-xs font-bold">✓</span>}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-stone-100 font-semibold truncate">{bj.jobs?.po_number}</p>
                        <p className="text-xs text-stone-500">Part: {bj.jobs?.part_number}</p>
                        {bj.work_type && <p className="text-xs text-red-400 mt-0.5">{WORK_LABEL[bj.work_type]}</p>}
                      </div>
                      <p className="text-xs text-stone-600 shrink-0">Batch #{bj.paint_batches?.batch_number}</p>
                    </button>
                  )
                })}
              </div>

              {selected.size > 0 && (
                <button className="btn-primary w-full py-4 text-lg"
                  onClick={() => setModal({ type: 'pick_booth' })}>
                  Load {selected.size} job{selected.size !== 1 ? 's' : ''} into Booth →
                </button>
              )}
            </>
          )}
        </>
      )}

      {modal?.type === 'pick_booth'       && <BoothPickerModal boothStatus={boothStatus} selectedCount={selected.size} onPick={handleBoothPick} onCancel={() => setModal(null)} />}
      {modal?.type === 'confirm_start'    && <ConfirmModal title="Start Prep?" message={`${jobs.length} job${jobs.length !== 1 ? 's' : ''} · ${team.length} team member${team.length !== 1 ? 's' : ''}`} confirmLabel="Start Prep ▶" onConfirm={handleStartConfirm} onCancel={() => setModal(null)} />}
      {modal?.type === 'confirm_complete' && <ConfirmModal title="Complete Prep?" message="Booth will move to the Paint queue." confirmLabel="Complete ✓" onConfirm={handleCompleteConfirm} onCancel={() => setModal(null)} />}
    </div>
  )
}

// ── STAGE VIEW (Paint / Pack) ─────────────────────────────────────────────────
function StageView({ employee, stage }) {
  const [phase, setPhase]         = useState('loading')
  const [available, setAvailable] = useState([])
  const [batch, setBatch]         = useState(null)
  const [jobs, setJobs]           = useState([])
  const [team, setTeam]           = useState([{ employee_id: employee.employee_id, full_name: employee.full_name }])
  const [startedAt, setStartedAt] = useState(null)
  const [modal, setModal]         = useState(null)
  const [error, setError]         = useState('')
  const [scanning, setScanning]   = useState(false)

  const phaseRef   = useRef('loading')
  const batchIdRef = useRef(null)
  useEffect(() => { phaseRef.current = phase }, [phase])

  async function loadState(silent = false) {
    try {
      const active = await loadActivePaintBatch(employee.employee_id, stage)
      if (active) {
        const isNew = batchIdRef.current !== active.batch_id
        batchIdRef.current = active.batch_id
        const members = (active.paint_batch_members ?? []).filter(m => m.stage === stage)
          .map(m => ({ employee_id: m.employee_id, full_name: m.employees?.full_name ?? m.employee_id }))
        if (isNew) {
          setBatch(active); setJobs(active.paint_batch_jobs ?? [])
          setTeam(members.length ? members : [{ employee_id: employee.employee_id, full_name: employee.full_name }])
          const t = await getPaintBatchStartTime(active.batch_id)
          setStartedAt(t); setPhase(t ? 'active' : 'setup')
        } else {
          if (members.length) setTeam(members)
        }
        return
      }
      if (phaseRef.current === 'queue' || !silent) {
        const avail = await loadAvailablePaintBatches(stage)
        setAvailable(avail)
        if (!silent) setPhase('queue')
      }
    } catch { if (!silent) setPhase('queue') }
  }

  useEffect(() => {
    loadState()
    const id = setInterval(() => loadState(true), 6000)
    return () => clearInterval(id)
  }, [employee.employee_id, stage])

  async function refreshQueue() {
    const avail = await loadAvailablePaintBatches(stage)
    setAvailable(avail)
  }

  function handleClaim(b) {
    batchIdRef.current = b.batch_id
    setBatch(b); setJobs(b.paint_batch_jobs ?? [])
    setTeam([{ employee_id: employee.employee_id, full_name: employee.full_name }])
    setPhase('setup')
  }

  async function handleBadgeScan(raw) {
    setScanning(true); setError('')
    try {
      const member = await findTeamMember(raw)
      if (!member) { setError(`Badge not recognised: "${raw}"`); return }
      if (team.find(m => m.employee_id === member.employee_id)) { setError(`${member.full_name} already on team.`); return }
      if (batch?.batch_id) await addBatchMember(batch.batch_id, member.employee_id, stage)
      setTeam(prev => [...prev, { employee_id: member.employee_id, full_name: member.full_name }])
    } catch { setError('Could not look up badge.') }
    finally { setScanning(false) }
  }

  async function handleStartConfirm() {
    setModal(null)
    try {
      const memberIds = team.map(m => m.employee_id)
      const t = await startPaintBatchStage(batch.batch_id, stage, memberIds, jobs)
      setStartedAt(t); setPhase('active')
    } catch { setError('Failed to start.') }
  }

  async function handleCompleteConfirm() {
    setModal(null)
    setPhase('loading')
    try {
      const memberIds = team.map(m => m.employee_id)
      await completePaintBatchStage(batch.batch_id, stage, memberIds, jobs)
      batchIdRef.current = null
      setBatch(null); setJobs([]); setStartedAt(null)
      setTeam([{ employee_id: employee.employee_id, full_name: employee.full_name }])
      await refreshQueue()
      setPhase('queue')
    } catch { setError('Failed to complete.'); setPhase('active') }
  }

  if (phase === 'loading') return <div className="flex-1 flex items-center justify-center"><p className="text-stone-500 animate-pulse">Loading…</p></div>

  return (
    <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
      {error && <p className="text-red-400 text-sm bg-red-900/20 rounded-xl px-4 py-3">{error}</p>}

      {phase === 'active' && (
        <ActiveBatchPanel batch={batch} jobs={jobs} stage={stage} startedAt={startedAt} team={team}
          onComplete={() => setModal({ type: 'confirm_complete' })}
          onAddMember={m => setTeam(prev => [...prev, m])} />
      )}

      {phase === 'setup' && (
        <div className={`bg-stone-800 border-2 ${STAGE_BORDER[stage]}/40 rounded-2xl overflow-hidden`}>
          <div className={`${STAGE_BG[stage]} px-5 py-3`}>
            <p className={`text-xs font-semibold uppercase tracking-widest ${STAGE_COLOUR[stage]}`}>
              {batch?.booth_number ? `Booth ${batch.booth_number}` : `Batch #${batch?.batch_number}`} · Add your team
            </p>
          </div>
          <div className="px-5 py-4 space-y-4">
            <div>
              <p className="text-xs text-stone-500 uppercase tracking-widest mb-2">Jobs in this batch</p>
              <JobList jobs={jobs} />
            </div>
            <div>
              <p className="text-xs text-stone-500 uppercase tracking-widest mb-2">Your team</p>
              <TeamBadgeScan team={team} onScan={handleBadgeScan} scanning={scanning}
                accentClass={stage === 'paint' ? 'focus:border-red-400' : 'focus:border-emerald-400'} />
            </div>
            <div className="flex gap-3">
              <button className="btn-ghost flex-1" onClick={() => { setBatch(null); refreshQueue(); setPhase('queue') }}>← Back</button>
              <button className="btn-primary flex-1 py-4 text-lg" onClick={() => setModal({ type: 'confirm_start' })}>
                ▶ Start {STAGE_LABEL[stage]}
              </button>
            </div>
          </div>
        </div>
      )}

      {phase === 'queue' && (
        <>
          <div className="flex items-center justify-between">
            <p className="text-xs text-stone-500 uppercase tracking-widest">Ready from {PREV_LABEL[stage]}</p>
            <button onClick={refreshQueue} className="text-xs text-stone-500 underline">Refresh</button>
          </div>
          {available.length === 0 ? (
            <div className="text-center py-16 text-stone-600">
              <p className="text-4xl mb-4">⏳</p>
              <p className="text-lg">No booths ready from {PREV_LABEL[stage]}</p>
            </div>
          ) : (
            available.map(b => (
              <AvailableBatchCard key={b.batch_id} batch={b}
                prevStage={stage === 'paint' ? 'prep' : 'paint'} onClaim={handleClaim} />
            ))
          )}
        </>
      )}

      {modal?.type === 'confirm_start'    && <ConfirmModal title={`Start ${STAGE_LABEL[stage]}?`} message={`${jobs.length} job${jobs.length !== 1 ? 's' : ''} · ${team.length} team member${team.length !== 1 ? 's' : ''}`} confirmLabel={`Start ${STAGE_LABEL[stage]} ▶`} onConfirm={handleStartConfirm} onCancel={() => setModal(null)} />}
      {modal?.type === 'confirm_complete' && <ConfirmModal title={`Complete ${STAGE_LABEL[stage]}?`} message={stage === 'pack' ? 'Batch fully complete.' : `Moves to ${STAGE_LABEL[{ paint: 'pack' }[stage] ?? 'pack']} queue.`} confirmLabel="Complete ✓" onConfirm={handleCompleteConfirm} onCancel={() => setModal(null)} />}
    </div>
  )
}

// ── Main PaintDashboard ───────────────────────────────────────────────────────
export default function PaintDashboard({ employee, onLogout }) {
  const stage = employee.sub_department   // blast | prep | paint | pack

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

  const stageColour = STAGE_COLOUR[stage] ?? 'text-stone-400'

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <div className="bg-stone-900 border-b border-stone-700 px-5 py-4 flex items-center justify-between shrink-0 gap-3">
        <div className="min-w-0">
          <p className="text-xs text-stone-500 uppercase tracking-widest">
            Paint Shop &nbsp;·&nbsp;
            <span className={stageColour}>{STAGE_LABEL[stage] ?? stage}</span>
          </p>
          <p className="text-xl font-bold text-stone-100 truncate">{employee.full_name}</p>
        </div>
        <button className="btn-danger px-5 py-3 text-base shrink-0" onClick={onLogout}>
          Done →
        </button>
      </div>

      {/* Stage-specific view */}
      {stage === 'blast' && <BlastView employee={employee} onLogout={onLogout} />}
      {stage === 'prep'  && <PrepView  employee={employee} />}
      {(stage === 'paint' || stage === 'pack') && <StageView employee={employee} stage={stage} />}
    </div>
  )
}
