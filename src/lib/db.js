import { supabase } from './supabase'

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
    .eq('badge_code', badgeCode)
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
      event_id, job_id, event_type, activity_type, event_timestamp,
      jobs ( job_id, po_number, part_number, quantity, status )
    `)
    .eq('employee_id', employeeId)
    .in('event_type', ['START','PAUSE','RESUME','COMPLETE','AUTO_LOGOUT','JOB_CREATED'])
    .order('event_timestamp', { ascending: true })

  if (error) throw error
  if (!rows || rows.length === 0) return []

  // Group events by job_id
  const map = new Map()
  for (const row of rows) {
    if (!row.job_id || !row.jobs) continue
    if (!map.has(row.job_id)) {
      map.set(row.job_id, {
        ...row.jobs,
        events: []
      })
    }
    map.get(row.job_id).events.push({
      event_id:        row.event_id,
      job_id:          row.job_id,
      event_type:      row.event_type,
      activity_type:   row.activity_type,
      event_timestamp: row.event_timestamp
    })
  }

  // Drop completed jobs
  const result = []
  for (const job of map.values()) {
    const last = job.events[job.events.length - 1]
    if (last.event_type !== 'COMPLETE') result.push(job)
  }
  return result
}

// ── Find or create a job by PO + part ────────────────────────────────────────

export async function findOrCreateJob(poNumber, partNumber) {
  // Try existing
  const { data: existing } = await supabase
    .from('jobs')
    .select('*')
    .eq('po_number', poNumber)
    .eq('part_number', partNumber)
    .maybeSingle()
  if (existing) return { job: existing, created: false }

  // Create
  const { data, error } = await supabase
    .from('jobs')
    .insert({ po_number: poNumber, part_number: partNumber, status: 'not_started' })
    .select()
    .single()
  if (error) throw error
  return { job: data, created: true }
}

// ── Update jobs.status cache ──────────────────────────────────────────────────

export async function setJobStatus(jobId, status) {
  await supabase.from('jobs').update({ status }).eq('job_id', jobId)
}

// ── High-level job actions ────────────────────────────────────────────────────

/**
 * Start a brand-new job for this employee (job was just created or is
 * being started for the first time by this employee).
 * Returns the two inserted events [JOB_CREATED?, START].
 */
export async function startNewJob(employeeId, jobId, wasCreated, activityType, workType) {
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
      work_type:     workType
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
 */
export async function resumeJob(employeeId, jobId, activityType, workType) {
  const ev = await insertEvent({
    employee_id:   employeeId,
    job_id:        jobId,
    event_type:    'RESUME',
    activity_type: activityType,
    work_type:     workType
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
 * activeJobIds can be a single id string or an array.
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
// managerId is used to isolate timeline events (manager controls HOLD/RESUME/FINISH).
// Team membership is derived from all other employees' last event on each job.

export async function loadLineJobs(lineId, managerId) {
  const { data: rows, error } = await supabase
    .from('job_events')
    .select(`
      event_id, job_id, employee_id, event_type, hold_reason, event_timestamp,
      jobs ( job_id, po_number, part_number, quantity, status ),
      employees ( employee_id, full_name, badge_code )
    `)
    .eq('line_id', lineId)
    .in('event_type', ['START','PAUSE','RESUME','COMPLETE'])
    .order('event_timestamp', { ascending: true })

  if (error) throw error
  if (!rows?.length) return []

  const jobMap    = new Map() // job_id → job object with events + team
  const empState  = new Map() // job_id → Map<emp_id, {emp, lastEvent}>

  for (const row of rows) {
    if (!row.job_id || !row.jobs) continue

    if (!jobMap.has(row.job_id)) {
      jobMap.set(row.job_id, { ...row.jobs, events: [] })
      empState.set(row.job_id, new Map())
    }

    // Only manager events drive the job timeline (timer + active/held status)
    if (row.employee_id === managerId) {
      jobMap.get(row.job_id).events.push({
        event_id:        row.event_id,
        event_type:      row.event_type,
        hold_reason:     row.hold_reason,
        event_timestamp: row.event_timestamp
      })
    }

    // Track per-employee last event for team membership
    if (row.employee_id && row.employees) {
      empState.get(row.job_id).set(row.employee_id, {
        employee_id: row.employees.employee_id,
        full_name:   row.employees.full_name,
        badge_code:  row.employees.badge_code,
        lastEvent:   row.event_type
      })
    }
  }

  const result = []
  for (const [jobId, job] of jobMap) {
    const last = job.events[job.events.length - 1]
    if (last?.event_type === 'COMPLETE') continue

    // Team = non-manager employees with last event START or RESUME
    const emps = empState.get(jobId) ?? new Map()
    job.team = [...emps.values()]
      .filter(e => e.employee_id !== managerId)
      .filter(e => e.lastEvent === 'START' || e.lastEvent === 'RESUME')
      .map(({ employee_id, full_name, badge_code }) => ({ employee_id, full_name, badge_code }))

    result.push(job)
  }
  return result
}

// ── Add / remove a team member from a specific assembly job ───────────────────

export async function addTeamMemberToJob(employeeId, jobId, lineId) {
  const ev = await insertEvent({
    employee_id: employeeId,
    job_id:      jobId,
    event_type:  'START',
    line_id:     lineId
  })
  return ev
}

export async function removeTeamMemberFromJob(employeeId, jobId, lineId) {
  const ev = await insertEvent({
    employee_id: employeeId,
    job_id:      jobId,
    event_type:  'PAUSE',
    line_id:     lineId
  })
  return ev
}

// ── Find an employee by badge code (for team scanning in Assembly) ─────────────

export async function findTeamMember(badgeCode) {
  const { data, error } = await supabase
    .from('employees')
    .select('employee_id, full_name, badge_code, department')
    .eq('badge_code', badgeCode.trim())
    .eq('active', true)
    .maybeSingle()
  if (error) throw error
  return data
}

// ── Log a team event for Assembly (fires for manager + all team members) ───────
// All events get the same timestamp so deduplication works in loadLineJobs.

export async function logAssemblyTeamEvent(employeeIds, jobId, eventType, lineId, holdReason = null) {
  const now = new Date().toISOString()
  for (const empId of employeeIds) {
    await insertEvent({
      employee_id:     empId,
      job_id:          jobId,
      event_type:      eventType,
      line_id:         lineId,
      hold_reason:     holdReason || null,
      event_timestamp: now
    })
  }
  const statusMap = {
    START:    'in_progress',
    RESUME:   'in_progress',
    PAUSE:    'paused',
    COMPLETE: 'completed'
  }
  await setJobStatus(jobId, statusMap[eventType] ?? 'in_progress')
  return { event_type: eventType, hold_reason: holdReason, event_timestamp: now }
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

// ── Manager live report ───────────────────────────────────────────────────────
// Returns all active/paused job states across every department.
// Assembly is grouped by line+job with team members listed.

export async function loadManagerReport() {
  const { data: rows, error } = await supabase
    .from('job_events')
    .select(`
      event_id, job_id, employee_id, event_type, hold_reason, line_id, event_timestamp,
      jobs ( job_id, po_number, part_number, quantity ),
      employees ( employee_id, full_name, department, sub_department, active )
    `)
    .in('event_type', ['START','PAUSE','RESUME','COMPLETE','AUTO_LOGOUT'])
    .order('event_timestamp', { ascending: true })

  if (error) throw error
  if (!rows?.length) return { individual: {}, assembly: {} }

  // ── Individual departments (weld / paint / kitting) ────────────────────────
  // Key: employee_id → job_id → {job, events, emp}
  const empMap = new Map()

  // ── Assembly ───────────────────────────────────────────────────────────────
  // Key: lineId_jobId → {job, lineId, events (deduped), empStates}
  const asmMap = new Map()

  for (const row of rows) {
    if (!row.jobs || !row.employees || !row.employees.active) continue
    const emp  = row.employees
    const dept = emp.department

    if (dept === 'assembly') {
      if (!row.line_id) continue
      const key = `${row.line_id}_${row.job_id}`
      if (!asmMap.has(key)) {
        asmMap.set(key, {
          job:       row.jobs,
          lineId:    row.line_id,
          events:    [],
          seenKeys:  new Set(),
          empStates: new Map()
        })
      }
      const entry = asmMap.get(key)
      // Deduplicate events by type+timestamp (whole team fires simultaneously)
      const eKey = `${row.event_type}_${row.event_timestamp}`
      if (!entry.seenKeys.has(eKey)) {
        entry.seenKeys.add(eKey)
        entry.events.push({
          event_type:      row.event_type,
          hold_reason:     row.hold_reason,
          event_timestamp: row.event_timestamp
        })
      }
      // Track per-employee state for team display
      entry.empStates.set(emp.employee_id, {
        employee_id: emp.employee_id,
        full_name:   emp.full_name,
        lastEvent:   row.event_type
      })
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
        event_timestamp: row.event_timestamp
      })
    }
  }

  // ── Build individual result grouped by department ──────────────────────────
  const individual = {} // dept → [{emp, jobs: [{...job, events, isActive}]}]
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

  // ── Build assembly result grouped by lineId → jobs ────────────────────────
  const assembly = {} // lineId → [{job, events, isActive, holdReason, team}]
  for (const { job, lineId, events, empStates } of asmMap.values()) {
    if (!assembly[lineId]) assembly[lineId] = []
    const last = events[events.length - 1]
    if (!last) continue
    const isActive = last.event_type === 'START' || last.event_type === 'RESUME'
    const isHeld   = last.event_type === 'PAUSE'
    if (!isActive && !isHeld) continue
    const team = [...empStates.values()].filter(
      e => e.lastEvent === 'START' || e.lastEvent === 'RESUME'
    )
    assembly[lineId].push({
      job,
      events,
      isActive,
      holdReason: isActive ? null : last.hold_reason,
      team
    })
  }

  return { individual, assembly }
}

// ── Session resume ───────────────────────────────────────────────────────────
//
// Jobs keep running even when the welder is not logged into the scanner —
// "Done" and inactivity timeout just reset the screen, they don't pause jobs.
// Only a manual Pause stops the clock.
//
// On login we just need to check how many jobs are currently active so we
// can restore split mode automatically if more than one is running.

export async function handleSessionResume(employeeId) {
  const { data: rows } = await supabase
    .from('job_events')
    .select('job_id, event_type')
    .eq('employee_id', employeeId)
    .in('event_type', ['START','PAUSE','RESUME','COMPLETE','AUTO_LOGOUT'])
    .order('event_timestamp', { ascending: true })

  if (!rows || rows.length === 0) return { splitMode: false }

  // Find each job's last relevant event
  const jobLastEvent = new Map()
  for (const ev of rows) {
    jobLastEvent.set(ev.job_id, ev.event_type)
  }

  const activeCount = [...jobLastEvent.values()].filter(
    t => t === 'START' || t === 'RESUME'
  ).length

  return { splitMode: activeCount > 1 }
}
