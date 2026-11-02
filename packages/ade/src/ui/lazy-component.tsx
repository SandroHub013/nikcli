import { Match, Switch, createResource, createSignal, type JSX } from "solid-js"
import { t } from "../i18n"
import { retryingLoader } from "./lazy-load"

/**
 * A component loaded when it is first drawn, with an answer if the load fails.
 *
 * Drawn like `lazy()`: nothing in its place for the few ms the chunk takes. If the chunk cannot be had, the place says so and
 * offers «Riprova», which asks for it again (`retryingLoader`); Solid's own `lazy` would leave a blank tile and a rejection
 * nobody reads.
 */
export function lazyComponent<C extends (props: any) => JSX.Element>(load: () => Promise<{ default: C }>): C {
  const loader = retryingLoader(load)
  const Lazy = (props: Parameters<C>[0]): JSX.Element => {
    const [attempt, setAttempt] = createSignal(0)
    const [loaded] = createResource(attempt, () => loader())
    return (
      <Switch>
        <Match when={loaded.error}>
          <div data-slot="lazy-failed" role="alert">
            <p>{t("lazy.failed")}</p>
            <button type="button" data-slot="lazy-retry" onClick={() => setAttempt((count) => count + 1)}>
              {t("lazy.retry")}
            </button>
          </div>
        </Match>
        <Match when={loaded()}>
          {(module) => {
            const Inner: (props: Parameters<C>[0]) => JSX.Element = module().default
            return <Inner {...props} />
          }}
        </Match>
      </Switch>
    )
  }
  return Lazy as unknown as C
}
