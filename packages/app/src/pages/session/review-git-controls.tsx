import type {
  MobileBootstrap,
  MobileGitBranchesResponse,
  MobileGitCommitsResponse,
  MobileGitStatusResponse,
} from "@nikcli-ai/sdk/httpapi"
import { useParams } from "@solidjs/router"
import { useSync } from "@/context/sync"
import { commitSubject } from "@/pages/session/commit-subject"
import { Button } from "@nikcli-ai/ui/button"
import { useDialog } from "@nikcli-ai/ui/context/dialog"
import { Dialog } from "@nikcli-ai/ui/dialog"
import { Icon } from "@nikcli-ai/ui/icon"
import { IconButton } from "@nikcli-ai/ui/icon-button"
import { TextField } from "@nikcli-ai/ui/text-field"
import { Tooltip } from "@nikcli-ai/ui/tooltip"
import { showToast } from "@nikcli-ai/ui/toast"
import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX, createEffect } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { errorMessage, requestData } from "@/pages/session/git-request"
import { DialogCreatePR } from "@/pages/session/dialog-create-pr"
import { DialogGitHubAccount } from "@/pages/session/dialog-github-account"

type GitStatus = MobileGitStatusResponse
type GitBranch = MobileGitBranchesResponse[number]
type GitCommit = MobileGitCommitsResponse[number]
type GitChange = GitStatus["staged"][number] | GitStatus["unstaged"][number]

function StatusBadge(props: { children: JSX.Element; tone?: "default" | "success" | "warning" }) {
  return (
    <span
      class="inline-flex min-w-0 items-center gap-1 rounded-md border border-border-weak-base bg-surface-base px-2 py-1 text-11-medium"
      classList={{
        "text-text-weak": !props.tone || props.tone === "default",
        "text-icon-success-base": props.tone === "success",
        "text-icon-warning-base": props.tone === "warning",
      }}
    >
      {props.children}
    </span>
  )
}

