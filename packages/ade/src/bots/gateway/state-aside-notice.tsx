import { Show } from "solid-js"
import { t } from "../../i18n"
import { appStateAside, type StateAside } from "./state-aside"
import { Button } from "../../ui/controls"

/**
 * Says once that the gateways' saved state could not be read and was put aside (N-A11a): the pairings must be done
 * again. Only where the copy is, never what it holds. Above the platforms, so it does not touch their tiles.
 */
export function StateAsideNotice(props: { aside?: StateAside }) {
  const aside = () => props.aside ?? appStateAside
  return (
    <Show when={aside().copies().length > 0}>
      <div data-slot="gateway-state-aside" role="status">
        <p data-slot="bots-problem">{t("gateway.panel.stateAside", aside().copies().join(", "))}</p>
        <div data-slot="gateway-row">
          <Button data-slot="bots-btn" onClick={() => aside().dismiss()}>
            {t("gateway.panel.stateAsideOk")}
          </Button>
        </div>
      </div>
    </Show>
  )
}
