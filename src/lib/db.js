import { supabase } from './supabase'

// ── Job alerts (assembly) ────────────────────────────────────────────────────
export async function sendJobAlert({ jobId, employeeId, lineId, poNumber, partNumber, message, employeeName, lineName }) {
  // Store in DB
  await supabase.from('job_alerts').insert({
    job_id: jobId, employee_id: employeeId, line_id: lineId,
    po_number: poNumber, part_number: partNumber, message,
  })

  // Send email via Supabase Edge Function (avoids CORS issues with direct Resend calls)
  const { error } = await supabase.functions.invoke('send-alert', {
    body: { poNumber, partNumber, message, employeeName, lineName },
  })
  if (error) throw error
}

// ── Break rules ─────────────────────────────────────────────────────────────

export async function fetchBreakRules() {
  const { data, error } = await supabase.from('break_rules').select('*')
  if (error) throw error
  return data ?? []
}

// ── Employee lookup ──────────────────────────────────────────────────────────

export async function findEmployee(badgeCode) {
  const { data, error } = await supabase
    .from('employees')
    .select('*')
    .eq('badge_code', badgeCode.toUpperCase())
    .eq('active', true)
    .maybeSingle()
  if (error) throw error
  return data // null if not found
}

// ── Raw event insert ─────────────────────────────────────────────────────────

async function insertEvent(fields) {
  const { data, error } = await supabase
    .from('job_events')
    .insert({ event_timestamp: new Date().toISOString(), ...fields })
    .select()
    .single()
  if (error) throw error
  return data
}

// ── Login ────────────────────────────────────────────────────────────────────

export async function logLogin(employeeId) {
  return insertEvent({ employee_id: employeeId, event_type: 'LOGIN' })
}

// ── Load all open (not-completed) jobs for an employee ───────────────────────

export async function loadEmployeeJobs(employeeId) {
  const { data: rows, error } = await supabase
    .from('job_events')
    .select(`
      event_id, job_id, event_type, activity_type, work_type, split_count, event_timestamp,
      jobs ( job_id, po_number, part_number, quantity, status )
    `)
    .eq('employee_id', employeeId)
    .in('event_type', ['START','PAUSE','RESUME','COMPLETE','AUTO_LOGOUT','JOB_CREATED'])
    .order('event_timestamp', { ascending: true })

  if (error) throw error
  if (!rows || rows.length === 0) return []

  const map = new Map()
  for (const row of rows) {
    if (!row.job_id || !row.jobs) continue
    if (!map.has(row.job_id)) {
      map.set(row.job_id, { ...row.jobs, events: [] })
    }
    map.get(row.job_id).events.push({
      event_id:        row.event_id,
      job_id:          row.job_id,
      event_type:      row.event_type,
      activity_type:   row.activity_type,
      work_type:       row.work_type,
      split_count:     row.split_count ?? 1,
      event_timestamp: row.event_timestamp
    })
  }

  const result = []
  for (const job of map.values()) {
    const last = job.events[job.events.length - 1]
    if (last.event_type !== 'COMPLETE') result.push(job)
  }
  return result
}

// ── Find or create a job by PO + part ────────────────────────────────────────

export async function findOrCreateJob(poNumber, partNumber, department = 'weld') {
  const { data: existing } = await supabase
    .from('jobs')
    .select('*')
    .eq('po_number', poNumber)
    .eq('part_number', partNumber)
    .eq('department', department)
    .maybeSingle()
  if (existing) return { job: existing, created: false }

  const { data, error } = await supabase
    .from('jobs')
    .insert({ po_number: poNumber, part_number: partNumber, department, status: 'not_started' })
    .select()
    .single()
  if (error) throw error
  return { job: data, created: true }
}

// Returns true if this employee has a COMPLETE event on the given job
export async function employeeHasCompletedJob(employeeId, jobId) {
  const { data } = await supabase
    .from('job_events')
    .select('event_id')
    .eq('employee_id', employeeId)
    .eq('job_id', jobId)
    .eq('event_type', 'COMPLETE')
    .limit(1)
  return (data?.length ?? 0) > 0
}

// ── Update jobs.status cache ──────────────────────────────────────────────────

export async function setJobStatus(jobId, status) {
  const { error } = await supabase.from('jobs').update({ status }).eq('job_id', jobId)
  if (error) console.warn('setJobStatus failed:', error)
}

// ── High-level job actions ────────────────────────────────────────────────────

/**
 * Start a brand-new job for this employee.
 * splitCount records how many ways the employee's time is being divided
 * at the moment this START event is logged (default 1 = undivided).
 */
export async function startNewJob(employeeId, jobId, wasCreated, activityType, workType, splitCount = 1) {
  const events = []
  if (wasCreated) {
    events.push(
      await insertEvent({ employee_id: employeeId, job_id: jobId, event_type: 'JOB_CREATED' })
    )
  }
  events.push(
    await insertEvent({
      employee_id:   employeeId,
      job_id:        jobId,
      event_type:    'START',
      activity_type: activityType,
      work_type:     workType,
      split_count:   splitCount
    })
  )
  await setJobStatus(jobId, 'in_progress')
  return events
}

/**
 * Pause a job for this employee.
 */
export async function pauseJob(employeeId, jobId) {
  const ev = await insertEvent({
    employee_id: employeeId,
    job_id:      jobId,
    event_type:  'PAUSE'
  })
  await setJobStatus(jobId, 'paused')
  return ev
}

/**
 * Resume a paused job for this employee.
 * splitCount records the current split level for this new interval.
 */
export async function resumeJob(employeeId, jobId, activityType, workType, splitCount = 1) {
  const ev = await insertEvent({
    employee_id:   employeeId,
    job_id:        jobId,
    event_type:    'RESUME',
    activity_type: activityType,
    work_type:     workType,
    split_count:   splitCount
  })
  await setJobStatus(jobId, 'in_progress')
  return ev
}

