# Alerts

Does: a gateway sends chosen fleet events to webhook destinations (ADR 0035).
Entry: `index.ts` (`createAlerts`). Built only by `../daemon/main.ts`, in the gateway branch, when
`gateway.alerts.destinations` is not empty; a worker never builds it.
Uses: bus (subscribe, types), ports (`Clock`, `Logger`, `WebhookPoster`), core (config types and
`ALERT_EVENTS`). Never imports anything else; `.dependency-cruiser.mjs` checks both directions.
Imported by: `../daemon/main.ts` only.

## Files

| File               | Role                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `index.ts`         | `createAlerts`: one subscription per listed event, `stop()`                                                |
| `queue.ts`         | `DestinationQueue`: one message at a time, tries, timeout, bounded wait                                    |
| `formats/types.ts` | `AlertFormatDefinition`: `build` turns an envelope into headers and body                                   |
| `formats/index.ts` | `ALERT_FORMAT_REGISTRY`, typed over core's `ALERT_FORMATS`                                                 |
| `formats/generic/` | The envelope as JSON, signed with HMAC-SHA256                                                              |
| `formats/slack/`   | `{text}` from a message table (`formats/slack/messages.ts`), `formats/slack/units.ts` cuts, escapes, sizes |

## How it works

1. The bus handler puts the envelope on the queue of every destination that lists the event and returns.
2. A queue takes the oldest waiting message, builds its request once, then POSTs it: 10 s at most
   per try, 3 tries, 1 s then 5 s between them. Network errors, timeouts, `429` and `5xx` are retried;
   any other non-2xx status gives up at once. A queue holds 100 waiting messages and drops the oldest.
3. `stop()` aborts the try in flight, cancels timers and empties the queues; it waits for nothing.

Logs name the destination, never its URL or secret; a failed try is logged by code, never by an
error's message. A format is added by a directory under `formats/`, an entry in the registry and in
core's `ALERT_FORMATS`; the queue never names a format.

## Slack messages

`formats/slack/messages.ts` is a `Record<AlertEventName, …>`: an event added to `ALERT_EVENTS` does not
compile until it has a message. Every variable part goes through `part()` (cut to 300 code points, then
`&`, `<`, `>` escaped), and `worker.rejected` names what the connection claimed, never the registry.
`createAlerts` takes `workerLabel(workerId)` (the gateway's view of the worker, from `../daemon/main.ts`)
and falls back to the id; the message is built when it leaves the queue, so it names the worker as known
then.

## Known gaps

- A worker's relayed payload is not checked (the gateway replaces a non-object with `{workerId}`): a Slack
  message built from a missing field prints `undefined`, and an age or size that is not a finite number
  prints `?`.
