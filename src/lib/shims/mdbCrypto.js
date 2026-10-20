// Заглушка вместо browserify-aes / create-hash для mdb-reader в браузере: шифрованные базы Access
// нам не нужны (К3 пишет обычную .mdb), а эти пакеты тянут за собой поток Node и global process.
const unsupported = () => { throw new Error('база Access зашифрована — такие файлы приложение не читает') }
export default unsupported
export const createDecipheriv = unsupported
export const createCipheriv = unsupported
export const createHash = unsupported
