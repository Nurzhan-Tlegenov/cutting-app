import { useState } from 'react'
import TplInput from './TplInput'
import { FILE_NAME_PARTS, FILE_NAME_DEFAULTS, fileNameOf } from '../lib/orderUtils'
import { saveUserSettings } from '../lib/userSettings'
import { fileNamesOf } from '../lib/fileNames'
import { useAuth } from '../context/AuthContext'

// Имена файлов: PDF карт раскроя и архива «Сохранить все файлы» — из тех же частей, что названия программ.
// По умолчанию: карты — заказ_клиент_материал, архив — заказ_клиент_дата (клиента нет — без него). Настройка аккаунта.
export default function FileNamesSettings() {
  const { user } = useAuth()
  const [v, setV] = useState(() => fileNamesOf(user))
  const set = (k, x) => { const next = { ...v, [k]: x }; setV(next); saveUserSettings({ fileNames: next }, user) }
  const ex = { total: 3, order: { order_name: 'Кухня Ивановых', order_number: '261007_005' }, material: 'ЛДСП Белый', thickness: 16, client: 'Марат' }
  const hint = { fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }
  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Имена файлов</div>
      <p style={hint}>Из каких частей складывать имя PDF карт раскроя и архива при сохранении всех файлов. Часть вставляется туда, где стоял курсор в поле. Латиницей; пустая часть (нет клиента) пропускается.</p>
      <div style={{ marginTop: 8 }}>
        <label className="label">PDF карт раскроя</label>
        <TplInput value={v.maps} def={FILE_NAME_DEFAULTS.maps} parts={FILE_NAME_PARTS} onChange={x => set('maps', x)}
          hint={<p style={hint}>Например: <b style={{ fontFamily: 'monospace' }}>{fileNameOf('maps', v.maps, ex)}.pdf</b></p>} />
      </div>
      <div style={{ marginTop: 8 }}>
        <label className="label">Архив со всеми файлами</label>
        <TplInput value={v.zip} def={FILE_NAME_DEFAULTS.zip} parts={FILE_NAME_PARTS} onChange={x => set('zip', x)}
          hint={<p style={hint}>Например: <b style={{ fontFamily: 'monospace' }}>{fileNameOf('zip', v.zip, ex)}.zip</b>; архив бирок — <b style={{ fontFamily: 'monospace' }}>Birki_{fileNameOf('zip', v.zip, ex)}.zip</b></p>} />
      </div>
    </div>
  )
}
