import "@/index.css"
import { type ComponentProps, ErrorBoundary, Show, Suspense, lazy, type ParentProps } from "solid-js"
import { Router, Route, Navigate } from "@solidjs/router"
import { MetaProvider } from "@solidjs/meta"
import { Font } from "@nikcli-ai/ui/font"
import { MarkedProvider } from "@nikcli-ai/ui/context/marked"
import { DiffComponentProvider } from "@nikcli-ai/ui/context/diff"
import { CodeComponentProvider } from "@nikcli-ai/ui/context/code"
import { I18nProvider } from "@nikcli-ai/ui/context"
// Both pull in @pierre/diffs and the shiki engine. They are handed to providers
// at the root but only render once a diff or a code block appears, so they load
// with the first thing that needs them rather than with the app shell.
const DiffChunk = lazy(() => import("@nikcli-ai/ui/diff").then((module) => ({ default: module.Diff })))
const CodeChunk = lazy(() => import("@nikcli-ai/ui/code").then((module) => ({ default: module.Code })))

/**
 * Each gets its own boundary.
 *
 * These render inside the transcript, wherever a code block or a diff appears.
 * Without a boundary of their own the nearest one is the route's, so the first
 * code block in a session replaced the entire page with the loading spinner
 * while a chunk downloaded. The placeholder holds the space instead.
 */
const Diff = (props: ComponentProps<typeof DiffChunk>) => (
  <Suspense fallback={<div data-slot="lazy-chunk-placeholder" />}>
    <DiffChunk {...props} />
  </Suspense>
)

const Code = (props: ComponentProps<typeof CodeChunk>) => (
  <Suspense fallback={<div data-slot="lazy-chunk-placeholder" />}>
    <CodeChunk {...props} />
  </Suspense>
)
import { ThemeProvider } from "@nikcli-ai/ui/theme"
import { GlobalSyncProvider } from "@/context/global-sync"
import { PermissionProvider } from "@/context/permission"
import { LayoutProvider } from "@/context/layout"
import { GlobalSDKProvider } from "@/context/global-sdk"
import { AccountProvider } from "@/context/account"
import { normalizeServerUrl, ServerProvider, useServer } from "@/context/server"
import { SettingsProvider } from "@/context/settings"
import { TerminalProvider } from "@/context/terminal"
import { PromptProvider } from "@/context/prompt"
import { FileProvider } from "@/context/file"
import { CommentsProvider } from "@/context/comments"
import { NotificationProvider } from "@/context/notification"
import { ModelsProvider } from "@/context/models"
import { DialogProvider } from "@nikcli-ai/ui/context/dialog"
import { CommandProvider } from "@/context/command"
import { LanguageProvider, useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { HighlightsProvider } from "@/context/highlights"
import Layout from "@/pages/layout"
import DirectoryLayout from "@/pages/directory-layout"
import { ErrorPage } from "./pages/error"
import { JSX } from "solid-js"

const Home = lazy(() => import("@/pages/home"))
const Session = lazy(() => import("@/pages/session"))
const Loading = () => <div class="size-full" />

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.locale, t: language.t }}>{props.children}</I18nProvider>
}

declare global {
  interface Window {
    __NIKCLI__?: {
      updaterEnabled?: boolean
      serverPassword?: string
      deepLinks?: string[]
    }
  }
}

function MarkedProviderWithNativeParser(props: ParentProps) {
  const platform = usePlatform()
  return <MarkedProvider nativeParser={platform.parseMarkdown}>{props.children}</MarkedProvider>
}

export function AppBaseProviders(props: ParentProps) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider>
        <LanguageProvider>
          <UiI18nBridge>
            <ErrorBoundary fallback={(error) => <ErrorPage error={error} />}>
              <DialogProvider>
                <MarkedProviderWithNativeParser>
                  <DiffComponentProvider component={Diff}>
                    <CodeComponentProvider component={Code}>{props.children}</CodeComponentProvider>
                  </DiffComponentProvider>
                </MarkedProviderWithNativeParser>
              </DialogProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

function ServerKey(props: ParentProps) {
  const server = useServer()
  return (
    <Show when={server.connectionKey} keyed>
      {props.children}
    </Show>
  )
}

export function AppInterface(props: { defaultUrl?: string; children?: JSX.Element }) {
  const platform = usePlatform()

  const stored = (() => {
    if (platform.platform !== "web") return
    const result = platform.getDefaultServerUrl?.()
    if (result instanceof Promise) return
    if (!result) return
    return normalizeServerUrl(result)
  })()

  const defaultServerUrl = () => {
    if (props.defaultUrl) return props.defaultUrl
    if (stored) return stored
    if (location.hostname.includes("nikcli.ai")) return "http://localhost:4096"
    if (import.meta.env.DEV)
      return `http://${import.meta.env.VITE_NIKCLI_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_NIKCLI_SERVER_PORT ?? "4096"}`

    return window.location.origin
  }

  return (
    <ServerProvider defaultUrl={defaultServerUrl()}>
      <ServerKey>
        <AccountProvider>
          <GlobalSDKProvider>
            <GlobalSyncProvider>
              <Router
                root={(routerProps) => (
                  <SettingsProvider>
                    <PermissionProvider>
                      <LayoutProvider>
                        <NotificationProvider>
                          <ModelsProvider>
                            <CommandProvider>
                              <HighlightsProvider>
                                <Layout>
                                  {props.children}
                                  {routerProps.children}
                                </Layout>
                              </HighlightsProvider>
                            </CommandProvider>
                          </ModelsProvider>
                        </NotificationProvider>
                      </LayoutProvider>
                    </PermissionProvider>
                  </SettingsProvider>
                )}
              >
                <Route
                  path="/"
                  component={() => (
                    <Suspense fallback={<Loading />}>
                      <Home />
                    </Suspense>
                  )}
                />
                <Route path="/:dir" component={DirectoryLayout}>
                  <Route path="/" component={() => <Navigate href="session" />} />
                  <Route
                    path="/session/:id?"
                    component={(p) => (
                      <Show when={p.params.id ?? "new"}>
                        <TerminalProvider>
                          <FileProvider>
                            <PromptProvider>
                              <CommentsProvider>
                                <Suspense fallback={<Loading />}>
                                  <Session />
                                </Suspense>
                              </CommentsProvider>
                            </PromptProvider>
                          </FileProvider>
                        </TerminalProvider>
                      </Show>
                    )}
                  />
                </Route>
              </Router>
            </GlobalSyncProvider>
          </GlobalSDKProvider>
        </AccountProvider>
      </ServerKey>
    </ServerProvider>
  )
}