/**
 * Complete a job for this employee.
 */
export async function completeJob(employeeId, jobId) {
  const ev = await insertEvent({
    employee_id: employeeId,
    job_id:      jobId,
    event_type:  'COMPLETE'
  })
  await setJobStatus(jobId, 'completed')
  return ev
}

/**
 * Auto-logout: pause ALL currently active jobs (handles split mode).
 */
export async function autoLogout(employeeId, activeJobIds) {
  const ids = Array.isArray(activeJobIds)
    ? activeJobIds
    : activeJobIds ? [activeJobIds] : []
  const events = []
  for (const jobId of ids) {
    events.push(
      await insertEvent({
        employee_id: employeeId,
        job_id:      jobId,
        event_type:  'AUTO_LOGOUT'
      })
    )
    await setJobStatus(jobId, 'paused')
  }
  return events
}

// ── Assembly lines ────────────────────────────────────────────────────────────

export async function fetchAssemblyLines() {
  const { data, error } = await supabase
    .from('assembly_lines')
    .select('*')
    .order('line_id')
  if (error) throw error
  return data ?? []
}

// ── Load all active (non-completed) jobs for a given assembly line ────────────
//
// job.events   = manager-only events (drive the job lifecycle timer + status)
// job.team     = ALL team members who were ever on this job, each with their own
//                events array.  isJobActive(m.events) → currently active.
//                Timer sums all members' credited time (including departed ones).

export async function loadLineJobs(lineId, managerId) {
  const { data: rows, error } = await supabase
    .from('job_events')
    .select(`
      event_id, job_id, employee_id, event_type, hold_reason, split_count, event_timestamp,
      jobs ( job_id, po_number, part_number, quantity, status ),
      employees ( employee_id, full_name, badge_code )
    `)
    .eq('line_id', lineId)
    .in('event_type', ['START','PAUSE','RESUME','COMPLETE'])
    .order('event_timestamp', { ascending: true })

  if (error) throw error
  if (!rows?.length) return []

  // job_id → { ...job fields, events: [], empData: Map<empId, {info, events[]}> }
  const jobMap = new Map()

  for (const row of rows) {
    if (!row.job_id || !row.jobs) continue

    if (!jobMap.has(row.job_id)) {
      jobMap.set(row.job_id, { ...row.jobs, events: [], empData: new Map() })
    }

    const job = jobMap.get(row.job_id)
    const ev = {
      event_id:        row.event_id,
      event_type:      row.event_type,
      hold_reason:     row.hold_reason,
      split_count:     row.split_count ?? 1,
      event_timestamp: row.event_timestamp
    }

    if (row.employee_id === managerId) {
      // Manager events drive the lifecycle and timer
      job.events.push(ev)
    } else if (row.employees) {
      // Track all team member events for their individual time credit
      if (!job.empData.has(row.employee_id)) {
        job.empData.set(row.employee_id, {
          employee_id: row.employees.employee_id,
          full_name:   row.employees.full_name,
          badge_code:  row.employees.badge_code,
          events:      []
        })
      }
      job.empData.get(row.employee_id).events.push(ev)
    }
  }

  const result = []
  for (const [, job] of jobMap) {
    const last = job.events[job.events.length - 1]
    if (last?.event_type === 'COMPLETE') continue

    const { empData, ...jobFields } = job
    // team = all members (active + departed) — UI filters to active, timer sums all
    jobFields.team = [...empData.values()]

    result.push(jobFields)
  }
  return result
}

// ── Load jobs for a regular assembly worker (non-LM) ─────────────────────────
// Returns all active/paused jobs this employee has been assigned to,
// with their own events only (for their individual timer and clock on/off).

export async function loadWorkerJobs(employeeId) {
  const { data: rows, error } = await supabase
    .from('job_events')
    .select(`
      event_id, job_id, employee_id, event_type, event_timestamp, line_id,
      jobs ( job_id, po_number, part_number, quantity, status )
    `)
    .eq('employee_id', employeeId)
    .in('event_type', ['START','RESUME','PAUSE','COMPLETE','AUTO_LOGOUT'])
    .order('event_timestamp', { ascending: true })

  if (error) throw error
  if (!rows?.length) return []

  const jobMap = new Map()
  for (const row of rows) {
    if (!row.jobs) continue
    if (!['in_progress','paused'].includes(row.jobs.status)) continue
    if (!jobMap.has(row.job_id)) {
      jobMap.set(row.job_id, { ...row.jobs, line_id: row.line_id, events: [] })
    }
    jobMap.get(row.job_id).events.push({
      event_id:        row.event_id,
      event_type:      row.event_type,
      event_timestamp: row.event_timestamp,
      split_count:     1
    })
  }

  // Only return jobs where this worker hasn't been permanently removed
  return [...jobMap.values()].filter(job => {
    const last = job.events[job.events.length - 1]
    return last?.event_type !== 'COMPLETE'
  })
}

// ── Load all assembly jobs for any employee (LM or team member) ───────────────
// Returns every in_progress/paused job this person is on, with full team data.

