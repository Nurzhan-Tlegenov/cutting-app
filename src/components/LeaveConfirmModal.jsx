// Модалка "Сохранить заказ? Или вернуться обратно?" — показывается при попытке
// уйти со страницы (например системной кнопкой "назад") при несохранённых изменениях.
export default function LeaveConfirmModal({ saving, onSave, onDiscard, onStay }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1000, padding: 20,
    }}>
      <div style={{
        background: 'var(--bg)', borderRadius: 14, padding: 20, maxWidth: 340, width: '100%',
      }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 8px' }}>Заказ не сохранён</h3>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 18px' }}>
          Если уйти сейчас, введённые данные будут потеряны. Сохранить заказ перед выходом?
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button type="button" onClick={onSave} disabled={saving}
            style={{ padding: '11px', border: 'none', borderRadius: 10, background: 'var(--blue)',
              color: 'white', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>
            {saving ? 'Сохранение…' : '💾 Сохранить и выйти'}
          </button>
          <button type="button" onClick={onDiscard} disabled={saving}
            style={{ padding: '11px', border: '0.5px solid var(--danger)', borderRadius: 10, background: 'transparent',
              color: 'var(--danger)', fontSize: 14, cursor: 'pointer' }}>
            Выйти без сохранения
          </button>
          <button type="button" onClick={onStay} disabled={saving}
            style={{ padding: '11px', border: 'none', borderRadius: 10, background: 'transparent',
              color: 'var(--text-muted)', fontSize: 14, cursor: 'pointer' }}>
            Остаться
          </button>
        </div>
      </div>
    </div>
  )
}
