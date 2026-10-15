/** Singletons need cancellation handles only while a request is in flight. */
export const releaseRequestWhenSettled = <K extends string>(
  owner: Record<K, { promise: Promise<unknown> } | null>,
  key: K,
): void => {
  const request = owner[key]
  if (!request) return
  const release = () => {
    // A newer overlapping request must retain its own cancellation handle.
    if (owner[key] === request) owner[key] = null
  }
  // Register both outcomes without replacing the public promise or creating
  // an unobserved rejecting promise from finally().
  void request.promise.then(release, release)
}
