import { Show, createSignal, createEffect } from "solid-js"
import { getHost } from "../host/shell"
import { basename } from "../host/path"

export interface FilePreviewProps {
  path: string
}

export function FilePreview(props: FilePreviewProps) {
  const [content, setContent] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)

  createEffect(() => {
    const path = props.path
    if (!path) return

    let cancelled = false
    setLoading(true)
    setError(null)
    setContent(null)

    getHost().then((host) => {
      if (cancelled) return
      if (!host?.readTextFile) {
        setError("Impossibile leggere file in questo ambiente.")
        setLoading(false)
        return
      }

      host.readTextFile(path, 1_048_576).then((res) => {
        if (cancelled) return
        if (res.bytes === 0 && res.text === "") {
          // Is it an error or empty?
          setContent("")
        } else if (res.text === "" && res.bytes > 0) {
          setError("File binario o codifica non supportata.")
        } else {
          setContent(res.text)
          if (res.truncated) {
            setError("File troppo grande, mostrata solo l'anteprima.")
          }
        }
        setLoading(false)
      })
    })

    return () => {
      cancelled = true
    }
  })

  return (
    <div data-component="file-preview">
      <header data-slot="preview-header">
        <span data-slot="preview-title">{basename(props.path)}</span>
      </header>
      <div data-slot="preview-body">
        <Show when={loading()}>
          <div data-slot="preview-message">Caricamento in corso...</div>
        </Show>
        <Show when={error()}>
          <div data-slot="preview-message" data-error="true">
            {error()}
          </div>
        </Show>
        <Show when={content() !== null}>
          <pre data-slot="preview-content">
            <code>
              {content()?.split('\n').map((line, i) => (
                <div data-slot="preview-line">
                  <span data-slot="preview-line-num">{i + 1}</span>
                  <span data-slot="preview-line-text">{line}</span>
                </div>
              ))}
            </code>
          </pre>
        </Show>
      </div>
    </div>
  )
}
