import { Show } from "solid-js"
import type { Project } from "../host/project"
import { t } from "../i18n"

export interface ProjectBarProps {
  project?: Project
  /** ADE's own version, the one the bar names: the user is looking at ADE. */
  adeVersion?: string
  /** The nikcli new sessions start with. Not in the text: it is in the tooltip, where it is asked for. */
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
  // «ADE 1.2.3»: the name already says what the number is, the «v» is noise. This is ADE's
  // version because the bar is ADE's; the nikcli one is in the tooltip below.
  const version = () => props.adeVersion?.replace(/^v(?=\d)/, "")
  const facts = (project: Project) =>
    [
      version() ? t("bar.meta.ade", version()!) : undefined,
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
                <span
                  data-slot="ade-meta-item"
                  title={props.nikcliVersion ? t("bar.nikcliVersion", props.nikcliVersion) : undefined}
                >
                  {t("bar.meta.ade", shown())}
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
