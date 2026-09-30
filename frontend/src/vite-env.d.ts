/// <reference types="vite/client" />

/* ثابت‌هایی که Vite هنگام بیلد جاسازی می‌کند (تعریف در vite.config.ts) */
declare const __APP_VERSION__: string
declare const __APP_COMMIT__: string
declare const __APP_BUILT_AT__: string

interface ImportMetaEnv {
  readonly VITE_API_URL?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