export async function loadMyAssemblyJobs(employeeId) {
  // Step 1: which jobs is this employee involved in?
  const { data: mine, error: e1 } = await supabase
    .from('job_events')
    .select('job_id')
    .eq('employee_id', employeeId)
    .in('event_type', ['START','RESUME','PAUSE','COMPLETE'])
  if (e1) throw e1
  if (!mine?.length) return []

  const jobIds = [...new Set(mine.map(r => r.job_id))]

  // Step 2: load all events for those jobs (every participant)
  const { data: rows, error: e2 } = await supabase
    .from('job_events')
    .select(`
      event_id, job_id, employee_id, event_type, hold_reason, line_id, split_count, event_timestamp,
      jobs ( job_id, po_number, part_number, quantity, status, department ),
      employees ( employee_id, full_name, badge_code, is_line_manager )
    `)
    .in('job_id', jobIds)
    .in('event_type', ['START','RESUME','PAUSE','COMPLETE','AUTO_LOGOUT'])
    .order('event_timestamp', { ascending: true })
  if (e2) throw e2

  // Step 3: line names
  const { data: lines } = await supabase.from('assembly_lines').select('line_id, line_name')
  const lineMap = Object.fromEntries((lines ?? []).map(l => [l.line_id, l.line_name]))

  // Step 4: group by job
  const jobMap = new Map()
  for (const row of rows) {
    if (!row.jobs || !row.employees) continue
    if (row.jobs.department !== 'assembly') continue
    if (!['in_progress','paused'].includes(row.jobs.status)) continue

    if (!jobMap.has(row.job_id)) {
      jobMap.set(row.job_id, { ...row.jobs, line_id: null, line_name: null, empData: new Map() })
    }
    const job = jobMap.get(row.job_id)
    if (row.line_id) {
      job.line_id   = row.line_id
      job.line_name = lineMap[row.line_id] ?? `Line ${row.line_id}`
    }

    const emp = row.employees
    if (!job.empData.has(emp.employee_id)) {
      job.empData.set(emp.employee_id, {
        employee_id:    emp.employee_id,
        full_name:      emp.full_name,
        badge_code:     emp.badge_code,
        is_line_manager: emp.is_line_manager ?? false,
        events: []
      })
    }
    job.empData.get(emp.employee_id).events.push({
      event_id:        row.event_id,
      event_type:      row.event_type,
      hold_reason:     row.hold_reason,
      split_count:     row.split_count ?? 1,
      event_timestamp: row.event_timestamp
    })
  }

  // Step 5: filter to jobs where current employee hasn't been permanently removed
  const result = []
  for (const [, job] of jobMap) {
    const { empData, ...jobFields } = job
    const myEntry = empData.get(employeeId)
    if (!myEntry) continue
    const myLast = myEntry.events[myEntry.events.length - 1]
    if (myLast?.event_type === 'COMPLETE') continue

    // Keep ALL members including COMPLETE so the time sum matches the manager report
    jobFields.team = [...empData.values()]
    result.push(jobFields)
  }
  return result
}

// ── Start a new assembly job (LM scans barcode, picks line) ───────────────────
export async function startAssemblyJob(managerId, jobId, lineId) {
  const splitCount = await prepareManagerLineStart(managerId, lineId)
  const ev = await insertEvent({
    employee_id: managerId, job_id: jobId, event_type: 'START',
    line_id: lineId, split_count: splitCount
  })
  await setJobStatus(jobId, 'in_progress')
  return ev
}

// ── Hold a job — pause all active members with a reason ───────────────────────
export async function holdAssemblyJob(jobId, lineId, holdReason, allActiveIds) {
  if (!allActiveIds.length) { await setJobStatus(jobId, 'paused'); return [] }
  const now = new Date().toISOString()
  const { data, error } = await supabase.from('job_events')
    .insert(allActiveIds.map(empId => ({
      employee_id: empId, job_id: jobId, event_type: 'PAUSE',
      line_id: lineId, hold_reason: holdReason, event_timestamp: now, split_count: 1
    }))).select()
  if (error) throw error
  await setJobStatus(jobId, 'paused')
  return data
}

// ── Complete a job — fire COMPLETE for all still-active members ───────────────
export async function completeAssemblyJob(jobId, lineId, allActiveIds) {
  if (allActiveIds.length) {
    const now = new Date().toISOString()
    const { error } = await supabase.from('job_events')
      .insert(allActiveIds.map(empId => ({
        employee_id: empId, job_id: jobId, event_type: 'COMPLETE',
        line_id: lineId, event_timestamp: now, split_count: 1
      })))
    if (error) throw error
  }
  await setJobStatus(jobId, 'completed')
}

// ── Resume a paused/held assembly job — inserts RESUME for all given member IDs ─
export async function managerResumeAssemblyJob(jobId, lineId, memberIds) {
  if (memberIds.length) {
    const now = new Date().toISOString()
    const { error } = await supabase.from('job_events')
      .insert(memberIds.map(empId => ({
        employee_id: empId, job_id: jobId, event_type: 'RESUME',
        line_id: lineId, split_count: 1, event_timestamp: now
      })))
    if (error) throw error
  }
  await setJobStatus(jobId, 'in_progress')
}

// ── Add / remove a team member from a specific assembly job ───────────────────

export async function addTeamMemberToJob(employeeId, jobId, lineId, splitCount = 1, startTime) {
  const event_timestamp = startTime ?? new Date().toISOString()
  const { data, error } = await supabase.from('job_events')
    .insert({ employee_id: employeeId, job_id: jobId, event_type: 'START', line_id: lineId, split_count: splitCount, event_timestamp })
    .select().single()
  if (error) throw error
  await rebalanceEmployeeSplit(employeeId)
  return data
}

export async function removeTeamMemberFromJob(employeeId, jobId, lineId) {
  const result = await insertEvent({ employee_id: employeeId, job_id: jobId, event_type: 'PAUSE', line_id: lineId, split_count: 1 })
  await rebalanceEmployeeSplit(employeeId, jobId)
  return result
}

// Permanently remove a team member from a job (COMPLETE for that person only).
// Does NOT update jobs.status — this is a per-employee action, not a job completion.
export async function removeTeamMemberPermanently(employeeId, jobId, lineId) {
  return insertEvent({ employee_id: employeeId, job_id: jobId, event_type: 'COMPLETE', line_id: lineId })
}

// ── Find an employee by badge code (for team scanning in Assembly) ─────────────

