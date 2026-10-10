import { LANGS, getLang, setLang } from '../i18n'

// Выбор языка интерфейса (перевод ещё не полный — чего нет в словаре, остаётся по-русски)
export default function LangPicker({ style }) {
  const cur = getLang()
  return (
    <label data-no-i18n="" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, ...style }}>
      <span style={{ fontSize: 16 }}>🌐</span>
      <select value={cur} onChange={e => setLang(e.target.value)} style={{ flex: 1, padding: '6px 8px', fontSize: 14 }}>
        {LANGS.map(([c, name]) => <option key={c} value={c}>{name}</option>)}
      </select>
    </label>
  )
}
