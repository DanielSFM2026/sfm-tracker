import { useEffect, useRef, useState } from 'react'
import { loadManagerReport, fetchBreakRules, fetchAssemblyLines } from '../lib/db'
import { calcElapsed, formatDuration, isJobActive } from '../lib/timeCalc'

const REFRESH_MS = 30_000

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

const HOLD_SHORT = {
  missing_parts_sfm:          'Missing Parts (SFM)',
  poor_quality_sfm:           'Poor Quality (SFM)',
  missing_parts_supply_chain: 'Missing Parts (Supply Chain)',
  poor_quality_supply_chain:  'Poor Quality (Supply Chain)',
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
function Dot({ active }) {
  return (
    <span className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${
      active ? 'bg-emerald-400' : 'bg-orange-500'
    }`} />
  )
}

// ── Individual dept row ───────────────────────────────────────────────────────
function WorkerRow({ emp, jobs, breakRules }) {
  const subLabel = SUB_DEPT_LABEL[emp.sub_department]
  return (
    <div className="border-b border-stone-800 last:border-0">
      {jobs.map((job, i) => (
        <div key={job.job_id} className="flex items-center gap-3 px-4 py-3">
          <Dot active={job.isActive} />
          <div className="flex-1 min-w-0">
            <p className="text-stone-100 font-semibold truncate">
              {i === 0 ? emp.full_name : ''}
              {i === 0 && subLabel && (
                <span className="ml-2 text-xs text-purple-400 font-normal">{subLabel}</span>
              )}
            </p>
            <p className="text-stone-400 text-sm truncate">
              PO {job.po_number} &nbsp;·&nbsp; {job.part_number}
              {job.holdReason && (
                <span className="ml-2 text-orange-400 text-xs">
                  ⏸ {HOLD_SHORT[job.holdReason] ?? job.holdReason}
                </span>
              )}
            </p>
          </div>
          <LiveTimer events={job.events} breakRules={breakRules} isActive={job.isActive} />
        </div>
      ))}
    </div>
  )
}

// ── Assembly line job row ─────────────────────────────────────────────────────
function AssemblyJobRow({ entry, breakRules }) {
  const { job, events, isActive, holdReason, team } = entry
  return (
    <div className="border-b border-stone-800 last:border-0 px-4 py-3">
      <div className="flex items-center gap-3">
        <Dot active={isActive} />
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
            <p className="text-orange-400 text-xs mt-0.5">
              ⏸ {HOLD_SHORT[holdReason] ?? holdReason}
            </p>
          )}
        </div>
        <LiveTimer events={events} breakRules={breakRules} isActive={isActive} />
      </div>
    </div>
  )
}

// ── Section card ──────────────────────────────────────────────────────────────
function Section({ title, badge, badgeColour = 'bg-stone-700 text-stone-300', children, empty }) {
  return (
    <div className="bg-stone-900 rounded-2xl border border-stone-700 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-stone-700 bg-stone-800/60">
        <h2 className="text-sm font-bold uppercase tracking-widest text-stone-300">{title}</h2>
        {badge != null && (
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${badgeColour}`}>
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

// ── Main report screen ────────────────────────────────────────────────────────
export default function ManagerReport({ onBack }) {
  const [report, setReport]         = useState(null)
  const [lines, setLines]           = useState([])
  const [breakRules, setBreakRules] = useState([])
  const [loading, setLoading]       = useState(true)
  const [lastRefresh, setLastRefresh] = useState(null)
  const [error, setError]           = useState('')
  const timerRef = useRef(null)

  async function refresh() {
    setError('')
    try {
      const [data, rules, lineList] = await Promise.all([
        loadManagerReport(),
        fetchBreakRules(),
        fetchAssemblyLines()
      ])
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
    refresh()
    timerRef.current = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(timerRef.current)
  }, [])

  const lineMap = Object.fromEntries(lines.map(l => [l.line_id, l.line_name]))

  // Count active workers across all individual depts
  const activeCount = report
    ? Object.values(report.individual).flat().filter(({ jobs }) => jobs.some(j => j.isActive)).length
    : 0

  return (
    <div className="flex flex-col min-h-screen bg-stone-950">

      {/* Header */}
      <div className="bg-stone-900 border-b border-stone-700 px-5 py-4 flex items-center justify-between shrink-0 gap-3">
        <div className="min-w-0">
          <p className="text-xs text-stone-500 uppercase tracking-widest">Live Overview</p>
          <p className="text-xl font-bold text-stone-100">SFM Job Tracker</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {lastRefresh && (
            <p className="text-xs text-stone-600 hidden sm:block">
              Updated {lastRefresh.toLocaleTimeString()}
            </p>
          )}
          <button
            className="bg-stone-800 border border-stone-600 text-stone-300 px-4 py-2.5 rounded-xl text-sm"
            onClick={refresh}
          >
            ↻ Refresh
          </button>
          <button className="btn-danger px-4 py-2.5 text-sm" onClick={onBack}>
            ← Back
          </button>
        </div>
      </div>

      {/* Auto-refresh banner */}
      <div className="bg-stone-900/60 border-b border-stone-800 px-5 py-2 shrink-0">
        <p className="text-xs text-stone-600 text-center">
          Auto-refreshes every 30 seconds
          {lastRefresh && ` · Last updated ${lastRefresh.toLocaleTimeString()}`}
        </p>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-5 space-y-5">

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
            {/* ── Weld ─────────────────────────────────────────────────── */}
            {(() => {
              const workers = report.individual.weld ?? []
              const active  = workers.filter(w => w.jobs.some(j => j.isActive)).length
              return (
                <Section
                  title="Weld Shop"
                  badge={active > 0 ? `${active} active` : 'none active'}
                  badgeColour={active > 0 ? 'bg-amber-500/20 text-amber-400' : 'bg-stone-700 text-stone-500'}
                  empty={workers.length === 0}
                >
                  {workers
                    .sort((a, b) => {
                      const aA = a.jobs.some(j => j.isActive) ? 0 : 1
                      const bA = b.jobs.some(j => j.isActive) ? 0 : 1
                      return aA - bA
                    })
                    .map(({ emp, jobs }) => (
                      <WorkerRow key={emp.employee_id} emp={emp} jobs={jobs} breakRules={breakRules} />
                    ))
                  }
                </Section>
              )
            })()}

            {/* ── Assembly ─────────────────────────────────────────────── */}
            {(() => {
              const asmLines = Object.entries(report.assembly)
              if (asmLines.length === 0) {
                return (
                  <Section title="Assembly" badge="none active"
                    badgeColour="bg-stone-700 text-stone-500" empty />
                )
              }
              return asmLines
                .sort(([a], [b]) => Number(a) - Number(b))
                .map(([lineId, jobs]) => {
                  const activeJobs = jobs.filter(j => j.isActive).length
                  return (
                    <Section
                      key={lineId}
                      title={lineMap[lineId] ?? `Line ${lineId}`}
                      badge={activeJobs > 0 ? `${activeJobs} active` : 'on hold'}
                      badgeColour={activeJobs > 0 ? 'bg-amber-500/20 text-amber-400' : 'bg-orange-900/40 text-orange-400'}
                    >
                      {jobs.map((entry, i) => (
                        <AssemblyJobRow key={i} entry={entry} breakRules={breakRules} />
                      ))}
                    </Section>
                  )
                })
            })()}

            {/* ── Paint ────────────────────────────────────────────────── */}
            {(() => {
              const workers = report.individual.paint ?? []
              const active  = workers.filter(w => w.jobs.some(j => j.isActive)).length
              return (
                <Section
                  title="Paint Shop"
                  badge={active > 0 ? `${active} active` : 'none active'}
                  badgeColour={active > 0 ? 'bg-purple-500/20 text-purple-400' : 'bg-stone-700 text-stone-500'}
                  empty={workers.length === 0}
                >
                  {workers
                    .sort((a, b) => {
                      const order = ['blast','prep','paint','pack']
                      return order.indexOf(a.emp.sub_department) - order.indexOf(b.emp.sub_department)
                    })
                    .map(({ emp, jobs }) => (
                      <WorkerRow key={emp.employee_id} emp={emp} jobs={jobs} breakRules={breakRules} />
                    ))
                  }
                </Section>
              )
            })()}

            {/* ── Cutting Shop ──────────────────────────────────────────── */}
            {(() => {
              const workers = report.individual.kitting ?? []
              const active  = workers.filter(w => w.jobs.some(j => j.isActive)).length
              return (
                <Section
                  title="Cutting Shop"
                  badge={active > 0 ? `${active} active` : 'none active'}
                  badgeColour={active > 0 ? 'bg-sky-500/20 text-sky-400' : 'bg-stone-700 text-stone-500'}
                  empty={workers.length === 0}
                >
                  {workers
                    .sort((a, b) => {
                      const aA = a.jobs.some(j => j.isActive) ? 0 : 1
                      const bA = b.jobs.some(j => j.isActive) ? 0 : 1
                      return aA - bA
                    })
                    .map(({ emp, jobs }) => (
                      <WorkerRow key={emp.employee_id} emp={emp} jobs={jobs} breakRules={breakRules} />
                    ))
                  }
                </Section>
              )
            })()}
          </>
        )}
      </div>
    </div>
  )
}
