/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HERMES_API_URL?: string
  readonly VITE_HERMES_API_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
