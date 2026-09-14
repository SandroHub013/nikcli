import { createMemo, createSignal, onMount, Show } from "solid-js"
import { type Branch, compareUrl, createPullRequest, type CreatedPR, type Repo, toRepo } from "./create-pr"
import { Dialog } from "@nikcli-ai/ui/dialog"
import { Button } from "@nikcli-ai/ui/button"
import { Select } from "@nikcli-ai/ui/select"
import { Switch } from "@nikcli-ai/ui/switch"
import { TextField } from "@nikcli-ai/ui/text-field"
import { Icon } from "@nikcli-ai/ui/icon"
import { showToast } from "@nikcli-ai/ui/toast"
import { useDialog } from "@nikcli-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { errorMessage, requestData } from "@/pages/session/git-request"
import { DialogGitHubAccount } from "@/pages/session/dialog-github-account"

/**
 * Push the current branch, then create a pull request via the GitHub API if
 * connected, or hand the user a prefilled compare form on GitHub as fallback.
 *
 * The strings for this flow already existed in `en.ts` — the whole dialog was
 * specified and never built, so the app's only GitHub affordance was an account
 * dialog. This uses `github.repos` and `github.branches`, two of the endpoints
 * the server exposed but the app never called.
 *
 * Deliberately not `github.session.publish`: that only works for sessions
 * created *from* GitHub, whereas most sessions here are local checkouts that
 * merely have a GitHub origin.
 */

