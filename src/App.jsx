import { useState, useEffect } from 'react'
import { fetchBreakRules } from './lib/db'
import BadgeScanScreen    from './screens/BadgeScanScreen'
import DashboardScreen    from './screens/DashboardScreen'
import AssemblyDashboard   from './screens/AssemblyDashboard'
import PaintDashboard     from './screens/PaintDashboard'
import KittingDashboard   from './screens/KittingDashboard'
import ManagerReport      from './screens/ManagerReport'

const DEPT_SCREEN = {
  weld:     DashboardScreen,
  assembly: AssemblyDashboard,
  paint:    PaintDashboard,
  kitting:  KittingDashboard,
}

export default function App() {
  const [screen, setScreen]               = useState('badge')
  const [employee, setEmployee]           = useState(null)
  const [initialJobs, setInitialJobs]     = useState([])
  const [initialSplitMode, setSplitMode]  = useState(false)
  const [breakRules, setBreakRules]       = useState([])

  useEffect(() => {
    fetchBreakRules()
      .then(setBreakRules)
      .catch(err => console.error('Failed to load break rules:', err))
  }, [])

  function handleLogin(emp, jobs, splitMode = false) {
    setEmployee(emp)
    setInitialJobs(jobs)
    setSplitMode(splitMode)
    setScreen('dashboard')
  }

  function handleLogout() {
    setEmployee(null)
    setInitialJobs([])
    setSplitMode(false)
    setScreen('badge')
  }

  if (screen === 'badge') {
    return <BadgeScanScreen onLogin={handleLogin} onManagerView={() => setScreen('report')} />
  }

  if (screen === 'report') {
    return <ManagerReport onBack={() => setScreen('badge')} />
  }

  const DeptScreen = DEPT_SCREEN[employee?.department] ?? DashboardScreen
  return (
    <DeptScreen
      employee={employee}
      initialJobs={initialJobs}
      initialSplitMode={initialSplitMode}
      breakRules={breakRules}
      onLogout={handleLogout}
    />
  )
}