function DialogGitChanges(props: { onChanged: () => void }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const language = useLanguage()
  const [status, setStatus] = createSignal<GitStatus>()
  const [loading, setLoading] = createSignal(true)
  const [busy, setBusy] = createSignal("")
  // Prefilled from the session title, which is a summary of the very work being
  // committed. A draft in an editable field, not a decision: see `commitSubject`.
  const params = useParams()
  const sync = useSync()
  const sessionTitle = () => (params.id ? sync.data.session.find((item) => item.id === params.id)?.title : undefined)
  const [message, setMessage] = createSignal("")
  // The title is model-generated a few seconds after the first message. Reading
  // it once at construction left the field empty forever for anyone who opened
  // this dialog before it landed. Filled when it arrives, and never over
  // something the user has already typed.
  createEffect(() => {
    const suggestion = commitSubject(sessionTitle())
    if (suggestion && !message().trim()) setMessage(suggestion)
  })
  const [discardTarget, setDiscardTarget] = createSignal("")

  const refresh = async () => {
    setLoading(true)
    try {
      setStatus(await requestData(sdk.client.mobile.git.status({ directory: sdk.directory })))
    } catch (error) {
      showToast({ variant: "error", title: language.t("git.toast.statusFailed"), description: errorMessage(error) })
    } finally {
      setLoading(false)
    }
  }

  const run = async (key: string, action: () => Promise<unknown>, success: string) => {
    if (busy()) return
    setBusy(key)
    try {
      await action()
      await refresh()
      props.onChanged()
      showToast({ variant: "success", icon: "circle-check", title: success })
    } catch (error) {
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: errorMessage(error) })
    } finally {
      setBusy("")
    }
  }

  const discard = (paths: string[]) =>
    run(
      `discard:${paths.join(",")}`,
      () => requestData(sdk.client.mobile.git.discard({ directory: sdk.directory, files: paths })),
      language.t("git.toast.discarded"),
    )

  const unstagedPaths = createMemo(() => [
    ...(status()?.unstaged.map((change) => change.path) ?? []),
    ...(status()?.untracked ?? []),
  ])
  const stagedPaths = createMemo(() => status()?.staged.map((change) => change.path) ?? [])
  const hasChanges = createMemo(() => stagedPaths().length + unstagedPaths().length > 0)

  const commit = async (event: SubmitEvent) => {
    event.preventDefault()
    const value = message().trim()
    if (!value) return
    await run(
      "commit",
      () =>
        requestData(
          sdk.client.mobile.git.commit({
            directory: sdk.directory,
            message: value,
            stagedOnly: stagedPaths().length > 0,
          }),
        ),
      language.t("git.toast.committed"),
    )
    setMessage("")
  }

  onMount(refresh)

  const ChangeRow = (rowProps: { change: GitChange; staged: boolean }) => {
    const stats = () =>
      "additions" in rowProps.change
        ? { additions: rowProps.change.additions, deletions: rowProps.change.deletions }
        : undefined

    return (
      <div class="flex min-w-0 items-center gap-3 border-b border-border-weak-base px-3 py-2 last:border-b-0">
        <span
          class="flex size-6 shrink-0 items-center justify-center rounded bg-surface-raised-base text-11-medium uppercase text-text-weak"
          title={rowProps.change.status}
        >
          {rowProps.change.status.slice(0, 1)}
        </span>
        <div class="min-w-0 flex-1">
          <div class="truncate text-13-medium text-text-base">{rowProps.change.path}</div>
          <Show when={stats()}>
            {(value) => (
              <div class="mt-0.5 text-11-regular text-text-weaker">
                <span class="text-icon-success-base">+{value().additions}</span>
                <span class="ml-2 text-icon-critical-base">-{value().deletions}</span>
              </div>
            )}
          </Show>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <Show when={!rowProps.staged}>
            <Show
              when={discardTarget() === rowProps.change.path}
              fallback={
                <IconButton
                  icon="trash"
                  variant="ghost"
                  class="size-7"
                  aria-label={language.t("git.action.discard")}
                  disabled={!!busy()}
                  onClick={() => setDiscardTarget(rowProps.change.path)}
                />
              }
            >
              <Button size="small" variant="ghost" disabled={!!busy()} onClick={() => setDiscardTarget("")}>
                {language.t("common.cancel")}
              </Button>
              <Button
                size="small"
                variant="ghost"
                class="text-icon-critical-base"
                disabled={!!busy()}
                onClick={() => void discard([rowProps.change.path]).then(() => setDiscardTarget(""))}
              >
                {language.t("git.action.confirmDiscard")}
              </Button>
            </Show>
          </Show>
          <Button
            size="small"
            variant="ghost"
            disabled={!!busy()}
            onClick={() =>
              run(
                `${rowProps.staged ? "unstage" : "stage"}:${rowProps.change.path}`,
                () =>
                  requestData(
                    rowProps.staged
                      ? sdk.client.mobile.git.unstage({ directory: sdk.directory, files: [rowProps.change.path] })
                      : sdk.client.mobile.git.stage({ directory: sdk.directory, files: [rowProps.change.path] }),
                  ),
                rowProps.staged ? language.t("git.toast.unstaged") : language.t("git.toast.staged"),
              )
            }
          >
            {rowProps.staged ? language.t("git.action.unstage") : language.t("git.action.stage")}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <Dialog size="large" title={language.t("git.changes.title")} description={language.t("git.changes.description")}>
      <div class="flex max-h-[70vh] min-h-0 w-full flex-col gap-4">
        <div class="flex flex-wrap items-center gap-2">
          <StatusBadge>{status()?.branch || language.t("common.loading")}</StatusBadge>
          <StatusBadge tone={(status()?.commitsAhead ?? 0) > 0 ? "warning" : "default"}>
            {language.t("git.status.ahead", { count: status()?.commitsAhead ?? 0 })}
          </StatusBadge>
          <StatusBadge tone={(status()?.commitsBehind ?? 0) > 0 ? "warning" : "default"}>
            {language.t("git.status.behind", { count: status()?.commitsBehind ?? 0 })}
          </StatusBadge>
          <Button size="small" variant="ghost" class="ml-auto" disabled={loading()} onClick={refresh}>
            {language.t("common.refresh")}
          </Button>
        </div>

        <div class="min-h-0 overflow-y-auto rounded-md border border-border-base">
          <Show
            when={!loading()}
            fallback={<div class="p-4 text-13-regular text-text-weak">{language.t("common.loading")}</div>}
          >
            <Show
              when={hasChanges()}
              fallback={<div class="p-6 text-center text-13-regular text-text-weak">{language.t("git.clean")}</div>}
            >
              <Show when={stagedPaths().length}>
                <div class="flex items-center justify-between bg-surface-raised-base px-3 py-2">
                  <span class="text-11-medium uppercase tracking-wide text-text-weak">
                    {language.t("git.section.staged", { count: stagedPaths().length })}
                  </span>
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={!!busy()}
                    onClick={() =>
                      run(
                        "unstage-all",
                        () =>
                          requestData(
                            sdk.client.mobile.git.unstage({ directory: sdk.directory, files: stagedPaths() }),
                          ),
                        language.t("git.toast.unstaged"),
                      )
                    }
                  >
                    {language.t("git.action.unstageAll")}
                  </Button>
                </div>
                <For each={status()?.staged}>{(change) => <ChangeRow change={change} staged />}</For>
              </Show>

              <Show when={unstagedPaths().length}>
                <div class="flex items-center justify-between bg-surface-raised-base px-3 py-2">
                  <span class="text-11-medium uppercase tracking-wide text-text-weak">
                    {language.t("git.section.unstaged", { count: unstagedPaths().length })}
                  </span>
                  <div class="flex items-center gap-1">
                    <Show
                      when={discardTarget() === "__all__"}
                      fallback={
                        <Button
                          size="small"
                          variant="ghost"
                          disabled={!!busy()}
                          onClick={() => setDiscardTarget("__all__")}
                        >
                          {language.t("git.action.discardAll")}
                        </Button>
                      }
                    >
                      <Button size="small" variant="ghost" disabled={!!busy()} onClick={() => setDiscardTarget("")}>
                        {language.t("common.cancel")}
                      </Button>
                      <Button
                        size="small"
                        variant="ghost"
                        class="text-icon-critical-base"
                        disabled={!!busy()}
                        onClick={() => void discard(unstagedPaths()).then(() => setDiscardTarget(""))}
                      >
                        {language.t("git.action.confirmDiscard")}
                      </Button>
                    </Show>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={!!busy()}
                      onClick={() =>
                        run(
                          "stage-all",
                          () =>
                            requestData(
                              sdk.client.mobile.git.stage({ directory: sdk.directory, files: unstagedPaths() }),
                            ),
                          language.t("git.toast.staged"),
                        )
                      }
                    >
                      {language.t("git.action.stageAll")}
                    </Button>
                  </div>
                </div>
                <For each={status()?.unstaged}>{(change) => <ChangeRow change={change} staged={false} />}</For>
                <For each={status()?.untracked}>
                  {(path) => (
                    <ChangeRow change={{ status: "added", path, additions: 0, deletions: 0 }} staged={false} />
                  )}
                </For>
              </Show>
            </Show>
          </Show>
        </div>

        <form class="flex flex-col gap-3 border-t border-border-weak-base pt-4" onSubmit={commit}>
          <TextField
            label={language.t("git.commit.message")}
            placeholder={language.t("git.commit.placeholder")}
            value={message()}
            onChange={setMessage}
          />
          <div class="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.close")}
            </Button>
            <Button type="submit" variant="primary" size="large" disabled={!message().trim() || !!busy()}>
              {busy() === "commit" ? language.t("git.commit.running") : language.t("git.commit.action")}
            </Button>
          </div>
        </form>
      </div>
    </Dialog>
  )
}

