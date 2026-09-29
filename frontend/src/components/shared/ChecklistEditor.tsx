/**
 * Editor for a task's checklist. Used only in the create/edit task forms.
 * Each item's responsible person can be chosen ONLY from the task's assignees.
 */
export interface ChecklistDraft { id?: string; text: string; assigneeIds: string[] }

export default function ChecklistEditor({
  items, onChange, assignees,
}: {
  items: ChecklistDraft[]
  onChange: (items: ChecklistDraft[]) => void
  assignees: { id: string; name: string }[]
}) {
  const update = (i: number, patch: Partial<ChecklistDraft>) => onChange(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)))
  const add = () => onChange([...items, { text: '', assigneeIds: [] }])
  const remove = (i: number) => onChange(items.filter((_, idx) => idx !== i))
  const toggleAssignee = (i: number, uid: string) => {
    const cur = items[i].assigneeIds
    update(i, { assigneeIds: cur.includes(uid) ? cur.filter((x) => x !== uid) : [...cur, uid] })
  }

  return (
    <div>
      {items.length === 0 && <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>موردی اضافه نشده است.</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((it, i) => (
          <div key={i} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: 10 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 18, textAlign: 'center' }}>{i + 1}</span>
              <input placeholder="عنوان مورد چک‌لیست..." value={it.text} onChange={(e) => update(i, { text: e.target.value })} />
              <button type="button" className="btn-danger btn-sm" onClick={() => remove(i)}>✕</button>
            </div>
            <div style={{ marginTop: 6, paddingRight: 24 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>مسئول:</span>
              {assignees.length === 0 ? (
                <span style={{ fontSize: 11, color: 'var(--warning)' }}> ابتدا مسئولان وظیفه را انتخاب کنید</span>
              ) : (
                <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 5 }}>
                  {assignees.map((a) => (
                    <label key={a.id} style={{ fontSize: 11.5, padding: '2px 9px', borderRadius: 100, cursor: 'pointer', border: '1px solid var(--border)', background: it.assigneeIds.includes(a.id) ? 'var(--brand)' : 'var(--surface)', color: it.assigneeIds.includes(a.id) ? '#fff' : 'var(--text)' }}>
                      <input type="checkbox" style={{ display: 'none' }} checked={it.assigneeIds.includes(a.id)} onChange={() => toggleAssignee(i, a.id)} />
                      {a.name}
                    </label>
                  ))}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
      <button type="button" className="btn-secondary btn-sm" style={{ marginTop: 8 }} onClick={add}>+ افزودن مورد چک‌لیست</button>
    </div>
  )
}
