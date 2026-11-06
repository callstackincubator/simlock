# Alerts

Does: a gateway sends chosen fleet events to webhook destinations (ADR 0035).

## Rules

- The bus handler only puts the envelope on each listed destination's queue and returns. Building
  the request and every POST happen after it.
- A message is built once, when it leaves the queue, so it names the worker as the gateway knows
  it then. `workerLabel` falls back to the worker id.
- `stop()` aborts the try in flight, cancels timers and empties the queues; it waits for nothing.
- `test` runs beside the queues, one try, and resolves, never rejects. Its sample envelope
  (`alerts.test-sent`) is never on the bus. `stop()` aborts a test in flight, and a test after
  it posts nothing; neither writes a log line or counts in "Alerts discarded at stop".
  `../gateway/dispatcher.ts` maps its result to the contract's errors.
- Logs name the destination, never its URL or secret. A failed try is logged by code
  (`errorCode`), never by an error's message.
- The queue never names a format. A new format is a directory under `formats/`, an entry in
  `ALERT_FORMAT_REGISTRY` and one in core's `ALERT_FORMATS`.
- In `formats/slack/messages.ts` every variable part goes through `part()`, which cuts and
  escapes it: Slack reads `&`, `<` and `>` as markup, and `<!channel>` pings a channel.
- The Slack `worker.rejected` message names what the connection claimed, never the registry.

## Known gaps

- A worker's relayed payload is not checked (the gateway replaces a non-object with `{workerId}`): a Slack
  message built from a missing field prints `undefined`, and an age or size that is not a finite number
  prints `?`.
