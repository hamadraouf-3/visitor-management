# Visitor tracking: the provider integration contract

Phase 15 ([`decisions/phase-15-backend.md`](decisions/phase-15-backend.md),
[`visitor-journey-design.md`](visitor-journey-design.md)). Date: 2026-10-20.

This is what an external tracking provider (a multi-camera person re-identification system) must do to
feed floor and zone observations of enrolled visitors into Mawdoo3 Visitors, and what the application
does in return. It is provider-neutral: it names no model and assumes no capability.

> **Status: no real provider is connected, and none can be today.** Gate 0
> ([`visitor-tracking-model-assessment.md`](visitor-tracking-model-assessment.md)) found no tracking model,
> code, interface or documentation; the real adapter (Gate 3) and its validation on site footage (Gate 5)
> are **BLOCKED BY ENVIRONMENT**. The only implementations are `disabled` (the default everywhere, and
> production's value) and a development-only `simulator`, whose output is always marked Simulated. Nothing
> in this document claims that live tracking works.

---

## 1. The two directions

| Direction | What | How |
|---|---|---|
| Application → provider | **Enroll**: "the person at camera *C* now is association *A*" | `TrackingProvider.enroll(company_id, ref, provider_camera_id, at)` — a **binding request**, never an image |
| Application → provider | **Revoke**: stop tracking *A* and forget it | `TrackingProvider.revoke(company_id, ref)`, best effort |
| Application → provider | **Health** | `TrackingProvider.health()` → reachable or not |
| Provider → application | Events: enrolled, enrollment failed, observed, lost, heartbeat | `POST /api/v1/tracking/events` with a Bearer key (§2–§5) |

The application calls the provider **after** its own change has committed, so no database lock is held
while the provider answers. A failed call is counted in the company's health record and never undoes the
change: an association the application has ended stays ended, and its later events are rejected.

**What crosses the boundary, and what never does.** The application sends the provider a random reference
(`ref`), the provider's own camera ID, an instant and the company's ID (so the provider knows which
company's key to post the association's events with). The provider sends back references, its camera IDs,
instants, a match judgement and, if it has one, a confidence. **No image, crop, embedding, template, face,
name, e-mail, phone number, visit ID or visitor ID ever crosses it**, in either direction. The provider
does any capture on its side, at the enrollment camera, under its own policy. If a future model needs an
image upload from the application, that is a separate design and privacy review, not this contract.

**The ref.** `trk_` followed by 32 base32 characters (`a`–`z`, `2`–`7`): 160 random bits. It is not
derived from the visit, the visitor, an e-mail, a phone number, a name or a pass, and it is never
answered by the application's own API, logged or audited. One ref names one association of one visit;
a visit re-enrolled later gets a new ref, and the old one stays dead.

---

## 2. Authentication

```
POST /api/v1/tracking/events
Authorization: Bearer vtk_<43 characters>
Content-Type: application/json
```

- A **tracking key** belongs to one company. A company administrator creates it in the application
  (Settings → Tracking → Keys); it is shown **once**, at its creation, and stored only as its SHA-256
  digest. At most two unrevoked keys per company exist at a time, so a key can be rotated without a gap:
  create the second, switch the provider to it, revoke the first.
- **Only the `Authorization` header** authenticates. A session cookie is neither required nor accepted;
  the endpoint needs no CSRF token. The scheme is exactly `Bearer`, followed by one space and the key.
- **401 `NOT_AUTHENTICATED`** (the standard error envelope) for a wrong, revoked or absent key, or a key of
  a deactivated company. Nothing of the body is read before the key is accepted.
- **404 `NOT_FOUND`** while the deployment's provider is `disabled` (`TRACKING_PROVIDER`): the route behaves
  as absent, whatever the key and **whatever the method** (with a provider, any method but `POST` answers
  405).
- The **company** of every event is the key's. Nothing the provider sends names a company or a visit.

## 3. Limits

| Limit | Value | Beyond it |
|---|---|---|
| Body size | 64 KiB (`MAX_REQUEST_BODY_BYTES`; nginx has the same) | 413 `PAYLOAD_TOO_LARGE` |
| Events per request | 1 to 100 | 422 `VALIDATION_ERROR` (`events`) |
| Requests per key | 120 a minute (`RATE_LIMIT_TRACKING_REQUESTS_PER_MINUTE`) | 429 `RATE_LIMITED` with `Retry-After` |
| Requests with a wrong key, per client address | 30 per 5 minutes (`RATE_LIMIT_TRACKING_KEY_FAILURES_PER_IP`); only wrong, revoked or absent keys count, so any number of valid requests in flight at once never use it up | 429 before any lookup |
| `Content-Type` | `application/json` | 415 `UNSUPPORTED_MEDIA_TYPE` |

The API process that counts these runs once per deployment (nginx sends it every write), so the budgets are
exact.

## 4. The request

```json
{
  "events": [
    {
      "provider_event_id": "cam3f-000184",
      "type": "OBSERVED",
      "association_ref": "trk_k7q3xw2m5d4vbn6rht2sz3ycl4fpe7ga",
      "camera_id": "cam-3f-corridor-east",
      "observed_at": "2026-10-20T10:15:04+03:00",
      "match": "CONFIRMED",
      "confidence": 0.91,
      "model_version": "example-1.0"
    }
  ]
}
```

(All values above are synthetic examples.)

| Field | Type | Rules |
|---|---|---|
| `provider_event_id` | string | Required. 1–128 visible ASCII characters (`!` to `~`, no space). Unique per company and provider: a repeat is a `duplicate`. |
| `type` | string | Required. `ENROLLED`, `ENROLLMENT_FAILED`, `OBSERVED`, `LOST` or `HEARTBEAT`. |
| `association_ref` | string | Required for every type but `HEARTBEAT`, refused (422) for `HEARTBEAT`. At most 64 visible ASCII characters; anything that is not a live ref of the key's company is answered per event (`UNKNOWN_ASSOCIATION`), not as a malformed body. |
| `camera_id` | string | The provider's camera ID. Required for `ENROLLED` and `OBSERVED`; optional for `LOST` and `ENROLLMENT_FAILED`. 1–128 visible ASCII characters. |
| `observed_at` | string | Required. RFC 3339 **with its offset** (`Z` or `±hh:mm`); a value without one is 422. |
| `match` | string | `CONFIRMED` or `UNCERTAIN`: the provider's own judgement. Required for `OBSERVED`, refused (422) for every other type. |
| `confidence` | number | Optional, 0 to 1. Send it only if the model produces one; the application never invents one. |
| `model_version` | string | Optional, 1–64 visible ASCII characters. Shown in the timeline. |

**Unknown fields are refused** (422 `not_allowed`), at the top level and in every event: there is no
free-form payload, and no place for an image, a crop, an embedding, a track or a diagnostic blob.

A body that is not JSON, not an object of this shape, or breaks one of these rules answers **422
`VALIDATION_ERROR`** for the whole batch, with the path of every problem in `details.fields` and
`details.field_codes` (`events.3.camera_id`, …). Nothing of such a batch is applied.

## 5. The answer

A well-formed batch always answers **200**, with one outcome per event, **in the batch's order**. The
application applies a batch's `ENROLLED` and `ENROLLMENT_FAILED` events **before** its other events (the
others keep their order), so the first sightings may travel in the batch that confirms the enrollment:

