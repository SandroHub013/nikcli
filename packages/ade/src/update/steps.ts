/**
 * An update, in the order the page needs it.
 *
 * The install ends this process, so what the page holds has to be on disk first, and the mail has to stop first or a
 * message taken after the save is lost. Stopping it for the whole update was too much: a download can take minutes
 * (60 s for the check, 180 s to the first byte, 60 s per stall), and `ade-msg kv` gives up at 10 s. So the download is
 * a step of its own, and everything that stops the work comes after it. The same goes for a recording, which can take
 * up to a minute to finish: the mail stops after it, as late as it can, and only the save has to follow.
 *
 * The plugin's event at the end of the download could not do this. It cannot wait for the page, and the setup starts
 * right after it, so the save would race the end of the process.
 */
export async function updateInSteps(steps: {
  download: () => Promise<unknown>
  /** A recording still going or finishing: the process ending would lose the video. */
  settle: () => Promise<unknown>
  stopMail: () => void
  save: () => void
  /** localStorage reaches WebView2's disk store a moment after setItem. */
  waitForDisk: () => Promise<unknown>
  install: () => Promise<unknown>
}): Promise<void> {
  await steps.download()
  await steps.settle()
  steps.stopMail()
  steps.save()
  await steps.waitForDisk()
  await steps.install()
}
