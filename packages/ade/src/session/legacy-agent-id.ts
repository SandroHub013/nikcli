/**
 * Ragu Code was nikcli, and ADE saved its id as `nikcli` (panes, chat sessions, a bot's `runner:`, the
 * reports of the TUI plugin installed before the rename). Every place that reads one back asks here.
 */
export function currentAgentId(id: string): string {
  return id === "nikcli" ? "ragu" : id
}
