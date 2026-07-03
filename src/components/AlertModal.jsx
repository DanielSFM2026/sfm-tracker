import { useState } from 'react'

// Report-issue modal shared by all department dashboards.
// `context` is the subtitle line (e.g. "Line 3 · PO 776005 · BR-2214").
// `onSend(message)` should store the alert and notify management.
export default function AlertModal({ context, onSend, onCancel }) {
  const [message, setMessage] = useState('')
  const [busy, setBusy]       = useState(false)
  const [sent, setSent]       = useState(false)
  const [error, setError]     = useState('')

  async function handleSend() {
    if (!message.trim()) return
    setBusy(true); setError('')
    try {
      await onSend(message.trim())
      setSent(true)
    } catch {
      setError('Failed to send alert — check connection.')
    } finally {
      setBusy(false)
    }
  }

  if (sent) return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl p-6 w-full max-w-sm text-center">
        <p className="text-3xl mb-3">✓</p>
        <p className="text-stone-100 font-bold mb-1">Alert Sent</p>
        <p className="text-stone-400 text-sm mb-5">Management has been notified.</p>
        <button className="w-full btn-secondary py-3" onClick={onCancel}>Close</button>
      </div>
    </div>
  )

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 px-6">
      <div className="bg-stone-800 border border-stone-600 rounded-2xl p-6 w-full max-w-sm">
        <h2 className="text-lg font-bold text-stone-100 mb-1">Report Issue</h2>
        <p className="text-stone-500 text-sm mb-4">{context}</p>
        <textarea
          autoFocus
          rows={4}
          value={message}
          onChange={e => setMessage(e.target.value)}
          placeholder="Describe the issue…"
          className="w-full bg-stone-700 border border-stone-600 rounded-xl px-4 py-3 text-stone-100
                     text-sm resize-none focus:outline-none focus:border-red-500 mb-3"
        />
        {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
        <div className="flex gap-3">
          <button className="flex-1 btn-secondary py-3" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            disabled={busy || !message.trim()}
            onClick={handleSend}
            className="flex-1 py-3 rounded-xl bg-red-900/40 border border-red-700 text-red-300 text-base disabled:opacity-40">
            {busy ? 'Sending…' : '⚑ Send Alert'}
          </button>
        </div>
      </div>
    </div>
  )
}
