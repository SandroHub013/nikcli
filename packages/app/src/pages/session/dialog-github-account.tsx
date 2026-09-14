import type { MobileBootstrap } from "@nikcli-ai/sdk/httpapi"
import { Button } from "@nikcli-ai/ui/button"
import { useDialog } from "@nikcli-ai/ui/context/dialog"
import { Dialog } from "@nikcli-ai/ui/dialog"
import { Icon } from "@nikcli-ai/ui/icon"
import { Mark } from "@nikcli-ai/ui/logo"
import { Spinner } from "@nikcli-ai/ui/spinner"
import { TextField } from "@nikcli-ai/ui/text-field"
import { showToast } from "@nikcli-ai/ui/toast"
import { Show, createSignal, onCleanup, onMount } from "solid-js"
import { Link } from "@/components/link"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { errorMessage, requestData } from "@/pages/session/git-request"

/**
 * Connecting the GitHub identity this host pushes with. Lifted out of the git
 * toolbar so the pull request dialog can offer "connect" without importing the
 * toolbar back and forming a cycle.
 */
export function DialogGitHubAccount(props: { onChanged: () => void }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const platform = usePlatform()
  const language = useLanguage()
  const [bootstrap, setBootstrap] = createSignal<MobileBootstrap>()
  const [token, setToken] = createSignal("")
  const [clientID, setClientID] = createSignal("")
  const [flow, setFlow] = createSignal<{
    deviceCode: string
    userCode: string
    verificationUri: string
    // GitHub returns a second URL with the user code already in it. Opening that one
    // turns the flow into a single click; the bare URL makes the user type the code.
    verificationUriComplete?: string
    expiresAt: number
    interval: number
  }>()
  const [busy, setBusy] = createSignal("")
  // Denied/expired also go inline: by the time the user looks back at the
  // dialog the toast is usually gone, and an idle dialog reads as broken.
  const [flowError, setFlowError] = createSignal<"denied" | "expired" | "misconfigured">()
  let pollTimer: number | undefined

  const refresh = async () => {
    setBootstrap(await requestData(sdk.client.mobile.bootstrap({ directory: sdk.directory })))
    props.onChanged()
  }

  const run = async (key: string, action: () => Promise<void>) => {
    if (busy()) return
    setBusy(key)
    try {
      await action()
    } catch (error) {
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: errorMessage(error) })
    } finally {
      setBusy("")
    }
  }

  const stopPolling = () => {
    if (pollTimer !== undefined) window.clearInterval(pollTimer)
    pollTimer = undefined
  }

  const schedulePolling = (seconds: number) => {
    stopPolling()
    pollTimer = window.setInterval(() => void poll(), Math.max(seconds, 5) * 1000)
  }

  const poll = async () => {
    const current = flow()
    if (!current) return

    // GitHub stops accepting the device code once it expires, so past that point
    // every further request is answered with the same error forever.
    if (Date.now() >= current.expiresAt) {
      stopPolling()
      setFlow()
      setFlowError("expired")
      showToast({ variant: "error", title: language.t("github.device.expired") })
      return
    }

    const result = await requestData(
      sdk.client.mobile.github.oauth.device.poll({
        directory: sdk.directory,
        deviceCode: current.deviceCode,
      }),
    ).catch((error) => {
      // A network blip is not a verdict — keep waiting for the user.
      console.error(error)
      return undefined
    })
    if (!result) return

    if (result.status === "pending") {
      // The server folds `slow_down` into `pending` with a longer interval;
      // ignoring it keeps hitting the rate limit and never completes.
      const next = result.interval ?? current.interval
      if (next !== current.interval) {
        setFlow({ ...current, interval: next })
        schedulePolling(next)
      }
      return
    }

    // Denied and expired are final: the code will never be approved, so polling
    // on would run until the dialog closes, with the user shown nothing.
    stopPolling()
    setFlow()
    if (result.status !== "approved") {
      // `misconfigured` is the OAuth app itself being wrong, not the user refusing
      // or running out of time — it needs a different instruction, not "try again".
      const reason =
        result.status === "denied" ? "denied" : result.status === "misconfigured" ? "misconfigured" : "expired"
      setFlowError(reason)
      showToast({ variant: "error", title: language.t(`github.device.${reason}`) })
      return
    }

    await refresh()
    showToast({ variant: "success", icon: "circle-check", title: language.t("github.toast.connected") })
  }

  const startDeviceFlow = () =>
    run("oauth", async () => {
      // A fresh attempt supersedes the verdict of the previous one.
      setFlowError()
      const result = await requestData(sdk.client.mobile.github.oauth.device.start({ directory: sdk.directory }))
      setFlow({
        deviceCode: result.deviceCode,
        userCode: result.userCode,
        verificationUri: result.verificationUri,
        verificationUriComplete: result.verificationUriComplete,
        expiresAt: result.expiresAt,
        interval: result.interval,
      })
      platform.openLink(result.verificationUriComplete || result.verificationUri)
      schedulePolling(result.interval)
    })

  const saveClientID = () =>
    run("client", async () => {
      await requestData(
        sdk.client.mobile.github.oauth.clientId.set({ directory: sdk.directory, clientId: clientID().trim() }),
      )
      await refresh()
      showToast({ variant: "success", icon: "circle-check", title: language.t("github.toast.clientSaved") })
    })

  const saveToken = () =>
    run("token", async () => {
      await requestData(sdk.client.mobile.github.auth.set({ directory: sdk.directory, token: token().trim() }))
      setToken("")
      await refresh()
      showToast({ variant: "success", icon: "circle-check", title: language.t("github.toast.connected") })
    })

  const disconnect = () =>
    run("disconnect", async () => {
      await requestData(sdk.client.mobile.github.auth.remove({ directory: sdk.directory }))
      await refresh()
      showToast({ variant: "success", title: language.t("github.toast.disconnected") })
    })

  onMount(() => void refresh().catch((error) => showToast({ variant: "error", description: errorMessage(error) })))
  // The dialog can be dismissed while the browser tab is still open.
  onCleanup(stopPolling)

  return (
    <Dialog
      size="large"
      title={language.t("github.account.title")}
      description={language.t("github.account.description")}
    >
      <div class="flex max-h-[72vh] min-h-0 w-full flex-col gap-5 overflow-y-auto">
        <div class="flex items-center gap-3 rounded-md border border-border-base bg-surface-raised-base p-3">
          <div class="flex items-center gap-2">
            <div class="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-base">
              <Mark class="size-5" />
            </div>
            <div class="text-text-weak">→</div>
            <div class="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-base">
              <Icon name="github" size="medium" />
            </div>
          </div>
          <div class="min-w-0 flex-1">
            <div class="text-13-medium text-text-base">
              {bootstrap()?.github.connected
                ? `@${bootstrap()?.github.user?.login ?? "github"}`
                : language.t("github.account.notConnected")}
            </div>
            <div class="mt-0.5 text-11-regular text-text-weak">
              {bootstrap()?.github.connected
                ? bootstrap()?.github.user?.name || language.t("github.account.connected")
                : language.t("github.account.connectHint")}
            </div>
          </div>
          <Show when={bootstrap()?.github.connected}>
            <Button variant="ghost" size="small" disabled={!!busy()} onClick={disconnect}>
              {language.t("github.account.disconnect")}
            </Button>
          </Show>
        </div>

        <div class="flex flex-col gap-3 rounded-md border border-border-base p-3">
          <div>
            <div class="text-13-medium text-text-base">{language.t("github.oauth.title")}</div>
            <div class="mt-1 text-11-regular text-text-weak">{language.t("github.oauth.description")}</div>
          </div>
          <Show
            when={flow()}
            fallback={
              <Show
                when={bootstrap()?.github.oauthDeviceConfigured}
                fallback={
                  // The client ID is a one-time prerequisite of this flow, so its
                  // setup lives here in place of the connect button — a disabled
                  // button with no explanation reads as "token only".
                  <div class="flex flex-col gap-3">
                    <div class="text-11-regular text-text-weak">
                      {language.t("github.oauth.clientDescription")}{" "}
                      <Link href="https://github.com/settings/applications/new">
                        {language.t("github.oauth.createClient")}
                      </Link>
                    </div>
                    <div class="flex items-end gap-2">
                      <TextField
                        class="flex-1"
                        label={language.t("github.oauth.clientId")}
                        value={clientID()}
                        onChange={setClientID}
                        spellcheck={false}
                      />
                      <Button
                        variant="secondary"
                        size="large"
                        disabled={!clientID().trim() || !!busy()}
                        onClick={saveClientID}
                      >
                        {language.t("common.save")}
                      </Button>
                    </div>
                  </div>
                }
              >
                <Button variant="primary" size="large" disabled={!!busy()} onClick={startDeviceFlow}>
                  {language.t("github.oauth.connect")}
                </Button>
              </Show>
            }
          >
            {(current) => (
              <div class="flex flex-col gap-3">
                {/* Polling resolves silently, so without this row a pending flow
                    looks idle and reads as broken. */}
                <div class="flex items-center gap-x-2 text-13-regular text-text-weak">
                  <Spinner />
                  <span>{language.t("github.oauth.waiting")}</span>
                </div>
                <div class="rounded-md bg-surface-base px-4 py-3 text-center">
                  <div class="text-11-regular text-text-weak">{language.t("github.oauth.code")}</div>
                  <div class="mt-1 font-mono text-20-medium tracking-[0.2em] text-text-strong">
                    {current().userCode}
                  </div>
                  {/* verificationUriComplete already carries the code, so typing
                      it is the exception — say so or it looks mandatory. */}
                  <div class="mt-1 text-11-regular text-text-weak">{language.t("github.oauth.codeHint")}</div>
                </div>
                <div class="flex gap-2">
                  <Button
                    class="flex-1"
                    variant="secondary"
                    size="large"
                    onClick={() => platform.openLink(current().verificationUriComplete || current().verificationUri)}
                  >
                    {language.t("github.oauth.open")}
                  </Button>
                  <Button
                    class="flex-1"
                    variant="primary"
                    size="large"
                    disabled={!!busy()}
                    onClick={() => run("poll", async () => void (await poll()))}
                  >
                    {language.t("github.oauth.check")}
                  </Button>
                </div>
              </div>
            )}
          </Show>
          <Show when={flowError()}>
            {(status) => (
              <div class="flex items-center gap-x-2 text-13-regular text-text-base">
                <Icon name="circle-ban-sign" class="text-icon-critical-base" />
                <span>{language.t(`github.device.${status()}`)}</span>
              </div>
            )}
          </Show>
        </div>

        <div class="flex flex-col gap-3 rounded-md border border-border-base p-3">
          <div>
            <div class="text-13-medium text-text-base">{language.t("github.token.title")}</div>
            <div class="mt-1 text-11-regular text-text-weak">{language.t("github.token.description")}</div>
          </div>
          <TextField
            type="password"
            label={language.t("github.token.label")}
            value={token()}
            onChange={setToken}
            spellcheck={false}
          />
          <Button variant="secondary" size="large" disabled={!token().trim() || !!busy()} onClick={saveToken}>
            {language.t("github.token.save")}
          </Button>
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
