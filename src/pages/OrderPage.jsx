import { openOrderEdit, canEditOrder, EDIT_BTN } from '../lib/editOrder'
import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { STATUS_LABELS, STATUS_BADGE, orderTitle } from '../lib/orderUtils'
import BottomNav from '../components/BottomNav'
import { sortDetails, SORT_MODES } from '../lib/sortDetails'
import MaterialFilter from '../components/MaterialFilter'
import { detailMatKey } from '../lib/detailMaterial'
import { detailMeta } from '../lib/partLabel'
import Model3DButton from '../components/Model3DButton'
import { edgeTotals } from '../lib/edgeLength'
import CncLoader from '../components/CncLoader'
import { isTwoSided } from '../lib/partInfo'
import { loadOrderModel } from '../lib/orderModel'
import { getShare, cachedShare, onShareChange } from '../lib/modelShare'
import ShareLinkBox from '../components/ShareLinkBox'
import { orderClient, productionSetStatus, orderMarks } from '../lib/productionApi'
import NestingCost from '../components/NestingCost'
import SimLinksBox from '../components/SimLinksBox'
import { cutDetails, parseEdgeTypes, rawDetail, overMm, overOf } from '../lib/edgeCut'
import SheetsOverview from '../components/SheetsOverview'
import { savedNestings, sheetGeo } from '../lib/savedNesting'
import { materialsOf } from '../lib/detailMaterial'
import { useLabelMode } from '../lib/userSettings'
const STATUSES = ['new', 'discussion', 'inwork', 'done']
export default function OrderPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { profile, user, cabinet } = useAuth()
  const inProduction = cabinet === 'production'      // кабинет производства: статусы, ЧПУ, бирки
  const [client, setClient] = useState(null)   // заказчик и производство этого заказа
  const [sortMode, setSortMode] = useState('')   // сортировка списка деталей (только показ)
  const [matFilter, setMatFilter] = useState('') // какой материал показывать в списке
  const isOperator = profile?.role === 'operator' || profile?.role === 'admin'
  const [order, setOrder] = useState(null)
  const [details, setDetails] = useState([])
  const [loading, setLoading] = useState(true)
  const [labelMode] = useLabelMode(user)
  const [mapMat, setMapMat] = useState('')        // материал, чьи карты раскроя показаны
  useEffect(() => { fetchOrder() }, [id])
  // открыта ли ссылка для просмотра 3D-модели (её могли создать в самой модели)
  const [shared, setShared] = useState(() => !!cachedShare(id))
  useEffect(() => {
    const off = onShareChange(() => setShared(!!cachedShare(id)))
    getShare(id)
    return off
  }, [id])
  async function fetchOrder() {
    const { data: o, error: oErr } = await supabase.from('orders').select('*').eq('id', id).single()
    const { data: d } = await supabase.from('order_details').select('*').eq('order_id', id).order('sort_order')
    setOrder(o)
    setDetails(d || [])
    setLoading(false)
    orderClient(id).then(r => { if (!r.error) setClient(r.data || null) })
  }
  async function setStatus(status) {
    // статус меняет производство (или администратор) — через функцию базы; в старой базе — напрямую
    let r = await productionSetStatus(id, status)
    if (r.missing) { const { error } = await supabase.from('orders').update({ status }).eq('id', id); r = error ? { error: error.message } : {} }
    if (r.error) { window.alert('Не удалось изменить статус: ' + r.error); return }
    setOrder(o => ({ ...o, status }))
  }
  async function deleteOrder() {
    if (!window.confirm('Удалить заказ? Это действие нельзя отменить.')) return
    await supabase.from('order_details').delete().eq('order_id', id)
    await supabase.from('orders').delete().eq('id', id)
    navigate('/orders')
  }
  if (loading) return <div className="page"><CncLoader label="Открываем заказ…" /></div>
  if (!order) return <div className="page"><p>Заказ не найден</p></div>
  const matKeys = new Set(details.map(d => detailMatKey(d, order)))
  const shownDetails = matFilter && matKeys.has(matFilter) ? details.filter(d => detailMatKey(d, order) === matFilter) : details
  const validDetails = details.filter(d => d.length > 0 && d.width > 0)
  const kerf = order.kerf_width || 4
  const usableL = order.sheet_length - (order.margin_left || 0) - (order.margin_right || 0)
  const usableW = order.sheet_width - (order.margin_top || 0) - (order.margin_bottom || 0)
  const usableArea = (usableL / 1000) * (usableW / 1000)
  let totalPartArea = 0, totalQty = 0
  validDetails.forEach(d => {
    totalPartArea += ((d.length + kerf) / 1000) * ((d.width + kerf) / 1000) * d.qty
    totalQty += d.qty
  })
  // принятые карты раскроя — показываются над списком деталей
  const nestings = savedNestings(order, cutDetails(details, parseEdgeTypes(order?.edge_types)))   // карты — по заготовкам, как в раскрое
  const nest = nestings.find(n => n.key === mapMat) || nestings[0] || null
  // Есть принятый раскрой — статистика только по его материалу (тому, чьи карты сейчас показаны), листы — по факту
  const statDetails = nest ? nest.details.filter(d => d.length > 0 && d.width > 0) : validDetails
  if (nest) totalQty = statDetails.reduce((a, d) => a + (Number(d.qty) || 0), 0)
  // кромка: стороны + фигурные участки и вырезы; прямая и криволинейная — отдельно
  const edgeSum = edgeTotals(statDetails.map(rawDetail), overMm(parseEdgeTypes(order?.edge_types)))   // по готовой детали, со свесами
  const totalEdge = edgeSum.total
  const sheetsNeeded = nest ? nest.sheets.length : usableArea > 0 ? Math.ceil(totalPartArea / (usableArea * 0.85)) : 0
  const isMine = order.user_id === user?.id
  const isDraft = order.status === 'draft' && (isMine || profile?.role === 'admin')
  const canStatus = inProduction && order.status !== 'draft' && (profile?.role === 'admin' || (isOperator && !!order.production_id))
  const edgeNames = { edge_top:'В', edge_right:'П', edge_bottom:'Н', edge_left:'Л' }
  const nestGeo = nest ? sheetGeo(order, nest.result) : null
  const materials = materialsOf(details, order)
  const canProduce = inProduction && order.status !== 'draft' && isOperator
  const actBtn = main => ({ flex: 1, padding: '10px 8px', borderRadius: 'var(--radius)', fontSize: 14, fontWeight: 500, cursor: 'pointer',
    border: main ? 'none' : '0.5px solid var(--blue)', background: main ? 'var(--blue)' : 'var(--bg)', color: main ? 'white' : 'var(--blue)' })
  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, paddingTop: 8 }}>
        <button onClick={() => navigate(inProduction ? '/production' : '/orders')} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0 }}>←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{orderTitle(order)}</div>
          <div style={{ fontSize: 12, color: 'var(--text-hint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{order.material_name}</div>
        </div>
        {!inProduction && canEditOrder(order, user, profile) && order.status !== 'done' && <button type="button" onClick={() => openOrderEdit(order, navigate)} style={EDIT_BTN}>✎ Редактировать</button>}
        {inProduction && order.status !== 'draft' && <button type="button" onClick={() => navigate('/production')} style={{ flex: '0 0 auto', padding: '4px 9px', borderRadius: 20, fontSize: 11, border: '0.5px solid var(--blue)', background: 'transparent', color: 'var(--blue)', whiteSpace: 'nowrap' }}>К заказам</button>}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flex: '0 0 auto' }}>
          <span className={`badge ${STATUS_BADGE[order.status] || 'badge-new'}`}>
            {STATUS_LABELS[order.status] || order.status}
          </span>
          {inProduction && (order.status === 'inwork' || order.status === 'done' || order.gcode_at || order.files_saved_at) && (
            <div style={{ display: 'flex', gap: 4 }}>
              {orderMarks(order).map(m => <span key={m.key} title={m.text} style={{ fontSize: 11, lineHeight: '16px', borderRadius: 9, padding: '0 7px', whiteSpace: 'nowrap', border: `0.5px solid ${m.on ? 'var(--blue)' : 'var(--border-md)'}`, background: m.on ? 'var(--blue)' : 'transparent', color: m.on ? 'white' : 'var(--text-hint)' }}>{m.short}</span>)}
            </div>
          )}
        </div>
      </div>
      {client && (client.production || (!isMine && client.full_name)) && (
        <div className="card" style={{ marginBottom: 12, fontSize: 13 }}>
          {!isMine && (client.full_name || client.phone) && (
            <div>Заказчик: <b>{client.full_name || '—'}</b>{client.phone ? <a href={`tel:+${String(client.phone).replace(/\D/g, '')}`} style={{ color: 'var(--blue)', marginLeft: 8 }}>{client.phone}</a> : null}
              {(client.whatsapp || client.phone) ? <a href={`https://wa.me/${String(client.whatsapp || client.phone).replace(/\D/g, '')}`} target="_blank" rel="noreferrer" style={{ color: 'var(--teal)', marginLeft: 8, fontSize: 12 }}>WhatsApp</a> : null}</div>
          )}
          {client.production && <div style={{ color: 'var(--text-muted)' }}>Производство: {client.production}</div>}
        </div>
      )}
      {canStatus && (
        <div className="card" style={{ marginBottom: 12 }}>
          <p className="section-title">Изменить статус</p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {STATUSES.map(s => (
              <button key={s} onClick={() => setStatus(s)} style={{
                padding: '6px 12px', borderRadius: 20, fontSize: 12, border: 'none',
                background: order.status === s ? 'var(--blue)' : 'var(--bg2)',
                color: order.status === s ? 'white' : 'var(--text-muted)',
              }}>{STATUS_LABELS[s]}</button>
            ))}
          </div>
        </div>
      )}
      {shared && (
        <div className="card" style={{ marginBottom: 12, border: '1px solid var(--teal)' }}>
          <p className="section-title" style={{ color: 'var(--teal)' }}>🔗 Открыта ссылка на 3D-модель</p>
          <ShareLinkBox orderId={id} />
        </div>
      )}
      <SimLinksBox orderId={id} style={{ marginBottom: 12 }} />
      <div style={{ marginBottom: 12 }}>
        <p className="section-title">Статистика{nest ? <span style={{ textTransform: 'none', color: 'var(--text)', fontWeight: 600 }}> · {nest.label}</span> : null}</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {[[nest ? 'Листов в раскрое' : 'Листов нужно', sheetsNeeded],[nest ? 'Деталей' : 'Деталей всего', totalQty],
            ['Кромка (п.м.)', totalEdge.toFixed(2)],['Площадь листов (м²)', (sheetsNeeded * usableArea).toFixed(2)]
          ].map(([label, val]) => (
            <div key={label} style={{ background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: '12px' }}>
              <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>{label}</div>
              <div style={{ fontSize: 22, fontWeight: 500, marginTop: 2 }}>{val}</div>
            </div>
          ))}
        </div>
        {totalEdge > 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
            Кромка: прямая <b>{edgeSum.straight.toFixed(2)} м</b> · криволинейная <b>{edgeSum.curved.toFixed(2)} м</b>
            {(() => { const ov = overOf(parseEdgeTypes(order?.edge_types)); return ov.on && ov.mm > 0 ? ` · со свесами +${ov.mm} мм на сторону` : ' · без свесов' })()}
          </div>
        )}
      </div>
      <div className="card" style={{ marginBottom: 12, fontSize: 13 }}>
        <p className="section-title">Материал</p>
        {materials.map(m => {
          const cur = nest && m.key === nest.key, has = nestings.some(n => n.key === m.key)
          return (
            <div key={m.key} onClick={has ? () => setMapMat(m.key) : undefined}
              style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: cur ? '4px 6px' : '1px 6px', margin: '0 -6px', borderRadius: 6, cursor: has ? 'pointer' : 'default',
                background: cur ? 'var(--blue-light)' : 'transparent', color: !nest || cur ? 'var(--text)' : 'var(--text-muted)' }}>
              <b style={{ fontWeight: cur ? 600 : 500 }}>{cur ? '▸ ' : ''}{m.label}</b>
              <span style={{ color: 'var(--text-hint)', whiteSpace: 'nowrap' }}>{m.pieces} дет.{nest ? (cur ? ' · карты ниже' : has ? ' · раскроен' : ' · без раскроя') : ''}</span>
            </div>
          )
        })}
        <div style={{ color: 'var(--text-hint)', fontSize: 12, marginTop: 2 }}>Лист {order.sheet_length}×{order.sheet_width} мм</div>
      </div>
      {nest && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 6 }}>
            <p className="section-title" style={{ marginBottom: 0 }}>Карты раскроя · листов {nest.sheets.length}<span style={{ display: 'block', textTransform: 'none', fontSize: 14, fontWeight: 600, color: 'var(--text)', marginTop: 2 }}>{nest.label}</span></p>
            {nestings.length > 1 && (
              <select value={nest.key} onChange={e => setMapMat(e.target.value)} style={{ width: 'auto', maxWidth: '60%', padding: '3px 6px', fontSize: 12, borderRadius: 20 }}>
                {nestings.map(n => <option key={n.key} value={n.key}>{n.label}</option>)}
              </select>
            )}
          </div>
          <SheetsOverview sheets={nest.sheets} details={nest.details} labelMode={labelMode}
            usableX={nestGeo.usableX} usableY={nestGeo.usableY} sheetL={nestGeo.sheetL} sheetW={nestGeo.sheetW}
            marginL={nestGeo.marginL} marginT={nestGeo.marginT} kerf={nestGeo.kerf}
            onPickSheet={() => navigate(`/orders/${id}/nesting`)} />
          {order.status !== 'draft' && (
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button onClick={() => navigate(`/orders/${id}/nesting`)} style={actBtn(false)}>{canProduce ? 'Открыть / перекроить' : 'Открыть раскрой'}</button>
              {canProduce && <button onClick={() => navigate(`/orders/${id}/cnc`)} style={actBtn(true)}>ЧПУ</button>}
              {canProduce && <button onClick={() => navigate(`/orders/${id}/labels`)} style={actBtn(false)}>Бирки</button>}
            </div>
          )}
        </div>
      )}
      {/* производство видит всю статистику раскроя и расчёт; заказчик — стоимость работ (если цены ему доступны) */}
      {nestings.length > 0 && (order.production_id || inProduction) && (
        <NestingCost order={order} mats={nestings} method={order.cutting_method || 'nesting'} productionId={order.production_id}
          full={inProduction} style={{ marginBottom: 12 }} />
      )}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 6, flexWrap: 'wrap' }}>
          <p className="section-title" style={{ marginBottom: 0 }}>Детали ({details.length})</p>
          <Model3DButton details={details} title={orderTitle(order)} getScene={() => loadOrderModel(id)}
            orderId={id} editPath={isDraft ? `/orders/${id}/edit` : ''}
            saveToOrder={isDraft} order={order} materialThickness={Number(order?.material_thickness) || 16} onSaved={() => window.location.reload()} />
          <select value={sortMode} onChange={e => setSortMode(e.target.value)}
            style={{ width: 'auto', padding: '3px 6px', fontSize: 12, color: 'var(--text-muted)', borderRadius: 20 }}>
            <option value="">Как в заказе</option>
            {SORT_MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {isDraft && (
            <button onClick={() => navigate(`/orders/${id}/edit`)}
              style={{ fontSize: 13, color: 'var(--blue)', background: 'none', border: 'none' }}>
              Редактировать
            </button>
          )}
        </div>
        <MaterialFilter details={details} order={order} value={matFilter} onChange={setMatFilter} />
        <div style={{ background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--bg2)' }}>
                <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 500, color: 'var(--text-muted)', fontSize: 11 }}>Деталь</th>
                <th style={{ padding: '8px 6px', textAlign: 'center', fontWeight: 500, color: 'var(--text-muted)', fontSize: 11 }}>Д×Ш</th>
                <th style={{ padding: '8px 6px', textAlign: 'center', fontWeight: 500, color: 'var(--text-muted)', fontSize: 11 }}>Кол</th>
                <th style={{ padding: '8px 6px', textAlign: 'center', fontWeight: 500, color: 'var(--text-muted)', fontSize: 11 }}>Кромка</th>
              </tr>
            </thead>
            <tbody>
              {(sortMode ? sortDetails(shownDetails, sortMode) : shownDetails).map((d) => (
                <tr key={d.id} style={{ borderTop: '0.5px solid var(--border)' }}>
                  <td style={{ padding: '8px 10px' }}>
                    {d.prefix && <div style={{ fontSize: 10, color: 'var(--blue)', fontWeight: 500 }}>{d.prefix}</div>}
                    <div>{detailMeta(d)?.des ? <span style={{ color: 'var(--text-hint)', marginRight: 5 }}>{detailMeta(d).des}</span> : null}{d.name}{isTwoSided(d, order.material_thickness) && <span title="Обработка с двух сторон — деталь переворачивается на станке" style={{ marginLeft: 6, padding: '1px 6px', borderRadius: 10, fontSize: 10, background: '#F3E5F5', color: '#7B1FA2', whiteSpace: 'nowrap' }}>⇅ 2 стороны</span>}</div>
                  </td>
                  <td style={{ padding: '8px 6px', textAlign: 'center', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{d.length}×{d.width}</td>
                  <td style={{ padding: '8px 6px', textAlign: 'center' }}>{d.qty}</td>
                  <td style={{ padding: '8px 6px', textAlign: 'center', fontSize: 11, color: 'var(--blue)' }}>
                    {['edge_top','edge_right','edge_bottom','edge_left'].filter(k => d[k]).map(k => edgeNames[k]).join('')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {isDraft && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
          <button onClick={() => navigate(`/orders/${id}/nesting`)}
            style={{ width: '100%', padding: 12, background: 'var(--blue)', color: 'white',
              border: 'none', borderRadius: 'var(--radius)', fontSize: 15, fontWeight: 500, cursor: 'pointer' }}>
            ▶ Выполнить раскрой
          </button>
        </div>
      )}
      {(isMine || profile?.role === 'admin') && <button onClick={deleteOrder}
        style={{ width: '100%', padding: 10, background: 'transparent', color: 'var(--danger)',
          border: '1px solid var(--danger)', borderRadius: 'var(--radius)', fontSize: 14, cursor: 'pointer', marginBottom: 16 }}>
        🗑 Удалить заказ
      </button>}
      <BottomNav />
    </div>
  )
}
