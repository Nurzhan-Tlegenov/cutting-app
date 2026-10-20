import { FILE_NAME_DEFAULTS } from './orderUtils'
import { getUserSettings } from './userSettings'
/** Шаблоны имён файлов аккаунта (PDF карт, архив) с подстановкой значений по умолчанию — см. components/FileNamesSettings.jsx */
export const fileNamesOf = user => ({ ...FILE_NAME_DEFAULTS, ...(getUserSettings(user).fileNames || {}) })
