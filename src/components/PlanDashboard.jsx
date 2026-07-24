import { useEffect, useMemo, useState } from 'react'
import { fetchPlanRows, DEPTS, asWeek, isoWeek } from '../lib/plan'

const DEPT_ACCENT = {
  kitting: { text: 'text-orange-400', bar: 'bg-orange-500' },
  weld:    { text: 'text-blue-400',   bar: 'bg-blue-500' },
  paint:   { text: 'text-red-400',    bar: 'bg-red-500' },
  subs:    { text: 'text-emerald-400',bar: 'bg-emerald-500' },
}

// Week numbers in the plan have no year attached (1-52, repeating every
// year), so a naive "plannedWeek < currentWeek" check misreads next year's
// early weeks as wildly overdue (e.g. week 3 read as 27 weeks late in week
// 30, when it's actually week 3 of NEXT year — still ~25 weeks away).
// A gap of more than half a year is almost certainly a next-year date, not
// a genuinely stale job, so treat it as upcoming rather than late.
function weeksLate(plannedWeek, currentWeek) {
  const diff = currentWeek - plannedWeek
  if (diff <= 0) return null       // this week or still in the future
  if (diff > 26) return null       // "late" by raw numbers, but really next year
  return diff
}

// Manager plan dashboard: department load per week, overdue jobs, and what's
// due / completed this week — all off the synced build_plan.
// A job is "in a department's plan" when its planned-week cell is a real week
// number; "done" once its completed-week cell has a week filled in.
export default function PlanDashboard() {
  const [rows, setRows]   = useState(null)
  const [error, setError] = useState('')
  const [openDept, setOpenDept] = useState(null)   // which overdue list is expanded
  const cw = isoWeek()

  useEffect(() => {
    let alive = true
    fetchPlanRows()
      .then(r => { if (alive) setRows(r) })
      .catch(e => { console.error(e); if (alive) setError('Could not load the plan — check connection.') })
    return () => { alive = false }
  }, [])

  const model = useMemo(() => {
    if (!rows) return null
    const depts = DEPTS.map(d => {
      const openByWeek = new Map()
      const late = []
      let open = 0, due = 0, completedThisWeek = 0
      for (const row of rows) {
        const pw  = asWeek(row[d.planned])
        const cwk = asWeek(row[d.completed])
        if (cwk === cw) completedThisWeek++
        if (pw == null || cwk != null) continue   // not planned by week, or already done
        open++
        openByWeek.set(pw, (openByWeek.get(pw) ?? 0) + 1)
        if (pw === cw) {
          due++
        } else {
          const wl = weeksLate(pw, cw)
          if (wl != null) late.push({ ...row, plannedWeek: pw, weeksLate: wl })
        }
      }
      late.sort((a, b) => a.plannedWeek - b.plannedWeek)
      return { ...d, openByWeek, late, open, due, completedThisWeek }
    })
    const totals = {
      open: depts.reduce((s, d) => s + d.open, 0),
      late: depts.reduce((s, d) => s + d.late.length, 0),
      due:  depts.reduce((s, d) => s + d.due, 0),
      completedThisWeek: depts.reduce((s, d) => s + d.completedThisWeek, 0),
    }
    return { depts, totals }
  }, [rows, cw])

  const weeks = []
  for (let w = cw - 1; w <= cw + 8; w++) weeks.push(w)

  function cellCls(week, count) {
    if (!count) return 'text-stone-700'
    if (week < cw)  return 'bg-red-500/20 text-red-300 ring-1 ring-red-800/50'
    if (week === cw) return 'bg-amber-500/25 text-amber-200 ring-1 ring-amber-600/60 font-bold'
    return count >= 8 ? 'bg-blue-500/30 text-blue-200'
         : count >= 3 ? 'bg-blue-500/20 text-blue-300'
         : 'bg-blue-500/10 text-blue-300'
  }

  if (error)  return <div className="flex-1 px-4 py-16 text-center text-red-400">{error}</div>
  if (!model) return <div className="flex-1 px-4 py-16 text-center text-stone-500 animate-pulse">Loading the plan…</div>

  return (
    <div className="flex-1 overflow-y-auto px-4 py-5 space-y-5">

      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi n={model.totals.open}  label="Open stage-jobs" stripe="bg-stone-500" />
        <Kpi n={model.totals.late}  label="Overdue"          stripe="bg-red-500"   tone={model.totals.late ? 'text-red-300' : ''} />
        <Kpi n={model.totals.due}   label={`Due this week (wk ${cw})`} stripe="bg-amber-500" />
        <Kpi n={model.totals.completedThisWeek} label="Completed this week" stripe="bg-emerald-500" />
      </div>

      {/* Load-per-week matrix */}
      <div className="bg-stone-900 rounded-2xl border border-stone-700 overflow-hidden">
        <div className="px-4 py-3 border-b border-stone-700 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-widest text-stone-200">Load per week</h2>
          <span className="text-xs text-stone-500">open jobs planned into each week · <span className="text-amber-400">this week</span> · <span className="text-red-400">overdue</span></span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-stone-900 text-left px-4 py-2 text-xs uppercase tracking-widest text-stone-500">Dept</th>
                {weeks.map(w => (
                  <th key={w} className={`px-2 py-2 text-center text-xs font-semibold tabular-nums min-w-[46px] ${w === cw ? 'text-amber-400' : 'text-stone-500'}`}>
                    {w}
                  </th>
                ))}
                <th className="px-3 py-2 text-center text-xs uppercase tracking-widest text-stone-500">Open</th>
              </tr>
            </thead>
            <tbody>
              {model.depts.map(d => (
                <tr key={d.key} className="border-t border-stone-800">
                  <td className="sticky left-0 z-10 bg-stone-900 px-4 py-2.5 whitespace-nowrap">
                    <span className={`inline-block w-1.5 h-1.5 rounded-full mr-2 align-middle ${DEPT_ACCENT[d.key].bar}`} />
                    <span className={`font-bold uppercase text-xs tracking-wide ${DEPT_ACCENT[d.key].text}`}>{d.label}</span>
                  </td>
                  {weeks.map(w => {
                    const c = d.openByWeek.get(w) ?? 0
                    return (
                      <td key={w} className="px-1.5 py-1.5 text-center">
                        <span className={`inline-flex items-center justify-center min-w-[30px] px-1.5 py-1 rounded-md tabular-nums text-sm ${cellCls(w, c)}`}>
                          {c || '·'}
                        </span>
                      </td>
                    )
                  })}
                  <td className="px-3 py-2.5 text-center font-mono font-bold text-stone-200 tabular-nums">{d.open}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-4 py-2 text-xs text-stone-600 border-t border-stone-800">
          Weeks before {cw} shown here are overdue backlog; older overdue jobs are listed below.
        </p>
      </div>

      {/* Overdue by department */}
      <div className="bg-stone-900 rounded-2xl border border-stone-700 overflow-hidden">
        <div className="px-4 py-3 border-b border-stone-700 flex items-center gap-3">
          <h2 className="text-sm font-bold uppercase tracking-widest text-stone-200">Overdue jobs</h2>
          <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${model.totals.late ? 'bg-red-500/20 text-red-400' : 'bg-stone-700 text-stone-500'}`}>
            {model.totals.late} past their planned week
          </span>
        </div>
        {model.totals.late === 0 ? (
          <p className="text-stone-600 text-sm px-4 py-6 text-center">Nothing overdue 🎉</p>
        ) : (
          model.depts.filter(d => d.late.length).map(d => {
            const open = openDept === d.key
            return (
              <div key={d.key} className="border-t border-stone-800 first:border-0">
                <button onClick={() => setOpenDept(open ? null : d.key)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-stone-800/40">
                  <span className="flex items-center gap-2">
                    <span className={`inline-block w-1.5 h-1.5 rounded-full ${DEPT_ACCENT[d.key].bar}`} />
                    <span className={`font-bold uppercase text-xs tracking-wide ${DEPT_ACCENT[d.key].text}`}>{d.label}</span>
                    <span className="text-red-400 text-sm font-semibold">{d.late.length}</span>
                  </span>
                  <span className="text-stone-600 text-xs">{open ? '▲ hide' : '▼ show'}</span>
                </button>
                {open && (
                  <div className="px-4 pb-3 space-y-1.5">
                    {d.late.slice(0, 40).map(j => (
                      <div key={j.seq_no ?? `${j.po_number}-${j.part_number}`}
                        className="flex items-center justify-between gap-3 bg-stone-800/60 rounded-lg px-3 py-2">
                        <div className="min-w-0">
                          <p className="text-stone-200 text-sm font-mono truncate">
                            {j.part_number}
                            {j.model && <span className="ml-2 text-xs text-amber-300/80">{j.model}</span>}
                          </p>
                          <p className="text-stone-500 text-xs truncate">
                            PO {j.po_number}{j.customer && <> · {String(j.customer).split(' - ')[0]}</>}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-red-300 text-xs font-semibold">{j.weeksLate} wk{j.weeksLate === 1 ? '' : 's'} late</p>
                          <p className="text-stone-600 text-xs">planned wk {j.plannedWeek}</p>
                        </div>
                      </div>
                    ))}
                    {d.late.length > 40 && <p className="text-xs text-stone-600 text-center pt-1">+{d.late.length - 40} more</p>}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      <p className="text-xs text-stone-600 text-center px-4">
        Reads the synced build plan. Numbers reflect the last import — re-sync the workbook to refresh.
      </p>
    </div>
  )
}

function Kpi({ n, label, stripe, tone = '' }) {
  return (
    <div className="relative bg-stone-900 border border-stone-700 rounded-2xl px-4 py-4 overflow-hidden">
      <span className={`absolute left-0 top-0 bottom-0 w-1 ${stripe}`} />
      <p className={`text-4xl font-extrabold tabular-nums leading-none ${tone || 'text-stone-100'}`}>{n}</p>
      <p className="text-[11px] uppercase tracking-widest text-stone-500 font-semibold mt-1.5">{label}</p>
    </div>
  )
}
