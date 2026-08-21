import { createSignal, Show, For } from "solid-js"
import type { SessionDiff } from "./load"
import type { FileDiff, Hunk } from "./diff"
import "./diff-view.css"

export interface DiffViewProps {
  diff: SessionDiff | undefined
  loading?: boolean
  selectedPath?: string
  onSelectPath?: (path: string) => void
}

export function DiffView(props: DiffViewProps) {
  const [internalPath, setInternalPath] = createSignal<string | undefined>()

  const selected = () => props.selectedPath ?? internalPath()
  
  const selectFile = (path: string) => {
    setInternalPath(path)
    props.onSelectPath?.(path)
  }

  const selectedFile = () => {
    const p = selected()
    return p ? props.diff?.files.find(f => f.path === p) : undefined
  }

  return (
    <div class="ade-diff-view">
      <Show when={props.loading}>
        <div class="ade-diff-empty">Caricamento modifiche in corso...</div>
      </Show>
      
      <Show when={!props.loading && props.diff?.error}>
        <div class="ade-diff-empty ade-diff-error">{props.diff?.error}</div>
      </Show>

      <Show when={!props.loading && !props.diff?.error && (!props.diff || props.diff.files.length === 0)}>
        <div class="ade-diff-empty">Nessuna modifica da mostrare.</div>
      </Show>

      <Show when={!props.loading && !props.diff?.error && props.diff && props.diff.files.length > 0}>
        <div class="ade-diff-sidebar">
          <div class="ade-diff-header">
            Modifiche ({props.diff?.added} aggiunte, {props.diff?.removed} rimozioni)
          </div>
          <div class="ade-diff-file-list">
            <For each={props.diff?.files}>
              {(f) => (
                <button
                  class="ade-diff-file-item"
                  classList={{ "is-selected": selected() === f.path }}
                  onClick={() => selectFile(f.path)}
                >
                  <span class={`ade-diff-status is-${f.status}`} title={f.status} />
                  <span class="ade-diff-file-path" title={f.path}>{f.path}</span>
                  <span class="ade-diff-stats">
                    <Show when={f.added > 0}>
                      <span class="ade-diff-added">+{f.added}</span>
                    </Show>
                    <Show when={f.removed > 0}>
                      <span class="ade-diff-removed">-{f.removed}</span>
                    </Show>
                  </span>
                </button>
              )}
            </For>
          </div>
        </div>
        
        <div class="ade-diff-content">
          <Show when={props.diff?.truncated}>
            <div class="ade-diff-banner">
              Il diff è troppo grande ed è stato troncato. Stai visualizzando solo l'elenco dei file.
            </div>
          </Show>

          <Show when={selectedFile()}>
            {(file) => (
              <div class="ade-diff-file-detail">
                <div class="ade-diff-file-header">
                  {file().path}
                  <Show when={file().oldPath}>
                    <span class="ade-diff-rename"> (rinominato da {file().oldPath})</span>
                  </Show>
                </div>
                
                <Show when={file().binary}>
                  <div class="ade-diff-placeholder">
                    Il file è binario, impossibile mostrare le differenze testuali.
                  </div>
                </Show>

                <Show when={!file().binary && props.diff?.truncated}>
                  <div class="ade-diff-placeholder">
                    Contenuto non disponibile (diff troppo grande).
                  </div>
                </Show>

                <Show when={!file().binary && !props.diff?.truncated && file().hunks.length === 0 && (file().added > 0 || file().removed > 0 || file().status === 'modified')}>
                   <div class="ade-diff-placeholder">
                    Modifiche non analizzabili o file vuoto.
                  </div>
                </Show>

                <Show when={!file().binary && !props.diff?.truncated && file().hunks.length > 0}>
                  <div class="ade-diff-hunks">
                    <For each={file().hunks}>
                      {(hunk) => (
                        <div class="ade-diff-hunk">
                          <div class="ade-diff-hunk-header">{hunk.header}</div>
                          <table class="ade-diff-table">
                            <tbody>
                              <For each={hunk.lines}>
                                {(line) => (
                                  <tr class={`ade-diff-line is-${line.kind}`}>
                                    <td class="ade-diff-line-number" data-line-number={line.oldNumber || ""} />
                                    <td class="ade-diff-line-number" data-line-number={line.newNumber || ""} />
                                    <td class="ade-diff-line-text">{line.text}</td>
                                  </tr>
                                )}
                              </For>
                            </tbody>
                          </table>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            )}
          </Show>
          <Show when={!selectedFile() && !props.diff?.truncated}>
            <div class="ade-diff-placeholder">
              Seleziona un file per visualizzarne il contenuto.
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}
