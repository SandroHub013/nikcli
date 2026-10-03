/**
 * The terminal's graphics protocols, as a plugin surface.
 *
 * A Kitty *virtual placement* is the only way to show an image inside a grid
 * TUI: the image is transmitted once without drawing anything, and the terminal
 * composites it over ordinary text cells made of U+10EEEE plus the row/column
 * diacritics that address each cell's slice. Cursor-addressed protocols (Sixel,
 * iTerm2) paint after the frame at a cursor position, so they cannot live in a
 * grid that repaints underneath them.
 *
 * All of that is the host's business rather than a plugin's: the terminal's
 * capabilities were negotiated at startup, the id space of the terminal's image
 * table is shared with the host's own inline previews, and the diacritic table
 * is 297 entries a plugin would have to embed and could not check. So the host
 * transmits and hands back the cells; a plugin decides what to show and where
 * (the `backdrop` slot is the only place it can be behind the interface).
 */
import { RGBA } from "@opentui/core";
import type {
  TuiGraphicsApi,
  TuiKittyPlacement,
  TuiPluginApi,
} from "@nikcli-ai/plugin/tui";
import {
  applyLiveCapabilities,
  deleteKittyVirtual,
  detectCapabilities,
  encodeKittyVirtualFile,
  encodeKittyVirtualPng,
  kittyIdColor,
  kittyPlaceholderGrid,
  supportsKittyUnicodePlaceholders,
  type LiveCapabilities,
} from "@nikcli-ai/tui-image";
import { Log } from "@nikcli-ai/util/log";

const log = Log.create({ service: "tui.plugin.graphics" });

/**
 * Ids for plugin-placed images, disjoint from the host's own previews.
 *
 * The inline preview allocator in `component/tui-image.tsx` hands out
 * `1..0xffff` under a per-process base. Plugins take the top of the 24-bit id
 * space instead, so a plugin placement can never overwrite a preview that is
 * still on screen, and the two allocators cannot race into the same id.
 */
const PLUGIN_ID_BASE = 0xfff000;
const PLUGIN_ID_MAX = 0xffffff;
let pluginId = PLUGIN_ID_BASE;

function nextPluginId() {
  // Wraps rather than throwing: 1.6M placements from one plugin is a bug in the
  // caller, and a reused id is still correct as long as the previous image was
  // deleted first — which `dispose` is for.
  if (pluginId >= PLUGIN_ID_MAX) pluginId = PLUGIN_ID_BASE;
  return ++pluginId;
}

/**
 * Write a drawless Kitty transmission straight to the terminal.
 *
 * Safe from inside the TUI: `U=1` means the sequence places nothing at the
 * cursor and `q=2` suppresses the terminal's reply, so it cannot be interleaved
 * into a frame. This is the same writer the inline image preview uses.
 */
function write(bytes: string) {
  if (typeof process === "undefined" || !process.stdout) return;
  try {
    process.stdout.write(bytes);
  } catch (error) {
    log.warn("failed to write kitty graphics sequence", { error });
  }
}

export function createGraphicsApi(
  api: Pick<TuiPluginApi, "renderer">,
): TuiGraphicsApi {
  const live = (api.renderer.capabilities ?? null) as LiveCapabilities | null;
  // Negotiation is authoritative where it answered; env is the rest, because a
  // multiplexer's VT can swallow the query. Same merge the inline preview uses.
  const capabilities = applyLiveCapabilities(detectCapabilities(), live);

  return {
    get kittyPlaceholders() {
      return supportsKittyUnicodePlaceholders(capabilities);
    },
    placeKittyImage(input) {
      const columns = Math.max(1, Math.floor(input.columns));
      const rows = Math.max(1, Math.floor(input.rows));
      const id = nextPluginId();
      const options = { id, columns, rows };
      const sequence =
        input.path !== undefined
          ? encodeKittyVirtualFile(input.path, options)
          : encodeKittyVirtualPng(input.bytes!, options);
      write(sequence);

      const color = kittyIdColor(id);
      let released = false;
      return {
        id,
        columns,
        rows,
        lines: kittyPlaceholderGrid(columns, rows),
        // A real RGBA, not a plain object: the id is only read back off the
        // cell's foreground when the renderer packs the same four channels the
        // terminal reads, and that packing lives on the RGBA class.
        fg: RGBA.fromInts(color.r, color.g, color.b, 255),
        dispose() {
          if (released) return;
          released = true;
          // Without this the image stays in the terminal's table for the rest
          // of the session: every hot reload of the plugin would leak one, and
          // a leaked id is reused by the next placement.
          write(deleteKittyVirtual(id));
        },
      } satisfies TuiKittyPlacement;
    },
  };
}
