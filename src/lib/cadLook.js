// Вид 3D-сцены конструктора по умолчанию (настройки «Отображение» — за аккаунтом, cadLook):
// подписи размеров (прозрачность фона, размер, цвет), размерные линии, линии деталей, фон (авто — по теме, светлый, тёмный, свой цвет)
export const CAD_LOOK = { labelOpacity: 0.9, labelSize: 1, labelColor: '#1d4ed8', dimSize: 1, lineColor: '#5b6672', lineOpacity: 0.55, bg: 'auto', bgColor: '#e9edf1',
  quality: 'high', hwFinish: 'nickel', handleFinish: 'satin', xrayOpacity: 0.3, lines: true, dims: true, labelBgOn: true, openSizes: true,
  holeStyle: 'marker', edgeR: 0.5, bandShow: true, bandColor: '', smooth: 1.5, lineWidth: 1, exposure: 0.92, lightKey: 1, lightAmb: 1, lightAz: 35, lightEl: 55, envInt: 1 }
// отделка металла: цвет, металличность, шероховатость, «шлифовка» (анизотропия)
export const FINISHES = [
  ['chrome', 'Хром', '#eef0f2', 1, 0.06, 0],
  ['nickel', 'Никель', '#d9dcdf', 1, 0.2, 0],
  ['satin', 'Сатин (нерж.)', '#c8ccd1', 1, 0.34, 0.85],
  ['black', 'Чёрный матовый', '#1b1c1e', 0.55, 0.5, 0],
  ['graphite', 'Графит', '#4b4e53', 1, 0.3, 0.6],
  ['brass', 'Латунь / золото', '#caa45e', 1, 0.24, 0.5],
  ['white', 'Белый', '#f1f1ef', 0.1, 0.42, 0],
]