```json
{
  "results": [
    { "provider_event_id": "cam3f-000184", "result": "accepted",  "reason": null },
    { "provider_event_id": "cam3f-000185", "result": "duplicate", "reason": null },
    { "provider_event_id": "cam1f-000201", "result": "rejected",  "reason": "UNKNOWN_CAMERA" }
  ]
}
```

| `result` | Meaning |
|---|---|
| `accepted` | Applied (and, for `ENROLLED`, `OBSERVED` and `LOST`, stored). |
| `duplicate` | This company already holds this `provider_event_id` from this provider: nothing new is stored. Retrying a whole batch after a timeout is safe. An `ENROLLMENT_FAILED` repeated for an association it already ended is a duplicate too. |
| `rejected` | Not applied and **not stored**; `reason` says why. Retrying it unchanged gets the same answer. |

### 5.1 Reason codes

Checked in this order; the first that applies is the answer.

| `reason` | When | What the provider should do |
|---|---|---|
| `TRACKING_OFF` | The company has tracking not allowed (platform owner) or not enabled (company administrator). | Stop sending for this company; heartbeats are still accepted. |
| `IN_FUTURE` | `observed_at` is more than 2 minutes after the application's clock. | Fix the clock (NTP). |
| `TOO_OLD` | `observed_at` is before the company's retention window (`retention_days`, 1–90, default 30). | Drop it. |
| `UNKNOWN_ASSOCIATION` | No association of the key's company has this ref (a typo, another company's ref, a pruned one). | Drop it; stop tracking the ref. |
| `ASSOCIATION_ENDED` | The association ended (check-out, revoke, expiry, failed enrollment) before `observed_at`, or the event is an `ENROLLED`/`ENROLLMENT_FAILED` for an ended one, or a sighting of an association that ended **without ever being active** (its enrollment failed, or it was never confirmed in time), whenever it was observed. | Stop tracking the ref. |
| `NOT_ACTIVE` | An `OBSERVED` or `LOST` for an association that is still PENDING: nobody is bound to it yet. | Send `ENROLLED` first (in the same batch or an earlier one), then the sightings. |
| `BEFORE_ASSOCIATION` | `observed_at` is more than 2 minutes before the association was created. | Drop it: older footage is never attributed to a visit. |
| `UNKNOWN_CAMERA` | `camera_id` is not a registered, active camera of the company (or its zone is archived). An unknown camera never yields a floor. | Ask the company's administrator to register the camera. |
| `ALREADY_ENROLLED` | `ENROLLED` or `ENROLLMENT_FAILED` for an association that is already ACTIVE. | Nothing: the first one counted. |
| `CAMERA_MISMATCH` | `ENROLLED` names another camera than the one the enrollment request named. | Enroll at the requested camera, or answer `ENROLLMENT_FAILED`. |

