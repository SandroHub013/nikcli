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

  /*
   * The first file is selected by default. A review that opens on "pick a file"
   * costs a click before it has said anything, and in the common case — one or
   * two files changed — that click has only one possible answer.
   */
  const selected = () => props.selectedPath ?? internalPath() ?? props.diff?.files[0]?.path
  
  const selectFile = (path: string) => {
    setInternalPath(path)
    props.onSelectPath?.(path)
  }

  const selectedFile = () => {
    const p = selected()
    return p ? props.diff?.files.find(f => f.path === p) : undefined
  }

  return (
    <div data-component="diff-view">
      <Show when={props.loading}>
        <div data-slot="empty">Caricamento modifiche in corso...</div>
      </Show>
      
      <Show when={!props.loading && props.diff?.error}>
        <div data-slot="empty" data-error="true">{props.diff?.error}</div>
      </Show>

      <Show when={!props.loading && !props.diff?.error && (!props.diff || props.diff.files.length === 0)}>
        <div data-slot="empty">Nessuna modifica da mostrare.</div>
      </Show>

      <Show when={!props.loading && !props.diff?.error && props.diff && props.diff.files.length > 0}>
        <div data-slot="sidebar">
          <div data-slot="header">
            Modifiche ({props.diff?.added} aggiunte, {props.diff?.removed} rimozioni)
          </div>
          <div data-slot="file-list">
            <For each={props.diff?.files}>
              {(f) => (
                <button
                  data-slot="file-row"
                  data-selected={selected() === f.path ? "true" : undefined}
                  onClick={() => selectFile(f.path)}
                >
                  <span data-slot="status" data-status={f.status} title={f.status} />
                  <span data-slot="file-path" title={f.path}>{f.path}</span>
                  <span data-slot="stats">
                    <Show when={f.added > 0}>
                      <span data-slot="added">+{f.added}</span>
                    </Show>
                    <Show when={f.removed > 0}>
                      <span data-slot="removed">-{f.removed}</span>
                    </Show>
                  </span>
                </button>
              )}
            </For>
          </div>
        </div>
        
        <div data-slot="content">
          <Show when={props.diff?.truncated}>
            <div data-slot="banner">
              Il diff è troppo grande ed è stato troncato. Stai visualizzando solo l'elenco dei file.
            </div>
          </Show>

          <Show when={selectedFile()}>
            {(file) => (
              <div data-slot="file-detail">
                <div data-slot="file-header">
                  {file().path}
                  <Show when={file().oldPath}>
                    <span data-slot="rename"> (rinominato da {file().oldPath})</span>
                  </Show>
                </div>
                
                <Show when={file().binary}>
                  <div data-slot="placeholder">
                    Il file è binario, impossibile mostrare le differenze testuali.
                  </div>
                </Show>

                <Show when={!file().binary && props.diff?.truncated}>
                  <div data-slot="placeholder">
                    Contenuto non disponibile (diff troppo grande).
                  </div>
                </Show>

                <Show when={!file().binary && !props.diff?.truncated && file().hunks.length === 0 && (file().added > 0 || file().removed > 0 || file().status === 'modified')}>
                   <div data-slot="placeholder">
                    Modifiche non analizzabili o file vuoto.
                  </div>
                </Show>

                <Show when={!file().binary && !props.diff?.truncated && file().hunks.length > 0}>
                  <div data-slot="hunks">
                    <For each={file().hunks}>
                      {(hunk) => (
                        <div data-slot="hunk">
                          <div data-slot="hunk-header">{hunk.header}</div>
                          <table data-slot="table">
                            <tbody>
                              <For each={hunk.lines}>
                                {(line) => (
                                  <tr data-slot="diff-line" data-kind={line.kind}>
                                    <td data-slot="line-number" data-line-number={line.oldNumber || ""} />
                                    <td data-slot="line-number" data-line-number={line.newNumber || ""} />
                                    <td data-slot="line-text">{line.text}</td>
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
            <div data-slot="placeholder">
              Seleziona un file per visualizzarne il contenuto.
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}
