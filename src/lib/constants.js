export const HOLD_REASONS = [
  { key: 'missing_parts_sfm',          label: 'Missing Parts from SFM Supply' },
  { key: 'poor_quality_sfm',           label: 'Poor Quality from SFM Supply' },
  { key: 'missing_parts_supply_chain', label: 'Missing Parts from Supply Chain' },
  { key: 'poor_quality_supply_chain',  label: 'Poor Quality from Supply Chain' },
]

export const HOLD_REASON_LABEL = Object.fromEntries(
  HOLD_REASONS.map(r => [r.key, r.label])
)
