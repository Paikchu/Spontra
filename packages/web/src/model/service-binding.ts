/**
 * Two Workers that share a `workers.dev` subdomain cannot reach each other over their public
 * hostnames: the edge answers the subrequest with a 404 before it ever arrives at the target. Both
 * Workers keep looking healthy from outside, which is exactly how the scheduled SEC refresh sat
 * dead for five days — every Cron run got `SEC watchlist HTTP 404` from a route that answers 401 to
 * the open internet, and the Web Worker's own logs never recorded the request at all.
 *
 * A Service Binding routes the call between the two Workers directly. The binding ignores the
 * hostname, so callers keep building the same absolute URL and only the path is honoured.
 */
export type ServiceBinding = { fetch: typeof fetch };

/** The binding when the Worker was deployed with one, otherwise the caller's own fetcher. */
export function serviceFetcher(binding: ServiceBinding | undefined, fallback: typeof fetch = fetch): typeof fetch {
  return binding ? binding.fetch.bind(binding) : fallback;
}

/** Env values arrive untyped; a binding is only usable once it actually carries a fetch. */
export function asServiceBinding(value: unknown): ServiceBinding | undefined {
  return value && typeof (value as ServiceBinding).fetch === "function" ? value as ServiceBinding : undefined;
}
