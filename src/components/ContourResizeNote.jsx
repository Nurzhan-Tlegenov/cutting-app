// Предупреждение под карточкой детали в заказе (новый заказ / правка заказа):
//  — prev задан: размер детали с фигурным контуром изменили, контур сброшен до прямоугольника — «Вернуть как было»;
//  — контур не совпадает с размером детали (сохранено так раньше) — «Сбросить до прямоугольника».
import { contourMismatch } from '../lib/contourResize'

const box = (bg, bd) => ({ margin: '-4px 0 8px', padding: '7px 10px', borderRadius: 'var(--radius)', background: bg, border: `1px solid ${bd}`, fontSize: 12, lineHeight: 1.4 })
const btn = { padding: '4px 10px', fontSize: 12, borderRadius: 'var(--radius)', border: '0.5px solid var(--border-md)', background: 'var(--bg)', cursor: 'pointer', marginTop: 6, marginRight: 6 }

export default function ContourResizeNote({ detail, prev, onUndo, onDismiss, onReset }) {
  if (prev) {
    return (
      <div style={box('rgba(245,158,11,0.10)', 'rgba(245,158,11,0.5)')}>
        <b>⚠ Размер детали изменён — фигурный контур сброшен до прямоугольника {detail.w} × {detail.h}.</b>
        <div style={{ color: 'var(--text-muted)' }}>
          Было {prev.w} × {prev.h} с фигурным контуром. Старый контур не подходит к новому размеру: в раскрое деталь встала бы
          неправильно. Нужна фигура — нарисуйте её заново в редакторе контура (✦). Присадка, пазы и вырезы сохранены — проверьте их там же.
        </div>
        <button type="button" style={btn} onClick={onUndo}>Вернуть как было ({prev.w} × {prev.h})</button>
        <button type="button" style={btn} onClick={onDismiss}>Понятно</button>
      </div>
    )
  }
  const mm = contourMismatch(detail.contour, detail.h, detail.w)
  if (!mm) return null
  return (
    <div style={box('rgba(220,53,69,0.08)', 'rgba(220,53,69,0.45)')}>
      <b style={{ color: '#dc3545' }}>⚠ Контур детали не совпадает с её размером</b>
      <div style={{ color: 'var(--text-muted)' }}>
        Контур {mm.l} × {mm.w}, а размер детали {detail.w} × {detail.h} — похоже, размер меняли после рисования контура.
        В раскрое такая деталь налезет на соседние. Сбросьте контур до прямоугольника или верните прежний размер.
      </div>
      <button type="button" style={btn} onClick={onReset}>Сбросить до прямоугольника {detail.w} × {detail.h}</button>
    </div>
  )
}
