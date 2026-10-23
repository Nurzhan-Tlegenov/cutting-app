import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'
import { userPdfTpl } from '../lib/pdfSummary'
import PdfLayoutEditor from './PdfLayoutEditor'
import SummaryLayoutEditor from './SummaryLayoutEditor'

// Настройки производства → «Отчёты (PDF)»: всё, что касается PDF карт раскроя, в одном месте —
// конструктор листа (что и где выводить на странице листа), статистика на отдельной странице,
// какие строки статистики раскроя и как показывать смету на последней странице.
// Настройки — за аккаунтом (pdfTpl, pdfStatsPage, pdfSummary); те же, что в окне «PDF» на странице раскроя.


export default function ReportsSettings() {
  const { user } = useAuth()
  const [layout, setLayout] = useState(false)
  const [sumEdit, setSumEdit] = useState(false)
  const [, setTick] = useState(0)
  const st = getUserSettings(user)
  const [statsPage, setStatsPageS] = useState(() => !!st.pdfStatsPage)
  const [estimate, setEstimateS] = useState(() => !!st.pdfEstimate)
  const custom = userPdfTpl(user)
  const check = (on, set, title, sub) => (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 0', borderTop: '0.5px solid var(--border)', fontSize: 13, cursor: 'pointer' }}>
      <input type="checkbox" checked={on} onChange={e => set(e.target.checked)} style={{ width: 'auto', marginTop: 2 }} />
      <span>{title}{sub && <span style={{ display: 'block', fontSize: 11, color: 'var(--text-hint)' }}>{sub}</span>}</span>
    </label>
  )
  return (
    <div>
      <p style={{ fontSize: 12, color: 'var(--text-hint)', margin: '0 0 10px' }}>PDF карт раскроя: что выводить на странице листа и где, статистика и смета. Действует для всех PDF карт — со страницы раскроя и из ЧПУ.</p>

      <p className="section-title">Страница листа</p>
      <div onClick={() => setLayout(true)} style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', border: '0.5px solid var(--blue-mid)', borderRadius: 'var(--radius)', cursor: 'pointer', marginBottom: 6 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, color: 'var(--blue)', fontWeight: 500 }}>Конструктор листа PDF</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>{custom ? 'Свой макет: карта, список, подписи, операции расставлены вами' : 'Стандартный вид. Двигайте карту и список, меняйте шрифты, размеры на карте, добавляйте резы, длину реза, площади, присадку'}</div>
        </div>
        <span style={{ color: 'var(--blue)', fontSize: 18 }}>›</span>
      </div>
      {check(statsPage, v => { setStatsPageS(v); saveUserSettings({ pdfStatsPage: v }, user) }, 'Статистика листов на отдельной странице',
        'Для стандартного вида: на листе только карта на всю ширину и обозначения; использование, кромка, обрезки и списки деталей — в конце')}

      <p className="section-title" style={{ marginTop: 12 }}>Последняя страница: статистика раскроя и смета</p>
      {check(estimate, v => { setEstimateS(v); saveUserSettings({ pdfEstimate: v }, user) }, 'Добавлять страницу статистики и сметы', 'Та же галочка «Смета» под кнопкой PDF на странице раскроя')}
      <div onClick={() => setSumEdit(true)} style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', border: '0.5px solid var(--blue-mid)', borderRadius: 'var(--radius)', cursor: 'pointer', margin: '6px 0 10px' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, color: 'var(--blue)', fontWeight: 500 }}>Конструктор страницы статистики</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>Видно, как выглядит страница: какие строки, в каком порядке, шрифт, колонки, смета, примечания</div>
        </div>
        <span style={{ color: 'var(--blue)', fontSize: 18 }}>›</span>
      </div>


      {sumEdit && <SummaryLayoutEditor onClose={() => setSumEdit(false)} />}
      {layout && <PdfLayoutEditor onClose={() => { setLayout(false); setTick(t => t + 1) }} />}
    </div>
  )
}