Rejected events are **counted, never stored**: per company, per reason, over the last 24 hours, visible to
the company's administrator (`GET /api/v1/tracking/settings` → `health`). Rows about people who are not
enrolled visitors would be surveillance data; so would sightings of an association the provider never
confirmed, which is why they are rejected too (`NOT_ACTIVE`, `ASSOCIATION_ENDED`).

### 5.2 What each accepted type does

| `type` | Effect |
|---|---|
| `ENROLLED` | The association goes from PENDING to ACTIVE (once; audited `TRACKING_ASSOCIATION_ACTIVATED`). Stored, with the enrollment camera's location. |
| `ENROLLMENT_FAILED` | The association ends (reason `ENROLLMENT_FAILED`); reception may enroll again, which makes a new association with a new ref. Not stored as an event. |
| `OBSERVED` | Stored, with the building, floor and zone of the camera **as registered when the event arrived** (moving the camera later never rewrites history). |
| `LOST` | Stored (with a location if a known camera is given). The journey shows STALE until the next observation. |
| `HEARTBEAT` | Nothing is stored. Every request with a valid key, a heartbeat-only one included, records the provider's **last contact**. |

**Late events.** An `OBSERVED` or `LOST` observed *before* its association ended may arrive after the end:
if the association **was active** (its `ENROLLED` was accepted) and did not end by `ENROLLMENT_FAILED`, it is
appended to the visit's history and changes nothing. One observed after the end, or of an association that
never was active, is rejected (`ASSOCIATION_ENDED`).

**Ordering.** The application orders a visit's events by `observed_at`, never by arrival: an older event
that arrives late never replaces a newer floor. Batches may arrive in any order.

**Contact.** A journey whose association is ACTIVE turns **UNAVAILABLE** when the provider has not
contacted the application for 5 minutes. Send a `HEARTBEAT` at least every minute while any association
of the company is active, even when nothing is observed.

---

## 6. How the application reads the events

These rules are the application's, not the provider's; they are listed so the provider knows what its
fields mean on the screen ([`visitor-journey-design.md`](visitor-journey-design.md) §4).

- An observation counts as **confirmed** only when `match` is `CONFIRMED` **and** `confidence` is at least
  the company's `min_confidence`. The threshold has **no default**: while it is unset, no observation counts
  as confirmed and no location is ever shown. It must come from an evaluation of the model on the site's
  own footage (true and false match rates), approved before real use.
- The **last known floor and zone** come only from a confirmed observation, and are labelled "Inferred
  location" («موقع مُستنتج»). An uncertain one appears in the timeline, marked uncertain, and never becomes
  the last location.
- Two confirmed observations within 60 seconds that name different floors make the journey UNCERTAIN,
  and **no location** is shown while they do: neither is reliable. A fresh unconfirmed observation also
  makes it UNCERTAIN, but the last confirmed location stays shown.
- Only the sightings of an association the provider activated (its `ENROLLED` accepted) count, ever.
- Nothing confirmed for longer than the company's `stale_after_minutes` (default 15) makes it STALE:
  counted from the latest confirmed observation, or from the activation (the `ENROLLED` event) while there
  is none yet. Right after a successful enrollment the journey is ACTIVE with an unknown location.

**Area alerts (Phase 16; nothing changes for a provider).** Once a batch is applied, the application compares
each visit's confirmed location (by exactly the rules above) with the areas the visit is allowed in and may
open, move on or resolve a tracking alert, in the same transaction; the batch's outcomes and its answer are
unchanged. Only a confirmed observation the batch itself stored, and the latest one, counts: a sighting sent
late never raises or clears an alert, so a provider gains nothing by re-sending old events. A batch counts as
the provider's contact before the alert is decided, so the first sighting after a silence is judged on a live
journey ([`visitor-journey-design.md`](visitor-journey-design.md) §9).

Every one of these numbers (2 minutes, 5 minutes, 10 minutes, 60 seconds, 15 minutes, 12 hours) is a **placeholder**
until the cameras' analysis classes and the model's behaviour on real footage are known
([`decisions/phase-15-backend.md`](decisions/phase-15-backend.md) B15-16).