export async function findTeamMember(badgeCode) {
  const { data, error } = await supabase
    .from('employees')
    .select('employee_id, full_name, badge_code, department, is_line_manager')
    .eq('badge_code', badgeCode.trim())
    .eq('active', true)
    .maybeSingle()
  if (error) throw error
  return data
}

// ── Log a team event for Assembly ─────────────────────────────────────────────
//
// Manager event gets managerSplitCount (how many lines the manager is covering).
// Team member events always get split_count=1 (each person is on one job).
// All events share the same timestamp for deduplication in DB reads.
//
// Returns the manager event data (for local state update of job.events).

export async function logAssemblyTeamEvent(
  managerId, teamMemberIds, jobId, eventType, lineId, holdReason = null, managerSplitCount = 1
) {
  const now = new Date().toISOString()

  // Manager event
  await supabase.from('job_events').insert({
    employee_id:     managerId,
    job_id:          jobId,
    event_type:      eventType,
    line_id:         lineId,
    hold_reason:     holdReason || null,
    split_count:     managerSplitCount,
    event_timestamp: now
  })

  // Team member events (split_count stays at DB default 1)
  for (const empId of teamMemberIds) {
    await supabase.from('job_events').insert({
      employee_id:     empId,
      job_id:          jobId,
      event_type:      eventType,
      line_id:         lineId,
      hold_reason:     holdReason || null,
      event_timestamp: now
    })
  }

  const statusMap = { START: 'in_progress', RESUME: 'in_progress', PAUSE: 'paused', COMPLETE: 'completed' }
  await setJobStatus(jobId, statusMap[eventType] ?? 'in_progress')

  return {
    event_type:      eventType,
    hold_reason:     holdReason,
    split_count:     managerSplitCount,
    event_timestamp: now
  }
}

// ── Pause a job with a hold reason (Paint / Assembly HOLD) ───────────────────

export async function holdJob(employeeId, jobId, holdReason) {
  const ev = await insertEvent({
    employee_id: employeeId,
    job_id:      jobId,
    event_type:  'PAUSE',
    hold_reason: holdReason
  })
  await setJobStatus(jobId, 'paused')
  return ev
}

// ── Assembly manager line-split helpers ──────────────────────────────────────
//
// When a line manager works across multiple lines their time is split evenly.
// These functions update existing active jobs with the new split_count whenever
// the manager starts or finishes on a line, ensuring the division is baked into
// the event log permanently (not just a display-time calculation).

// Returns the manager's current number of active assembly lines.
export async function getManagerLineSplitCount(managerId) {
  const { data: rows } = await supabase
    .from('job_events')
    .select('line_id, job_id, event_type')
    .eq('employee_id', managerId)
    .in('event_type', ['START', 'RESUME', 'PAUSE', 'COMPLETE'])
    .not('line_id', 'is', null)
    .order('event_timestamp', { ascending: true })

  if (!rows?.length) return 1

  const jobStates = new Map()
  for (const row of rows) {
    jobStates.set(`${row.line_id}_${row.job_id}`, row)
  }

  const activeLines = new Set(
    [...jobStates.values()]
      .filter(r => r.event_type === 'START' || r.event_type === 'RESUME')
      .map(r => r.line_id)
  )
  return Math.max(1, activeLines.size)
}

// Call BEFORE starting a new job on targetLineId.
// Closes existing active intervals with old split_count and opens new ones with
// the updated count.  Returns the split_count to use for the new START event.
export async function prepareManagerLineStart(managerId, targetLineId) {
  const { data: rows } = await supabase
    .from('job_events')
    .select('line_id, job_id, event_type, activity_type, work_type')
    .eq('employee_id', managerId)
    .in('event_type', ['START', 'RESUME', 'PAUSE', 'COMPLETE'])
    .not('line_id', 'is', null)
    .order('event_timestamp', { ascending: true })

  if (!rows?.length) return 1

  const jobStates = new Map()
  for (const row of rows) {
    jobStates.set(`${row.line_id}_${row.job_id}`, row)
  }

  const activeJobs = [...jobStates.values()].filter(
    r => r.event_type === 'START' || r.event_type === 'RESUME'
  )
  // Count active jobs (not lines) — two jobs on the same line still splits 50/50
  const newSplitCount = activeJobs.length + 1

  if (newSplitCount > 1 && activeJobs.length > 0) {
    const pauseTs  = new Date().toISOString()
    const resumeTs = new Date(new Date(pauseTs).getTime() + 1).toISOString()
    for (const j of activeJobs) {
      await supabase.from('job_events').insert({
        employee_id: managerId, job_id: j.job_id, event_type: 'PAUSE',
        line_id: j.line_id, event_timestamp: pauseTs
      })
      await supabase.from('job_events').insert({
        employee_id: managerId, job_id: j.job_id, event_type: 'RESUME',
        line_id: j.line_id, activity_type: j.activity_type, work_type: j.work_type,
        split_count: newSplitCount, event_timestamp: resumeTs
      })
    }
  }

  return Math.max(1, newSplitCount)
}

// Call AFTER a manager job ends (COMPLETE or last job on a line finished).
// Recounts active lines and updates remaining jobs with the new split_count.
export async function onManagerLineEnd(managerId) {
  const { data: rows } = await supabase
    .from('job_events')
    .select('line_id, job_id, event_type, activity_type, work_type')
    .eq('employee_id', managerId)
    .in('event_type', ['START', 'RESUME', 'PAUSE', 'COMPLETE'])
    .not('line_id', 'is', null)
    .order('event_timestamp', { ascending: true })

  if (!rows?.length) return 1

  const jobStates = new Map()
  for (const row of rows) {
    jobStates.set(`${row.line_id}_${row.job_id}`, row)
  }

  const activeJobs    = [...jobStates.values()].filter(
    r => r.event_type === 'START' || r.event_type === 'RESUME'
  )
  // Count remaining active jobs after the one that just ended
  const newSplitCount = Math.max(1, activeJobs.length)

  if (activeJobs.length > 0) {
    const pauseTs  = new Date().toISOString()
    const resumeTs = new Date(new Date(pauseTs).getTime() + 1).toISOString()
    for (const j of activeJobs) {
      await supabase.from('job_events').insert({
        employee_id: managerId, job_id: j.job_id, event_type: 'PAUSE',
        line_id: j.line_id, event_timestamp: pauseTs
      })
      await supabase.from('job_events').insert({
        employee_id: managerId, job_id: j.job_id, event_type: 'RESUME',
        line_id: j.line_id, activity_type: j.activity_type, work_type: j.work_type,
        split_count: newSplitCount, event_timestamp: resumeTs
      })
    }
  }

  return newSplitCount
}

