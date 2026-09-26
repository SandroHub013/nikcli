import { Show } from "solid-js"
import type { Project } from "../host/project"
import { t } from "../i18n"

export interface ProjectBarProps {
  project?: Project
  /** The nikcli the user is running, or undefined when there is none to name. */
  nikcliVersion?: string
  /** The sessions open in this project. */
  sessions: number
}

/**
 * Which project ADE is pointed at, in the top bar.
 *
 * Two weights (DS-polish, closure 8): the name, and one line of facts under
 * the bar's voice — which nikcli, whether agents are isolated, how many
 * sessions. The "senza isolamento" mark is the one that matters: outside a
 * git repository there are no worktrees to hand out, so every agent edits the
 * user's own files. It keeps its red, as a dot, not as a pink chip.
 *
 * Under 1100 px the line gives way to an «i» that holds the same three facts
 * (closure 2): the stylesheet chooses, the popover is the browser's own.
 */
export function ProjectBar(props: ProjectBarProps) {
  // «nikcli 1.399.0»: the program's name already says what the number is, the «v» is noise.
  const version = () => props.nikcliVersion?.replace(/^v(?=\d)/, "")
  const facts = (project: Project) =>
    [
      version() ? t("bar.meta.nikcli", version()!) : undefined,
      project.git ? undefined : t("projectBar.noGit.short"),
      t("bar.sessions", props.sessions),
    ].filter((fact): fact is string => Boolean(fact))
  return (
    <Show when={props.project}>
      {(project) => (
        <div data-slot="ade-project">
          <Show when={project().name && project().name.toLowerCase() !== "nikcli"}>
            <span data-slot="ade-project-name" title={project().name}>
              {project().name}
            </span>
          </Show>
          <span data-slot="ade-project-meta">
            {/* Nothing at all when nikcli is absent or would not say: an empty
                space is the correct report. */}
            <Show when={version()}>
              {(shown) => (
                <span data-slot="ade-meta-item" title={t("bar.nikcliVersion", props.nikcliVersion ?? shown())}>
                  {t("bar.meta.nikcli", shown())}
                </span>
              )}
            </Show>
            <Show when={!project().git}>
              <span data-slot="ade-meta-item" data-tone="error" title={t("projectBar.noGit")}>
                <span data-slot="ade-meta-dot" aria-hidden="true" />
                {t("projectBar.noGit.short")}
              </span>
            </Show>
            <span data-slot="ade-meta-item">{t("bar.sessions", props.sessions)}</span>
          </span>
          <button
            type="button"
            data-slot="ade-project-info"
            popovertarget="ade-project-facts"
            aria-label={t("bar.info", facts(project()).join(", "))}
          >
            i
          </button>
          <div id="ade-project-facts" data-slot="ade-project-facts" popover="auto">
            {facts(project()).map((fact) => (
              <p>{fact}</p>
            ))}
            <Show when={!project().git}>
              <p data-slot="ade-project-facts-note">{t("projectBar.noGit")}</p>
            </Show>
          </div>
        </div>
      )}
    </Show>
  )
}