## 7. The association's lifetime

An association is created PENDING when reception (or an administrator) enrolls a checked-in visit at an
enrollment camera, and ends — once, for good — at the first of:

- the visit's check-out (in the check-out's own transaction);
- an explicit revoke, the company switching tracking off, the platform owner disallowing it, or the
  company's deactivation;
- its expiry: **10 minutes** after its creation if it is still PENDING (no `ENROLLED` accepted by then;
  reception can then enroll again, with a new ref), and **12 hours after its activation** once ACTIVE. The
  visit's schedule plays no part: a visitor checked in late, or staying past the pass's window, is still
  inside;
- an `ENROLLMENT_FAILED`, or an enroll request the provider did not take.

Each end is followed by a `revoke(ref)` call. The provider must then forget the association; anything it
sends for the ref afterwards is rejected.

## 8. Example exchanges (synthetic values)

**A heartbeat and two observations, one of them retried:**

```bash
curl -sS https://vms.example.com/api/v1/tracking/events \
  -H "Authorization: Bearer $TRACKING_KEY" -H "Content-Type: application/json" \
  -d '{"events":[
        {"provider_event_id":"hb-1003","type":"HEARTBEAT","observed_at":"2026-10-20T07:15:00Z"},
        {"provider_event_id":"obs-77","type":"OBSERVED","association_ref":"trk_k7q3xw2m5d4vbn6rht2sz3ycl4fpe7ga",
         "camera_id":"cam-3f-corridor-east","observed_at":"2026-10-20T07:14:58Z","match":"CONFIRMED"},
        {"provider_event_id":"obs-76","type":"OBSERVED","association_ref":"trk_k7q3xw2m5d4vbn6rht2sz3ycl4fpe7ga",
         "camera_id":"cam-3f-corridor-east","observed_at":"2026-10-20T07:13:40Z","match":"UNCERTAIN"}]}'
```

```json
{"results":[
  {"provider_event_id":"hb-1003","result":"accepted","reason":null},
  {"provider_event_id":"obs-77","result":"accepted","reason":null},
  {"provider_event_id":"obs-76","result":"duplicate","reason":null}]}
```

**A batch the application cannot read** (an `OBSERVED` without `match`, and an extra field):

```json
{"error":{"code":"VALIDATION_ERROR","message":"Please correct the highlighted fields.",
  "details":{"fields":{"events.0.match":"This field is required for this type of event.",
                       "events.1.crop":"This field is not allowed."},
             "field_codes":{"events.0.match":{"code":"required","params":{}},
                            "events.1.crop":{"code":"not_allowed","params":{}}}}},
 "request_id":"5f0c…"}
```

---

## 9. What a real adapter still needs (BLOCKED BY ENVIRONMENT)

None of this exists. Each item depends on the open questions of the Gate 0 assessment (§6 there):

1. **The model and its owner** (questions 1–2): whether it re-identifies a person across cameras and
   across PCs at all, who owns it, and a test environment with access to its code and documentation.
2. **The enrollment interface** (question 3): how the provider takes "the person at camera *C* now" — a
   track selected on a live camera, a short capture on its side — and through which interface. The
   application's side is fixed: `enroll(company_id, ref, provider_camera_id, at)`, no image.
3. **The event channel** (question 4): the provider must call `POST /api/v1/tracking/events` with a key,
   or an adapter process must translate its output (webhook, queue, database) into these batches. Either
   way the adapter is a `TrackingProvider` implementation in `backend/app/services/tracking_provider.py`
   plus a `TRACKING_PROVIDER` value, added with a decision record.
4. **`revoke` and `health` on the provider's side**: forgetting a ref (and its gallery entry, if any) on
   request, and a reachable health check. The application calls both after its commits and counts
   failures.
5. **Camera mapping** (question 5): each camera's provider ID, its building, floor and zone, and its
   analysis class (continuous, near-real-time, periodic). Periodic cameras see few people; the placeholder
   constants must be revisited with this.
6. **Retention on the provider's side** (question 6): what it stores (crops, embeddings, galleries), for
   how long, and deletion on request.
7. **Measured accuracy** (question 7): true and false match rates on this site's footage, from which the
   company's `min_confidence` is set. Until then it stays unset and no location is shown.
8. **Shared cameras across companies** (question 8): a lobby camera serving several tenants has no owner
   in this model; each company registers its own cameras, and a key posts only for its company.
9. **The privacy owner's approval** (question 9): purpose, lawful basis under Jordan's PDPL (Law No. 24
   of 2023), the notice to visitors, access and retention — before any real visitor is enrolled
   ([`production-readiness.md`](production-readiness.md)).
10. **A real-model integration test** (Gate 5): end-to-end on the site with real footage. It has not been
    run and must not be reported as passed.
