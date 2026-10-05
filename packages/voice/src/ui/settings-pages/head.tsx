import { Show, type JSX } from "solid-js"

/**
 * A page's title and the sentence under it.
 *
 * `bare` is ADE's settings, where the category header and the tab bar already
 * name the page: a third heading in the body would be one more name for the
 * same screen. The title is still there, `hidden`, because the page's radio
 * groups are labelled by its id.
 */
export function PageHead(props: { id: string; title: string; desc: string; bare?: boolean }): JSX.Element {
  return (
    <div data-slot="section-head">
      <Show
        when={!props.bare}
        fallback={
          <h3 id={props.id} hidden>
            {props.title}
          </h3>
        }
      >
        <h3 id={props.id} data-slot="section-title" tabIndex={-1}>
          {props.title}
        </h3>
      </Show>
      <p data-slot="section-desc">{props.desc}</p>
    </div>
  )
}
