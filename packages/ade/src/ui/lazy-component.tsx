import { Match, Switch, createResource, createSignal, type JSX } from "solid-js"
import { t } from "../i18n"
import { retryingLoader } from "./lazy-load"
import { Button } from "./controls"
import "./lazy-failed.css"

/**
 * A component loaded when it is first drawn, with an answer if the load fails.
 *
 * Drawn like `lazy()`: nothing in its place for the few ms the chunk takes. If the chunk cannot be had, the place says so and
 * offers «Riprova», which asks for it again (`retryingLoader`); Solid's own `lazy` would leave a blank tile and a rejection
 * nobody reads.
 *
 * A pane or a sheet has its «Chiudi» inside the module that did not arrive, so the box offers one of its own when the
 * component was given an `onClose`: without it a pane that never loads could not be closed, only waited for (prova 4, item 16).
 */
export function lazyComponent<C extends (props: any) => JSX.Element>(load: () => Promise<{ default: C }>): C {
  const loader = retryingLoader(load)
  const Lazy = (props: Parameters<C>[0]): JSX.Element => {
    const [attempt, setAttempt] = createSignal(0)
    const [loaded] = createResource(attempt, () => loader())
    return (
      <Switch>
        <Match when={loaded.error}>
          <div data-slot="lazy-failed" data-component="lazy-failed" role="alert">
            <h3 data-slot="lazy-failed-title">{t("lazy.failed")}</h3>
            <div data-slot="lazy-failed-actions">
              <Button
                variant="primary"
                size="md"
                data-slot="lazy-retry"
                onClick={() => setAttempt((count) => count + 1)}
              >
                {t("lazy.retry")}
              </Button>
              {typeof props.onClose === "function" ? (
                <Button variant="secondary" size="md" data-slot="lazy-close" onClick={() => props.onClose()}>
                  {t("pane.close")}
                </Button>
              ) : null}
            </div>
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
