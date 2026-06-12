# Listener Pipeline Convergence

This note is the low-risk boundary for converging the current listener toward a
bounded state-machine pipeline.  It is intentionally not a hot migration plan.

## Current Role

The listener should be treated as an event collector only:

- Receive Telegram updates and write raw events.
- Do small parent-message lookups only when a reply needs context.
- Keep history backfill manual or tightly bounded.
- Never become the owner of gameplay decisions or schedule sending.

Official schedules, direct sends, and Tianjige reads may reuse an active
listener client, but they must also work through short-lived logged-in account
clients when collection is not running.

## Target Shape

The target pipeline is:

1. Listener thread receives updates and pushes raw event envelopes into a bounded
   in-process queue.
2. Raw writer upserts `(account_local_id, chat_id, msg_id)` first, with
   lightweight dedupe before parser work.
3. Parser workers consume raw rows in batches and update parsed cards,
   state-machine records, resource stats, and inventory deltas.
4. State machines expose schedule anchors and `payload_defaults`; schedule UI
   consumes those contracts instead of duplicating gameplay timing rules.
5. Reconciliation jobs such as official scheduled-history sync stay explicit
   user actions. They repair local drift; they do not create new automation.

## Guardrails

- Queue depth must be bounded and visible in health output before enabling any
  broader auto backfill.
- A parser failure must not block raw ingest; failed rows should be retryable.
- The listener should not scan old history automatically on every startup.
- Tianjige stays manual or low-frequency UI triggered; it is a supplement, not
  the runtime source of truth.
- Schedule creation is login-bound, not collection-bound. Error text should say
  "need login" when that is the real requirement.

## Next Slice

The next safe implementation slice is metrics first: queue depth, parser lag,
raw upsert rate, parser error count, and last processed msg_id per account.  Do
that before replacing direct parse-on-ingest paths, so CPU regressions are
attributable instead of guessed from symptoms.
