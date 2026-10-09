interface ImportMetaEnv {
  readonly VITE_RAGU_SERVER_HOST: string
  readonly VITE_RAGU_SERVER_PORT: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