function DialogGitBranches(props: { onChanged: () => void }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const language = useLanguage()
  const [branches, setBranches] = createSignal<GitBranch[]>([])
  const [name, setName] = createSignal("")
  const [query, setQuery] = createSignal("")
  const [busy, setBusy] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  const filteredBranches = createMemo(() => {
    const value = query().trim().toLowerCase()
    if (!value) return branches()
    return branches().filter((branch) => branch.name.toLowerCase().includes(value))
  })

  const refresh = async () => {
    setLoading(true)
    try {
      setBranches(await requestData(sdk.client.mobile.git.branches({ directory: sdk.directory })))
    } catch (error) {
      showToast({ variant: "error", title: language.t("git.toast.branchesFailed"), description: errorMessage(error) })
    } finally {
      setLoading(false)
    }
  }

  const mutate = async (key: string, action: () => Promise<unknown>, message: string) => {
    if (busy()) return
    setBusy(key)
    try {
      await action()
      await refresh()
      props.onChanged()
      showToast({ variant: "success", icon: "circle-check", title: message })
    } catch (error) {
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: errorMessage(error) })
    } finally {
      setBusy("")
    }
  }

  const createBranch = async (event: SubmitEvent) => {
    event.preventDefault()
    const branch = name().trim()
    if (!branch) return
    await mutate(
      "create",
      () => requestData(sdk.client.mobile.git.checkout({ directory: sdk.directory, branch, create: true })),
      language.t("git.toast.branchCreated"),
    )
    setName("")
  }

  onMount(refresh)

  return (
    <Dialog size="large" title={language.t("git.branches.title")} description={language.t("git.branches.description")}>
      <div class="flex max-h-[70vh] min-h-0 w-full flex-col gap-4">
        <form class="flex items-end gap-2" onSubmit={createBranch}>
          <TextField
            class="flex-1"
            label={language.t("git.branches.new")}
            placeholder="feature/my-change"
            value={name()}
            onChange={setName}
          />
          <Button type="submit" variant="primary" size="large" disabled={!name().trim() || !!busy()}>
            {language.t("git.branches.create")}
          </Button>
        </form>
        <TextField
          label={language.t("git.branches.search")}
          placeholder={language.t("git.branches.searchPlaceholder")}
          value={query()}
          onChange={setQuery}
        />

        <div class="min-h-0 overflow-y-auto rounded-md border border-border-base">
          <Show
            when={!loading()}
            fallback={<div class="p-4 text-13-regular text-text-weak">{language.t("common.loading")}</div>}
          >
            <For
              each={filteredBranches()}
              fallback={
                <div class="p-6 text-center text-13-regular text-text-weak">{language.t("git.branches.noResults")}</div>
              }
            >
              {(branch) => (
                <div class="flex min-w-0 items-center gap-3 border-b border-border-weak-base px-3 py-2 last:border-b-0">
                  <Icon name="branch" size="small" class="text-icon-weak-base" />
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span class="truncate text-13-medium text-text-base">{branch.name}</span>
                      <Show when={branch.isCurrent}>
                        <StatusBadge tone="success">{language.t("git.branches.current")}</StatusBadge>
                      </Show>
                      <Show when={branch.isProtected}>
                        <StatusBadge>{language.t("git.branches.protected")}</StatusBadge>
                      </Show>
                    </div>
                    <Show when={branch.aheadBy || branch.behindBy}>
                      <div class="mt-0.5 text-11-regular text-text-weak">
                        {language.t("git.status.ahead", { count: branch.aheadBy })} ·{" "}
                        {language.t("git.status.behind", { count: branch.behindBy })}
                      </div>
                    </Show>
                  </div>
                  <Show when={!branch.isCurrent}>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={!!busy()}
                      onClick={() =>
                        mutate(
                          `checkout:${branch.name}`,
                          () =>
                            requestData(
                              sdk.client.mobile.git.checkout({ directory: sdk.directory, branch: branch.name }),
                            ),
                          language.t("git.toast.branchSwitched"),
                        )
                      }
                    >
                      {language.t("git.branches.checkout")}
                    </Button>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </div>

        <div class="flex justify-end">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.close")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function DialogGitHistory() {
  const sdk = useSDK()
  const dialog = useDialog()
  const language = useLanguage()
  const [commits, setCommits] = createSignal<GitCommit[]>([])
  const [loading, setLoading] = createSignal(true)

  onMount(async () => {
    try {
      setCommits(await requestData(sdk.client.mobile.git.commits({ directory: sdk.directory, limit: 50 })))
    } catch (error) {
      showToast({ variant: "error", title: language.t("git.toast.historyFailed"), description: errorMessage(error) })
    } finally {
      setLoading(false)
    }
  })

  return (
    <Dialog title={language.t("git.history.title")} description={language.t("git.history.description")} size="large">
      <div class="flex max-h-[70vh] min-h-0 w-full flex-col gap-4">
        <div class="min-h-0 overflow-y-auto rounded-md border border-border-base">
          <Show
            when={!loading()}
            fallback={<div class="p-4 text-13-regular text-text-weak">{language.t("common.loading")}</div>}
          >
            <For
              each={commits()}
              fallback={
                <div class="p-6 text-center text-13-regular text-text-weak">{language.t("git.history.empty")}</div>
              }
            >
              {(commit) => (
                <div class="flex min-w-0 gap-3 border-b border-border-weak-base px-3 py-3 last:border-b-0">
                  <span class="shrink-0 font-mono text-11-medium text-text-interactive-base">
                    {commit.sha.slice(0, 7)}
                  </span>
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-13-medium text-text-base">{commit.message}</div>
                    <div class="mt-1 text-11-regular text-text-weak">
                      {commit.author.name} · {new Date(commit.timestamp).toLocaleString()} · {commit.filesCount} files ·{" "}
                      <span class="text-icon-success-base">+{commit.additions}</span>{" "}
                      <span class="text-icon-critical-base">-{commit.deletions}</span>
                    </div>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>
        <div class="flex justify-end">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.close")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export function ReviewGitControls(props: { onChanged: () => void }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const language = useLanguage()
  const [status, setStatus] = createSignal<GitStatus>()
  const [bootstrap, setBootstrap] = createSignal<MobileBootstrap>()
  const [busy, setBusy] = createSignal("")

  const refresh = async () => {
    try {
      setStatus(await requestData(sdk.client.mobile.git.status({ directory: sdk.directory })))
    } catch {
      setStatus()
    }
    // The connection chip reads the same bootstrap the account dialog edits, so
    // a failed read must not take the git status down with it.
    try {
      setBootstrap(await requestData(sdk.client.mobile.bootstrap({ directory: sdk.directory })))
    } catch {
      setBootstrap()
    }
  }

  const ahead = () => status()?.commitsAhead ?? 0
  const behind = () => status()?.commitsBehind ?? 0

  const openPullRequest = () => dialog.show(() => <DialogCreatePR />)

  const sync = async (kind: "pull" | "push") => {
    if (busy()) return
    setBusy(kind)
    try {
      const result =
        kind === "pull"
          ? await requestData(sdk.client.mobile.git.pull({ directory: sdk.directory }))
          : await requestData(sdk.client.mobile.git.push({ directory: sdk.directory }))
      if ("conflicts" in result && result.conflicts?.length) {
        throw new Error(language.t("git.pull.conflicts", { files: result.conflicts.join(", ") }))
      }
      if (!("pulled" in result ? result.pulled : result.pushed)) {
        throw new Error(kind === "pull" ? language.t("git.pull.failed") : language.t("git.push.failed"))
      }
      await refresh()
      props.onChanged()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: kind === "pull" ? language.t("git.toast.pulled") : language.t("git.toast.pushed"),
      })
    } catch (error) {
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: errorMessage(error) })
    } finally {
      setBusy("")
    }
  }

  const changed = () => {
    void refresh()
    props.onChanged()
  }

  onMount(refresh)

  const Tool = (toolProps: {
    label: string
    icon: Parameters<typeof IconButton>[0]["icon"]
    onClick: () => void
    active?: boolean
    disabled?: boolean
  }) => (
    <Tooltip value={toolProps.label} placement="bottom">
      <IconButton
        icon={toolProps.icon}
        variant="ghost"
        class="size-8"
        classList={{ "bg-surface-base text-icon-strong-base": toolProps.active }}
        aria-label={toolProps.label}
        disabled={toolProps.disabled}
        onClick={toolProps.onClick}
      />
    </Tooltip>
  )

  return (
    <div
      data-component="review-git-controls"
      class="sticky right-12 z-10 flex h-full shrink-0 items-center gap-0.5 border-b border-border-weak-base bg-background-base px-2"
    >
      <Show when={status()?.branch}>
        <button
          type="button"
          class="mr-1 flex max-w-56 items-center gap-1.5 rounded-md px-2 py-1 text-11-medium text-text-weak hover:bg-surface-base-hover hover:text-text-base"
          onClick={() => dialog.show(() => <DialogGitBranches onChanged={changed} />)}
          title={status()?.branch}
        >
          <Icon name="branch" size="small" class="shrink-0" />
          <span class="truncate">{status()?.branch}</span>
          {/* Zeros stay on screen: mounting the counts only once they are
              non-zero resized the chip on every poll and shifted the whole row. */}
          <span class="flex shrink-0 items-center gap-1 tabular-nums">
            {/* A zero still says "nothing to push" - that is state, not decoration,
                so it stays readable. The de-emphasis token measured 1.79:1 here. */}
            <span classList={{ "text-icon-warning-base": ahead() > 0, "text-text-weak": ahead() === 0 }}>
              ↑{ahead()}
            </span>
            <span classList={{ "text-icon-warning-base": behind() > 0, "text-text-weak": behind() === 0 }}>
              ↓{behind()}
            </span>
          </span>
        </button>
      </Show>
      <Tool
        label={language.t("git.toolbar.changes")}
        icon="checklist"
        active={
          (status()?.staged.length ?? 0) + (status()?.unstaged.length ?? 0) + (status()?.untracked.length ?? 0) > 0
        }
        onClick={() => dialog.show(() => <DialogGitChanges onChanged={changed} />)}
      />
      <Tool
        label={language.t("git.toolbar.branches")}
        icon="branch"
        onClick={() => dialog.show(() => <DialogGitBranches onChanged={changed} />)}
      />
      <Tool
        label={language.t("git.toolbar.pull")}
        icon="arrow-down-to-line"
        disabled={!!busy()}
        onClick={() => void sync("pull")}
      />
      <Tool
        label={language.t("git.toolbar.push")}
        icon="cloud-upload"
        disabled={!!busy()}
        onClick={() => void sync("push")}
      />
      <Tool
        label={language.t("git.toolbar.history")}
        icon="bullet-list"
        onClick={() => dialog.show(() => <DialogGitHistory />)}
      />
      <Tool
        label={language.t("github.pr.title")}
        icon="git-pull-request"
        onClick={openPullRequest}
      />
      {/* Connection decides whether push and pull requests can work at all, so
          it is a labeled state chip rather than one more icon among icons. Until
          the first bootstrap read lands, keep the neutral icon to avoid flashing
          "Connect GitHub" at users who are already connected. */}
      <Show
        when={bootstrap()}
        fallback={
          <Tool
            label={language.t("git.toolbar.github")}
            icon="github"
            onClick={() => dialog.show(() => <DialogGitHubAccount onChanged={changed} />)}
          />
        }
      >
        {(value) => (
          <Show
            when={value().github.connected}
            fallback={
              <button
                type="button"
                class="ml-1 flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border-weak-base bg-surface-base px-2 text-11-medium text-text-base hover:bg-surface-base-hover"
                onClick={() => dialog.show(() => <DialogGitHubAccount onChanged={changed} />)}
              >
                <Icon name="github" size="small" />
                {language.t("github.pr.connectAction")}
              </button>
            }
          >
            <button
              type="button"
              class="ml-1 flex h-7 max-w-36 items-center gap-1.5 rounded-md px-2 py-1 text-11-medium text-text-weak hover:bg-surface-base-hover hover:text-text-base"
              onClick={() => dialog.show(() => <DialogGitHubAccount onChanged={changed} />)}
              title={language.t("git.toolbar.github")}
            >
              <span class="size-1.5 shrink-0 rounded-full bg-icon-success-base" />
              <span class="truncate">@{value().github.user?.login ?? "github"}</span>
            </button>
          </Show>
        )}
      </Show>
    </div>
  )
}