// ── Rebalance split_count for all remaining active jobs of an employee ─────────
// excludeJobId: job that was just paused/completed — excluded from the query
// so a Supabase replica-lag race condition can't re-activate it.
export async function rebalanceEmployeeSplit(employeeId, excludeJobId = null) {
  let query = supabase
    .from('job_events')
    .select('job_id, event_type, activity_type, work_type, line_id')
    .eq('employee_id', employeeId)
    .in('event_type', ['START','RESUME','PAUSE','COMPLETE'])
    .order('event_timestamp', { ascending: true })

  if (excludeJobId) query = query.neq('job_id', excludeJobId)

  const { data: rows } = await query
  if (!rows?.length) return

  const jobStates = new Map()
  for (const row of rows) jobStates.set(row.job_id, row)

  const activeJobs    = [...jobStates.values()].filter(r => r.event_type === 'START' || r.event_type === 'RESUME')
  const newSplitCount = Math.max(1, activeJobs.length)

  if (activeJobs.length > 0) {
    const pauseTs  = new Date().toISOString()
    const resumeTs = new Date(new Date(pauseTs).getTime() + 1).toISOString()
    for (const j of activeJobs) {
      await supabase.from('job_events').insert({
        employee_id: employeeId, job_id: j.job_id, event_type: 'PAUSE',
        line_id: j.line_id ?? null, event_timestamp: pauseTs
      })
      await supabase.from('job_events').insert({
        employee_id: employeeId, job_id: j.job_id, event_type: 'RESUME',
        line_id: j.line_id ?? null, activity_type: j.activity_type, work_type: j.work_type,
        split_count: newSplitCount, event_timestamp: resumeTs
      })
    }
  }
}

// ── Manager starts a full assembly job with a team, with optional backdated time ──
// Creates START events for all selected members at the given timestamp.
export async function managerStartAssemblyJobFull(jobId, lineId, memberIds, startTime) {
  const ts = startTime ?? new Date().toISOString()
  const { error } = await supabase.from('job_events').insert(
    memberIds.map(empId => ({
      employee_id: empId, job_id: jobId, event_type: 'START',
      line_id: lineId, split_count: 1, event_timestamp: ts,
    }))
  )
  if (error) throw error
  await setJobStatus(jobId, 'in_progress')
  // Rebalance each member in case they're already active on another job
  for (const empId of memberIds) await rebalanceEmployeeSplit(empId)
}

// ── Fetch all active employees in a department ───────────────────────────────
export async function fetchDepartmentEmployees(department) {
  const { data, error } = await supabase
    .from('employees')
    .select('employee_id, full_name, department, sub_department')
    .eq('department', department)
    .eq('active', true)
    .order('full_name', { ascending: true })
  if (error) throw error
  return data ?? []
}

// ── Manager clocks a worker onto an existing/new job ─────────────────────────
// Pauses any currently active jobs first, then starts the new one at split=1.
// startTime: ISO string — can be backdated by manager.
export async function managerStartWorkerOnJob(employeeId, jobId, lineId, startTime) {
  const { data: rows } = await supabase
    .from('job_events')
    .select('job_id, event_type, line_id')
    .eq('employee_id', employeeId)
    .in('event_type', ['START', 'RESUME', 'PAUSE', 'COMPLETE'])
    .order('event_timestamp', { ascending: true })

  // Find currently active jobs (excluding the target job)
  const jobStates = new Map()
  for (const row of rows ?? []) jobStates.set(row.job_id, row)
  const activeOthers = [...jobStates.values()].filter(
    r => r.job_id !== jobId && (r.event_type === 'START' || r.event_type === 'RESUME')
  )

  // Pause any active jobs before starting the new one
  const pauseTs = new Date().toISOString()
  for (const j of activeOthers) {
    await supabase.from('job_events').insert({
      employee_id: employeeId, job_id: j.job_id, event_type: 'PAUSE',
      line_id: j.line_id ?? null, split_count: 1, event_timestamp: pauseTs,
    })
    await setJobStatus(j.job_id, 'paused')
  }

  // Start the new job at split=1 with the (possibly backdated) timestamp
  const timestamp = startTime ?? new Date().toISOString()
  const { error } = await supabase.from('job_events').insert({
    employee_id: employeeId, job_id: jobId, event_type: 'START',
    line_id: lineId ?? null, split_count: 1, event_timestamp: timestamp,
  })
  if (error) throw error
  await setJobStatus(jobId, 'in_progress')
}

