// Hold/pause reasons — assembly, paint, kitting
export const HOLD_REASONS = [
  { key: 'missing_parts_sfm',          label: 'Missing Parts from SFM Supply' },
  { key: 'poor_quality_sfm',           label: 'Poor Quality from SFM Supply' },
  { key: 'missing_parts_supply_chain', label: 'Missing Parts from Supply Chain' },
  { key: 'poor_quality_supply_chain',  label: 'Poor Quality from Supply Chain' },
]

// Weld shop pause reasons
export const HOLD_REASONS_WELD = [
  { key: 'cutting_shop_issue', label: 'Cutting Shop Issue' },
  { key: 'fold_issue',         label: 'Fold Issue' },
  { key: 'kitting_issue',      label: 'Kitting Issue / Missing Part' },
  { key: 'bip_issue',          label: 'BIP Issue' },
  { key: 'weld_issue',         label: 'Weld Issue' },
]

export function holdReasonsFor(department) {
  return department === 'weld' ? HOLD_REASONS_WELD : HOLD_REASONS
}

// Every key from every list, so historical events always resolve to a label
export const HOLD_REASON_LABEL = Object.fromEntries(
  [...HOLD_REASONS, ...HOLD_REASONS_WELD].map(r => [r.key, r.label])
)
