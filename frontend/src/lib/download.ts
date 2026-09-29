import api from './api'

/**
 * دانلود یک فایل از API — چون درخواست باید توکن JWT را بفرستد، نمی‌شود از
 * `<a href>` ساده استفاده کرد. پاسخ را blob می‌گیریم و دانلود را دستی می‌سازیم.
 */
export async function downloadFile(path: string, filename: string, params?: Record<string, unknown>) {
  const res = await api.get(path, { responseType: 'blob', params })
  const url = URL.createObjectURL(res.data)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