export function DialogCreatePR(props: { defaultTitle?: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()

  const [repo, setRepo] = createSignal<Repo>()
  const [base, setBase] = createSignal<string>()
  const [title, setTitle] = createSignal(props.defaultTitle || language.t("github.pr.defaultTitle"))
  const [body, setBody] = createSignal("")
  const [draft, setDraft] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [created, setCreated] = createSignal<CreatedPR>()
  const [error, setError] = createSignal<string>()
  const [fallbackUrl, setFallbackUrl] = createSignal<string>()

  // Signals fetched on mount, not `createResource`: a suspending resource trips
  // the Suspense boundary above the dialog and blanks the whole workbench behind
  // it, exactly when the user needs to see which branch they are proposing.
  const [head, setHead] = createSignal("")
  const [connected, setConnected] = createSignal(false)
  const [repos, setRepos] = createSignal<Repo[]>()
  const [branches, setBranches] = createSignal<Branch[]>()

  const unwrapList = (result: unknown): unknown[] => {
    if (Array.isArray(result)) return result
    const data = (result as { data?: unknown } | undefined)?.data
    return Array.isArray(data) ? data : []
  }

  /**
   * Also the recovery path: connecting an account from the fallback below has to
   * re-run this, or the dialog stays on "connect" until it is closed and reopened.
   */
  const loadAccount = () => {
    void requestData(sdk.client.mobile.bootstrap({ directory: sdk.directory }))
      .then(async (bootstrap) => {
        const isConnected = !!bootstrap.github.connected
        setConnected(isConnected)
        if (!isConnected) return
        const result = await sdk.client.mobile.github.repos()
        const list = unwrapList(result).map(toRepo).filter((item): item is Repo => !!item)
        setRepos(list)

        // The server knows this checkout's origin but does not expose it, so the
        // folder name is the best signal available here. Preselecting the match
        // beats an empty picker: choosing an unrelated repository produces a
        // compare URL for a branch that does not exist there.
        const folder = sdk.directory
          .replace(/[\/]+$/, "")
          .split(/[\/]/)
          .pop()
          ?.toLowerCase()
        const match = folder ? list.find((item) => item.repo.toLowerCase() === folder) : undefined
        if (match) {
          setRepo(match)
          loadBranches(match)
        }
      })
      .catch(() => setRepos([]))
  }

  onMount(() => {
    void requestData(sdk.client.mobile.git.status({ directory: sdk.directory }))
      .then((status) => setHead(status.branch))
      .catch(() => undefined)
    loadAccount()
  })

  const loadBranches = (current: Repo) => {
    setBase(current.defaultBranch)
    setBranches(undefined)
    void sdk.client.mobile.github
      .branches({ owner: current.owner, repo: current.repo })
      .then((result) => setBranches(unwrapList(result) as Branch[]))
      .catch(() => setBranches([]))
  }

  const ready = createMemo(() => !!repo() && !!base() && !!head() && !busy())

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const current = repo()
    const baseBranch = base()
    if (!current || !baseBranch || !head() || busy()) return

    setBusy(true)
    setError(undefined)
    setFallbackUrl(undefined)
    try {
      // Nothing to compare against until the branch exists on the remote.
      await sdk.client.mobile.git.push({ directory: sdk.directory })

      // The push goes to this checkout's origin, while the repository above was
      // picked from every repository on the account — nothing ties the two. If
      // the branch is not on the chosen repository, GitHub would answer 404, so
      // say so here instead.
      const remote = unwrapList(
        await sdk.client.mobile.github.branches({ owner: current.owner, repo: current.repo }),
      ) as Branch[]
      if (remote.length > 0 && !remote.some((branch) => branch.name === head())) {
        throw new Error(language.t("github.pr.branchMissing", { branch: head(), repo: current.fullName }))
      }

      const result = await createPullRequest({
        connected: connected(),
        repo: current,
        base: baseBranch,
        head: head(),
        title: title().trim(),
        body: body().trim(),
        draft: draft(),
        createApi: async (params) => {
          const fetchFn = platform.fetch ?? fetch
          const res = await fetchFn(`${sdk.url}/mobile/github/pr`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(sdk.directory ? { "x-nikcli-directory": sdk.directory } : {}),
            },
            body: JSON.stringify(params),
          })
          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }))
            throw new Error(err.error || `HTTP ${res.status}`)
          }
          return res.json()
        },
      })

      if (result.type === "created") {
        setCreated(result.pr)
        showToast({ variant: "success", icon: "circle-check", title: language.t("github.pr.created") })
      } else {
        platform.openLink(result.url)
        showToast({ variant: "success", icon: "circle-check", title: language.t("github.pr.opened") })
        dialog.close()
      }
    } catch (err) {
      const fallback = compareUrl({
        repo: current,
        base: baseBranch,
        head: head(),
        title: title().trim(),
        body: body().trim(),
        draft: draft(),
      })
      const msg = errorMessage(err)
      setError(msg)
      setFallbackUrl(fallback)
      showToast({
        variant: "error",
        title: language.t("github.pr.failed"),
        description: msg,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog size="large" title={language.t("github.pr.title")} description={language.t("github.pr.description")}>
      <Show
        when={connected()}
        fallback={
          <div class="flex flex-col items-start gap-3 py-2">
            <div class="text-13-regular text-text-weak">{language.t("github.pr.connectTitle")}</div>
            <Button onClick={() => dialog.show(() => <DialogGitHubAccount onChanged={loadAccount} />)}>
              {language.t("github.pr.connectAction")}
            </Button>
          </div>
        }
      >
        <Show
          when={created()}
          fallback={
            <form class="flex flex-col gap-4" onSubmit={submit}>
              <Show when={error()}>
                <div class="flex flex-col gap-2 rounded-md bg-surface-critical-base/10 p-3 border border-border-critical-base/20">
                  <div class="text-13-medium text-text-critical-base">{error()}</div>
                  <Show when={fallbackUrl()}>
                    <div class="flex items-center gap-2 pt-1">
                      <Button
                        size="small"
                        variant="secondary"
                        onClick={() => {
                          platform.openLink(fallbackUrl()!)
                          dialog.close()
                        }}
                      >
                        {language.t("github.pr.open")}
                      </Button>
                    </div>
                  </Show>
                </div>
              </Show>

              <div class="flex flex-col gap-1.5">
                <div class="text-13-medium text-text-base">{language.t("github.pr.repository")}</div>
                <Show
                  when={repos() !== undefined && repos()!.length === 0}
                  fallback={
                    <Select
                      options={repos() ?? []}
                      current={repo()}
                      value={(item: Repo) => item.fullName}
                      label={(item: Repo) => item.fullName}
                      placeholder={language.t("github.pr.repoPlaceholder")}
                      onSelect={(item) => {
                        setRepo(item ?? undefined)
                        if (item) loadBranches(item)
                      }}
                    />
                  }
                >
                  <div class="text-13-regular text-text-weak">{language.t("github.pr.noRepos")}</div>
                </Show>
              </div>

              <div class="grid grid-cols-2 gap-3">
                <div class="flex flex-col gap-1.5">
                  <div class="text-13-medium text-text-base">{language.t("github.pr.base")}</div>
                  <Show
                    when={(branches()?.length ?? 0) > 0}
                    fallback={
                      <div class="text-13-regular text-text-weak">
                        {repo() ? (base() ?? language.t("github.pr.noRemote")) : language.t("github.pr.repoPlaceholder")}
                      </div>
                    }
                  >
                    <Select
                      options={branches() ?? []}
                      current={(branches() ?? []).find((item) => item.name === base())}
                      value={(item: Branch) => item.name}
                      label={(item: Branch) => item.name}
                      onSelect={(item) => setBase(item?.name)}
                    />
                  </Show>
                </div>

                <div class="flex flex-col gap-1.5">
                  <div class="text-13-medium text-text-base">{language.t("github.pr.head")}</div>
                  <div class="flex items-center gap-1.5 text-13-regular text-text-base">
                    <Icon name="branch" size="small" />
                    <span class="truncate">{head() || language.t("github.pr.noRemote")}</span>
                  </div>
                </div>
              </div>

              <TextField
                label={language.t("github.pr.titleLabel")}
                value={title()}
                onInput={(event) => setTitle(event.currentTarget.value)}
              />

              <TextField
                label={language.t("github.pr.body")}
                placeholder={language.t("github.pr.bodyPlaceholder")}
                value={body()}
                onInput={(event) => setBody(event.currentTarget.value)}
              />

              <Switch checked={draft()} onChange={setDraft} description={language.t("github.pr.draftDescription")}>
                {language.t("github.pr.draft")}
              </Switch>

              <div class="flex items-center justify-between gap-3 border-t border-border-weak-base pt-4">
                <div class="text-11-regular text-text-weak">{language.t("github.pr.pushHint")}</div>
                <Button type="submit" disabled={!ready()}>
                  {busy() ? language.t("github.pr.creating") : language.t("github.pr.create")}
                </Button>
              </div>
            </form>
          }
        >
          {(pr) => (
            <div class="flex flex-col items-start gap-4 py-2">
              <div class="flex items-center gap-2 text-13-medium text-text-base">
                <Icon name="circle-check" />
                <span>
                  {language.t("github.pr.created")}: #{pr().number}
                </span>
              </div>
              <div class="flex items-center gap-2">
                <Button onClick={() => platform.openLink(pr().html_url)}>
                  {language.t("github.pr.open")}
                </Button>
                <Button variant="secondary" onClick={() => dialog.close()}>
                  {language.t("common.cancel")}
                </Button>
              </div>
            </div>
          )}
        </Show>
      </Show>
    </Dialog>
  )
}
