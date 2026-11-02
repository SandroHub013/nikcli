/**
 * An `import()` that can be asked again after it failed.
 *
 * Solid's `lazy` keeps the promise it was given, rejected or not, for the life of the page: a chunk that did not arrive
 * (a dev server restarting, a disk hiccup) left the pane blank until the window was reloaded, and a reload ends the
 * sessions. This keeps a result only when it succeeded, so the next `load()` is a new `import()`.
 */
export function retryingLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let done: Promise<T> | undefined
  let flying: Promise<T> | undefined
  return () => {
    if (done) return done
    flying ??= load().then(
      (value) => {
        done = Promise.resolve(value)
        flying = undefined
        return value
      },
      (error) => {
        flying = undefined
        throw error
      },
    )
    return flying
  }
}
