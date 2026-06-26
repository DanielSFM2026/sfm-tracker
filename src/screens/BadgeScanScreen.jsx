import { useEffect, useRef, useState } from 'react'
import { findEmployee, logLogin, loadEmployeeJobs, handleSessionResume } from '../lib/db'

const MANAGER_PIN = import.meta.env.VITE_MANAGER_PIN ?? '1234'

// ── PIN pad modal ─────────────────────────────────────────────────────────────
function PinModal({ onSuccess, onCancel }) {
  const [pin, setPin] = useState('')
  const [shake, setShake] = useState(false)

  function press(digit) {
    if (pin.length >= 4) return
    const next = pin + digit
    setPin(next)
    if (next.length === 4) {
      if (next === MANAGER_PIN) {
        onSuccess()
      } else {
        setShake(true)
        setTimeout(() => { setPin(''); setShake(false) }, 600)
      }
    }
  }

  function del() { setPin(p => p.slice(0, -1)) }

  const DIGITS = ['1','2','3','4','5','6','7','8','9','','0','⌫']

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl p-8 w-full max-w-xs">
        <h2 className="text-xl font-bold text-stone-100 text-center mb-2">Manager PIN</h2>
        <p className="text-stone-500 text-sm text-center mb-6">Enter your 4-digit PIN</p>

        {/* Dots */}
        <div className={`flex justify-center gap-4 mb-8 transition-transform ${shake ? 'animate-shake' : ''}`}>
          {[0,1,2,3].map(i => (
            <div key={i} className={`w-4 h-4 rounded-full border-2 transition-colors ${
              i < pin.length
                ? 'bg-amber-400 border-amber-400'
                : 'border-stone-600'
            }`} />
          ))}
        </div>

        {/* Keypad */}
        <div className="grid grid-cols-3 gap-3">
          {DIGITS.map((d, i) => (
            d === '' ? <div key={i} /> :
            d === '⌫' ? (
              <button
                key={i}
                onClick={del}
                className="bg-stone-700 hover:bg-stone-600 active:bg-stone-500 rounded-xl
                           py-4 text-xl text-stone-300 font-semibold transition-colors"
              >
                ⌫
              </button>
            ) : (
              <button
                key={i}
                onClick={() => press(d)}
                className="bg-stone-700 hover:bg-stone-600 active:bg-amber-500/30 rounded-xl
                           py-4 text-xl text-stone-100 font-semibold transition-colors"
              >
                {d}
              </button>
            )
          ))}
        </div>

        <button
          onClick={onCancel}
          className="w-full mt-4 text-sm text-stone-500 underline"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── Badge scan screen ─────────────────────────────────────────────────────────
export default function BadgeScanScreen({ onLogin, onManagerView }) {
  const inputRef  = useRef(null)
  const bufferRef = useRef('')
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(false)
  const [showPin, setShowPin] = useState(false)

  useEffect(() => {
    const el = inputRef.current
    if (el) el.focus()

    function refocus() {
      if (!showPin && inputRef.current && document.activeElement !== inputRef.current) {
        inputRef.current.focus()
      }
    }

    document.addEventListener('click', refocus)
    document.addEventListener('touchend', refocus)
    return () => {
      document.removeEventListener('click', refocus)
      document.removeEventListener('touchend', refocus)
    }
  }, [showPin])

  async function handleScan(badgeCode) {
    if (loading || !badgeCode.trim()) return
    setLoading(true)
    setError('')
    try {
      const employee = await findEmployee(badgeCode.trim())
      if (!employee) {
        setError(`Badge not recognised: ${badgeCode}`)
        setLoading(false)
        return
      }

      await logLogin(employee.employee_id)

      let jobs = []
      let splitMode = false
      if (employee.department !== 'assembly') {
        const { splitMode: sm } = await handleSessionResume(employee.employee_id)
        jobs = await loadEmployeeJobs(employee.employee_id)
        splitMode = sm
      }

      onLogin(employee, jobs, splitMode)
    } catch (err) {
      console.error(err)
      const msg = !import.meta.env.VITE_SUPABASE_URL
        ? 'Supabase not configured — add your project URL and anon key.'
        : 'Connection error — check your network and try again.'
      setError(msg)
      setLoading(false)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      const val = bufferRef.current
      bufferRef.current = ''
      e.target.value = ''
      handleScan(val)
    }
  }

  function handleInput(e) {
    bufferRef.current = e.target.value
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen px-8 gap-10">
      <input
        ref={inputRef}
        className="scan-input"
        type="text"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        aria-hidden="true"
      />

      <div className="text-center">
        <div className="text-amber-500 text-6xl mb-4" aria-hidden="true">⚙</div>
        <h1 className="text-4xl font-bold text-stone-100 tracking-tight">
          SFM Job Tracker
        </h1>
      </div>

      <div className="bg-stone-800 border-2 border-amber-500 rounded-2xl px-10 py-8 text-center max-w-sm w-full">
        {loading ? (
          <p className="text-2xl text-amber-400 font-semibold animate-pulse">
            Looking up badge…
          </p>
        ) : (
          <>
            <p className="text-stone-400 text-sm uppercase tracking-widest mb-3">
              Scan your employee badge to begin
            </p>
            <p className="text-5xl">🪪</p>
          </>
        )}
      </div>

      <button
        onTouchStart={() => inputRef.current?.blur()}
        onClick={() => setShowPin(true)}
        className="text-stone-600 hover:text-stone-400 text-sm underline transition-colors"
      >
        📊 Manager View
      </button>

      {error && (
        <div className="bg-red-900/60 border border-red-600 rounded-xl px-6 py-4 text-center max-w-sm w-full">
          <p className="text-red-300 font-medium">{error}</p>
          <button className="mt-3 text-sm text-stone-400 underline" onClick={() => setError('')}>
            Dismiss
          </button>
        </div>
      )}

      {showPin && (
        <PinModal
          onSuccess={() => { setShowPin(false); onManagerView() }}
          onCancel={() => setShowPin(false)}
        />
      )}
    </div>
  )
}