// ── Clock a single assembly team member off (PAUSE) or on (RESUME) ────────────
// Recalculates job status afterwards. Called from manager report.
export async function managerToggleAssemblyMember(employeeId, jobId, lineId, currentlyActive, allJobMembers) {
  const now = new Date().toISOString()
  if (currentlyActive) {
    const { error: e1 } = await supabase.from('job_events').insert({
      employee_id: employeeId, job_id: jobId, event_type: 'PAUSE',
      line_id: lineId ?? null, split_count: 1, event_timestamp: now
    })
    if (e1) throw e1
    const othersActive = allJobMembers.some(m =>
      m.employee_id !== employeeId && (m.lastEvent === 'START' || m.lastEvent === 'RESUME')
    )
    if (!othersActive) await setJobStatus(jobId, 'paused')
  } else {
    const { error: e2 } = await supabase.from('job_events').insert({
      employee_id: employeeId, job_id: jobId, event_type: 'RESUME',
      line_id: lineId ?? null, split_count: 1, event_timestamp: now
    })
    if (e2) throw e2
    await setJobStatus(jobId, 'in_progress')
  }
  // Rebalance remaining jobs — exclude this one to avoid replica-lag race condition
  await rebalanceEmployeeSplit(employeeId, jobId)
}

// ── Manager live report ───────────────────────────────────────────────────────

export async function loadManagerReport() {
  const { data: rows, error } = await supabase
    .from('job_events')
    .select(`
      event_id, job_id, employee_id, event_type, hold_reason, line_id, split_count, event_timestamp,
      jobs ( job_id, po_number, part_number, quantity, status ),
      employees ( employee_id, full_name, department, sub_department, active )
    `)
    .in('event_type', ['START','PAUSE','RESUME','COMPLETE','AUTO_LOGOUT'])
    .order('event_timestamp', { ascending: true })

  if (error) throw error
  if (!rows?.length) return { individual: {}, assembly: {} }

  const empMap = new Map()
  const asmMap = new Map() // lineId_jobId → {job, lineId, events, empStates}

  for (const row of rows) {
    if (!row.jobs || !row.employees || !row.employees.active) continue
    // Exclude completed jobs — derive from event log, not jobs.status which can lag
    if (row.jobs.status === 'completed') continue
    const emp  = row.employees
    const dept = emp.department

    if (dept === 'assembly') {
      const key = String(row.job_id)
      if (!asmMap.has(key)) {
        asmMap.set(key, {
          job:      row.jobs,
          lineId:   row.line_id ?? null,
          empData:  new Map()   // empId → { full_name, events[], lastEvent }
        })
      } else if (row.line_id != null && asmMap.get(key).lineId == null) {
        asmMap.get(key).lineId = row.line_id
      }
      const entry = asmMap.get(key)
      if (!entry.empData.has(emp.employee_id)) {
        entry.empData.set(emp.employee_id, {
          employee_id: emp.employee_id,
          full_name:   emp.full_name,
          events:      [],
          lastEvent:   null
        })
      }
      const empEntry = entry.empData.get(emp.employee_id)
      empEntry.events.push({
        event_type:      row.event_type,
        hold_reason:     row.hold_reason,
        split_count:     row.split_count ?? 1,
        event_timestamp: row.event_timestamp
      })
      empEntry.lastEvent = row.event_type
    } else {
      if (!empMap.has(emp.employee_id)) {
        empMap.set(emp.employee_id, { emp, jobMap: new Map() })
      }
      const empEntry = empMap.get(emp.employee_id)
      if (!empEntry.jobMap.has(row.job_id)) {
        empEntry.jobMap.set(row.job_id, { ...row.jobs, events: [] })
      }
      empEntry.jobMap.get(row.job_id).events.push({
        event_type:      row.event_type,
        hold_reason:     row.hold_reason,
        split_count:     row.split_count ?? 1,
        event_timestamp: row.event_timestamp
      })
    }
  }

  const individual = {}
  for (const { emp, jobMap } of empMap.values()) {
    const dept = emp.department
    if (!individual[dept]) individual[dept] = []
    const jobs = []
    for (const job of jobMap.values()) {
      const last = [...job.events].sort(
        (a,b) => new Date(b.event_timestamp) - new Date(a.event_timestamp)
      )[0]
      if (!last) continue
      const isActive = last.event_type === 'START' || last.event_type === 'RESUME'
      const isHeld   = last.event_type === 'PAUSE' || last.event_type === 'AUTO_LOGOUT'
      if (isActive || isHeld) jobs.push({ ...job, isActive, holdReason: isActive ? null : last.hold_reason })
    }
    if (jobs.length) individual[dept].push({ emp, jobs })
  }

  const assembly = {}
  for (const { job, lineId, empData } of asmMap.values()) {
    const groupKey = lineId != null ? String(lineId) : 'unassigned'
    if (!assembly[groupKey]) assembly[groupKey] = []
    const members = [...empData.values()]
    if (!members.length) continue

    // Job is active/held if any member is active/held
    const anyActive = members.some(m => m.lastEvent === 'START' || m.lastEvent === 'RESUME')
    const anyHeld   = !anyActive && members.some(m => m.lastEvent === 'PAUSE')
    if (!anyActive && !anyHeld) continue

    // Hold reason only if the most recent PAUSE event (across all members) has one
    const lastPauseEv = members
      .flatMap(m => m.events)
      .filter(e => e.event_type === 'PAUSE')
      .sort((a, b) => new Date(b.event_timestamp) - new Date(a.event_timestamp))[0]

    const activeTeam = members.filter(m => m.lastEvent === 'START' || m.lastEvent === 'RESUME')

    assembly[groupKey].push({
      job,
      lineId,        // actual lineId (number or null) — used by action handlers
      members,       // all members with individual events arrays — used for total time calc
      isActive: anyActive,
      holdReason: lastPauseEv?.hold_reason ?? null,
      team: activeTeam
    })
  }

  return { individual, assembly }
}

// ── Session resume ───────────────────────────────────────────────────────────

