/** An admin API answer: JSON, never cached, since every admin read is the operator's own view of live state. */
export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
