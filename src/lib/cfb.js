// Составной файл OLE2 (Compound File Binary): достаём один поток по имени.
// Нужен для проектов «Астра Конструктор Мебели» (.add) — в них один поток Contents.

const MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const END = 0xfffffffe, FREE = 0xffffffff

export const isCfb = u8 => u8.length > 512 && MAGIC.every((b, i) => u8[i] === b)

export function cfbStream(u8, name) {
  if (!isCfb(u8)) throw new Error('Это не составной файл')
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const u32 = p => dv.getUint32(p, true)
  const ss = 1 << dv.getUint16(30, true), mss = 1 << dv.getUint16(32, true)
  const dirStart = u32(48), miniCutoff = u32(56), miniFatStart = u32(60)
  const off = n => (n + 1) * ss
  const per = ss / 4

  // DIFAT: 109 записей в заголовке, дальше — цепочка секторов
  const fatSectors = []
  for (let i = 0; i < 109; i++) { const s = u32(76 + i * 4); if (s < END) fatSectors.push(s) }
  let ds = u32(68)
  for (let guard = 0; ds < END && guard < 100000; guard++) {
    const p = off(ds)
    for (let i = 0; i < per - 1; i++) { const s = u32(p + i * 4); if (s < END) fatSectors.push(s) }
    ds = u32(p + (per - 1) * 4)
  }
  const fat = new Uint32Array(fatSectors.length * per)
  fatSectors.forEach((s, k) => { const p = off(s); for (let i = 0; i < per; i++) fat[k * per + i] = p + i * 4 + 4 <= u8.length ? u32(p + i * 4) : FREE })

  const chain = (start, table) => {
    const out = []
    for (let s = start, guard = 0; s < END && s < table.length && guard < table.length + 1; s = table[s], guard++) out.push(s)
    return out
  }
  const readChain = (start, size) => {
    const secs = chain(start, fat)
    const out = new Uint8Array(secs.length * ss)
    secs.forEach((s, k) => out.set(u8.subarray(off(s), Math.min(off(s) + ss, u8.length)), k * ss))
    return size != null ? out.subarray(0, size) : out
  }

  const dir = readChain(dirStart)
  const ddv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength)
  const dec = new TextDecoder('utf-16le')
  let root = null, found = null
  for (let p = 0; p + 128 <= dir.length; p += 128) {
    const type = dir[p + 66]
    if (!type) continue
    const len = Math.max(0, ddv.getUint16(p + 64, true) - 2)
    const nm = dec.decode(dir.subarray(p, p + len))
    const e = { start: ddv.getUint32(p + 116, true), size: ddv.getUint32(p + 120, true) }
    if (type === 5) root = e
    else if (type === 2 && nm === name) found = e
  }
  if (!found) throw new Error(`В файле нет потока ${name}`)
  if (found.size >= miniCutoff) return readChain(found.start, found.size)

  // маленький поток лежит в мини-потоке корневой записи
  const mini = readChain(root.start, root.size)
  const mf = readChain(miniFatStart)
  const mdv = new DataView(mf.buffer, mf.byteOffset, mf.byteLength)
  const miniFat = new Uint32Array(mf.length / 4)
  for (let i = 0; i < miniFat.length; i++) miniFat[i] = mdv.getUint32(i * 4, true)
  const secs = chain(found.start, miniFat)
  const out = new Uint8Array(secs.length * mss)
  secs.forEach((s, k) => out.set(mini.subarray(s * mss, s * mss + mss), k * mss))
  return out.subarray(0, found.size)
}