export async function handleSessionResume(employeeId) {
  const { data: rows } = await supabase
    .from('job_events')
    .select('job_id, event_type')
    .eq('employee_id', employeeId)
    .in('event_type', ['START','PAUSE','RESUME','COMPLETE','AUTO_LOGOUT'])
    .order('event_timestamp', { ascending: true })

  if (!rows || rows.length === 0) return { splitMode: false }

  const jobLastEvent = new Map()
  for (const ev of rows) {
    jobLastEvent.set(ev.job_id, ev.event_type)
  }

  const activeCount = [...jobLastEvent.values()].filter(
    t => t === 'START' || t === 'RESUME'
  ).length

  return { splitMode: activeCount > 1 }
}

// ── Paint batch functions ─────────────────────────────────────────────────────

const STAGE_NEXT = {
  blast: 'blast_done',
  prep:  'prep_done',
  paint: 'paint_done',
  pack:  'complete',
}

export async function createPaintBatch(employeeId) {
  const { data, error } = await supabase
    .from('paint_batches')
    .insert({ created_by: employeeId, current_stage: 'blast' })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function loadActivePaintBatch(employeeId, stage) {
  if (stage === 'blast') {
    const { data } = await supabase
      .from('paint_batches')
      .select('*, paint_batch_jobs(*, jobs(job_id, po_number, part_number, quantity)), paint_batch_members(*, employees(employee_id, full_name))')
      .eq('created_by', employeeId)
      .eq('current_stage', 'blast')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    return data ?? null
  }
  const { data } = await supabase
    .from('paint_batch_members')
    .select('paint_batches!inner(*, paint_batch_jobs(*, jobs(job_id, po_number, part_number, quantity)), paint_batch_members(*, employees(employee_id, full_name)))')
    .eq('employee_id', employeeId)
    .eq('stage', stage)
    .eq('paint_batches.current_stage', stage)
    .limit(1)
    .maybeSingle()
  return data?.paint_batches ?? null
}

export async function loadAvailablePaintBatches(forStage) {
  const stageMap = { prep: 'blast_done', paint: 'prep_done', pack: 'paint_done' }
  const required = stageMap[forStage]
  if (!required) return []
  const { data, error } = await supabase
    .from('paint_batches')
    .select('*, paint_batch_jobs(*, jobs(job_id, po_number, part_number, quantity))')
    .eq('current_stage', required)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

// For prep: load all individual unclaimed jobs from blast_done batches
export async function loadAvailablePoolJobs() {
  const { data, error } = await supabase
    .from('paint_batch_jobs')
    .select('*, jobs(job_id, po_number, part_number, quantity), paint_batches!inner(batch_id, batch_number, current_stage)')
    .eq('paint_batches.current_stage', 'blast_done')
    .eq('status', 'available')
    .order('added_at', { ascending: true })
  if (error) throw error
  return data ?? []
}

// Returns status of all 3 booths currently in prep stage
export async function getBoothStatus() {
  const { data } = await supabase
    .from('paint_batches')
    .select('batch_id, booth_number, paint_batch_jobs(count), paint_batch_members(employees(full_name))')
    .eq('current_stage', 'prep')
    .not('booth_number', 'is', null)
  const map = { 1: null, 2: null, 3: null }
  for (const b of data ?? []) map[b.booth_number] = b
  return map   // { 1: batch|null, 2: batch|null, 3: batch|null }
}

// Prep selects jobs and assigns them to a booth (join existing or create new)
export async function joinOrCreatePrepBooth(boothNumber, employeeId, selectedBatchJobIds) {
  // Find or create a prep batch for this booth number
  const { data: existing } = await supabase
    .from('paint_batches')
    .select('batch_id')
    .eq('current_stage', 'prep')
    .eq('booth_number', boothNumber)
    .limit(1)
    .maybeSingle()

  let batchId
  if (existing) {
    batchId = existing.batch_id
  } else {
    const { data: newBatch, error } = await supabase
      .from('paint_batches')
      .insert({ created_by: employeeId, current_stage: 'prep', booth_number: boothNumber })
      .select('batch_id')
      .single()
    if (error) throw error
    batchId = newBatch.batch_id
  }

  // Copy selected jobs into this booth batch
  if (selectedBatchJobIds.length > 0) {
    const { data: sourceJobs, error: sErr } = await supabase
      .from('paint_batch_jobs')
      .select('id, job_id, work_type')
      .in('id', selectedBatchJobIds)
    if (sErr) throw sErr

    await supabase.from('paint_batch_jobs').insert(
      sourceJobs.map(j => ({ batch_id: batchId, job_id: j.job_id, work_type: j.work_type }))
    )
    await supabase.from('paint_batch_jobs').update({ status: 'claimed' }).in('id', selectedBatchJobIds)

    // Advance any fully-claimed blast batches
    const blastIds = [...new Set(
      (await supabase.from('paint_batch_jobs').select('batch_id').in('id', selectedBatchJobIds)).data?.map(r => r.batch_id) ?? []
    )]
    for (const bid of blastIds) {
      const { count } = await supabase.from('paint_batch_jobs')
        .select('*', { count: 'exact', head: true }).eq('batch_id', bid).eq('status', 'available')
      if (count === 0) await supabase.from('paint_batches').update({ current_stage: 'consumed' }).eq('batch_id', bid)
    }
  }

  // Add this employee as a member of this booth
  await supabase.from('paint_batch_members')
    .upsert({ batch_id: batchId, employee_id: employeeId, stage: 'prep' }, { onConflict: 'batch_id,employee_id,stage' })

  // Load full batch for return
  const { data: batch } = await supabase
    .from('paint_batches')
    .select('*, paint_batch_jobs(*, jobs(job_id, po_number, part_number, quantity)), paint_batch_members(*, employees(employee_id, full_name))')
    .eq('batch_id', batchId)
    .single()
  return batch
}

export async function addJobToPaintBatch(batchId, poNumber, partNumber, workType) {
  const { job } = await findOrCreateJob(poNumber, partNumber, 'paint')
  const { error } = await supabase
    .from('paint_batch_jobs')
    .upsert({ batch_id: batchId, job_id: job.job_id, work_type: workType }, { onConflict: 'batch_id,job_id' })
  if (error) throw error
  return job
}

export async function removeJobFromPaintBatch(batchId, jobId) {
  const { error } = await supabase
    .from('paint_batch_jobs')
    .delete()
    .eq('batch_id', batchId)
    .eq('job_id', jobId)
  if (error) throw error
}

export async function getPaintBatchStartTime(batchId) {
  const { data } = await supabase
    .from('job_events')
    .select('event_timestamp')
    .eq('batch_id', batchId)
    .eq('event_type', 'START')
    .order('event_timestamp', { ascending: true })
    .limit(1)
    .maybeSingle()
  return data?.event_timestamp ?? null
}

// Write a member to paint_batch_members immediately (before start) so they see the batch via polling
export async function addBatchMember(batchId, employeeId, stage) {
  await supabase.from('paint_batch_members')
    .upsert({ batch_id: batchId, employee_id: employeeId, stage }, { onConflict: 'batch_id,employee_id,stage' })
}

// Add a member to an already-running batch — writes member record + START events from now
export async function addActiveBatchMember(batchId, employeeId, stage, batchJobs) {
  const now = new Date().toISOString()
  const splitCount = Math.max(batchJobs.length, 1)

  await supabase.from('paint_batch_members')
    .upsert({ batch_id: batchId, employee_id: employeeId, stage }, { onConflict: 'batch_id,employee_id,stage' })

  const events = batchJobs.map(bj => ({
    employee_id:     employeeId,
    job_id:          bj.job_id,
    event_type:      'START',
    event_timestamp: now,
    split_count:     splitCount,
    batch_id:        batchId,
  }))
  if (events.length) {
    const { error } = await supabase.from('job_events').insert(events)
    if (error) throw error
  }
}

export async function startPaintBatchStage(batchId, stage, memberIds, batchJobs) {
  const now = new Date().toISOString()
  const splitCount = Math.max(batchJobs.length, 1)

  if (memberIds.length > 0) {
    await supabase.from('paint_batch_members')
      .upsert(memberIds.map(id => ({ batch_id: batchId, employee_id: id, stage })), { onConflict: 'batch_id,employee_id,stage' })
  }

  const events = memberIds.flatMap(employeeId =>
    batchJobs.map(bj => ({
      employee_id: employeeId,
      job_id: bj.job_id,
      event_type: 'START',
      event_timestamp: now,
      split_count: splitCount,
      batch_id: batchId,
    }))
  )
  if (events.length > 0) {
    const { error } = await supabase.from('job_events').insert(events)
    if (error) throw error
  }

  const { error } = await supabase
    .from('paint_batches')
    .update({ current_stage: stage })
    .eq('batch_id', batchId)
  if (error) throw error
  return now
}

export async function completePaintBatchStage(batchId, stage, memberIds, batchJobs) {
  const nextStage = STAGE_NEXT[stage]
  const now = new Date().toISOString()

  const events = memberIds.flatMap(employeeId =>
    batchJobs.map(bj => ({
      employee_id: employeeId,
      job_id: bj.job_id,
      event_type: 'COMPLETE',
      event_timestamp: now,
      batch_id: batchId,
    }))
  )
  if (events.length > 0) {
    const { error } = await supabase.from('job_events').insert(events)
    if (error) throw error
  }

  const update = { current_stage: nextStage }
  if (nextStage === 'complete') update.completed_at = now
  const { error } = await supabase.from('paint_batches').update(update).eq('batch_id', batchId)
  if (error) throw error
}

// ── Job history ───────────────────────────────────────────────────────────────

// Load completed job events with employee and job info, optionally filtered by date range
export async function loadJobHistory({ fromDate, toDate, department } = {}) {
  let q = supabase
    .from('job_events')
    .select('event_id, event_type, event_timestamp, split_count, employee_id, job_id, batch_id, employees(full_name, department, sub_department), jobs(job_id, po_number, part_number, quantity, department)')
    .in('event_type', ['START', 'PAUSE', 'RESUME', 'COMPLETE'])
    .order('event_timestamp', { ascending: false })

  if (fromDate) q = q.gte('event_timestamp', fromDate)
  if (toDate)   q = q.lte('event_timestamp', toDate)
  if (department) q = q.eq('jobs.department', department)

  const { data, error } = await q.limit(2000)
  if (error) throw error

  // Group all events by job_id+employee_id pair
  const pairs = new Map()
  for (const ev of data ?? []) {
    if (!ev.jobs) continue
    const dept = ev.jobs.department
    if (department && dept !== department) continue
    const key = `${ev.job_id}__${ev.employee_id}`
    if (!pairs.has(key)) {
      pairs.set(key, {
        job_id: ev.job_id,
        employee_id: ev.employee_id,
        po_number: ev.jobs.po_number,
        part_number: ev.jobs.part_number,
        quantity: ev.jobs.quantity,
        department: dept,
        sub_department: ev.employees?.sub_department,
        full_name: ev.employees?.full_name,
        events: [],
        batch_id: ev.batch_id,
      })
    }
    pairs.get(key).events.push(ev)
  }

  return [...pairs.values()]
}

// Load full event list for a specific job+employee pair (for the edit modal)
export async function loadJobEvents(jobId, employeeId) {
  const { data, error } = await supabase
    .from('job_events')
    .select('event_id, event_type, event_timestamp, split_count')
    .eq('job_id', jobId)
    .eq('employee_id', employeeId)
    .order('event_timestamp', { ascending: true })
  if (error) throw error
  return data ?? []
}

// Update a single event's timestamp
export async function updateEventTimestamp(eventId, newIsoTimestamp) {
  const { error } = await supabase
    .from('job_events')
    .update({ event_timestamp: newIsoTimestamp })
    .eq('event_id', eventId)
  if (error) throw error
}
