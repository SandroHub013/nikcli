import { Show } from "solid-js"
import type { Project } from "../host/project"
import { t } from "../i18n"

export interface ProjectBarProps {
  project?: Project
  /** The nikcli the user is running, or undefined when there is none to name. */
  nikcliVersion?: string
}

/**
 * Which project ADE is pointed at, in the top bar.
 *
 * The "senza isolamento" mark is the point of this component: outside a git
 * repository there are no worktrees to hand out, so every agent edits the
 * user's own files. That is a fact about their work, not a technical footnote,
 * and it belongs where they can see it without asking.
 *
 * The branch used to sit here too and has moved to the sidebar, where it
 * already was beside the project: in a bar that is the same at every moment,
 * a name like `ade/feat-ade-integra` truncated at its end read as a path, and
 * it said nothing the column below did not say better. What takes its place is
 * the one thing the bar could not tell you at all — which nikcli every session
 * started from here is going to be.
 */
export function ProjectBar(props: ProjectBarProps) {
  return (
    <Show when={props.project}>
      {(project) => (
        <div data-slot="ade-project">
          <Show when={project().name && project().name.toLowerCase() !== "nikcli"}>
            <span data-slot="ade-project-name">{project().name}</span>
          </Show>
          {/* Nothing at all when nikcli is absent or would not say: an empty
              space is the correct report, and a message here would be
              permanent furniture for a fact about the machine. */}
          <Show when={props.nikcliVersion}>
            {(version) => (
              <span data-slot="ade-nikcli-version" title={t("bar.nikcliVersion", version())}>
                <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M6 4L2.5 8 6 12" />
                  <path d="M10 4l3.5 4-3.5 4" />
                </svg>
                {/*
                 * Isolated, and clipped from the left by the stylesheet: what
                 * matters in a version is its end, so a bar with no room for
                 * "v1.384.0" must lose the v and not the 0.
                 */}
                <bdi data-slot="ade-nikcli-number">{version()}</bdi>
              </span>
            )}
          </Show>
          <Show when={!project().git}>
            <span
              data-slot="ade-project-warning"
              title={t("projectBar.noGit")}
            >
              {t("projectBar.noGit.short")}
            </span>
          </Show>
        </div>
      )}
    </Show>
  )
}
