# Visitor tracking model: assessment (Gate 0)

Date: 2026-10-20. Scope: the "Visitor Journey" request, which would show a checked-in visitor's last
observed floor or zone, inferred by an existing multi-camera person re-identification (Re-ID) model.

**Result: BLOCKED BY ENVIRONMENT.** The tracking model, its code, its interface and its documentation
were not available to this assessment. Nothing below states a capability of that model as confirmed,
because none could be checked. Whether a cross-camera Re-ID model exists is itself unconfirmed.

## 1. What was searched

| Where | How | Found |
|---|---|---|
| This workstation (`C:`, the only drive) | File names under `C:\Users\User` to depth 6: `reid`, `re-id`, `tracking`, `tracker`, `bytetrack`, `deepsort`, `strongsort`, `botsort`, `torchreid`, `fastreid`, `osnet`, `yolo`, `person`, `cctv`, `camera`, `shaheen`; model files `*.onnx`, `*.pt`, `*.pth`, `*.engine`, `*.trt` | No tracking or Re-ID code, package, interface or weights. Unrelated: a voice agent's speech models, AnyLabeling's YOLOv8 object-detection models (a labelling tool's downloads), a Visetec IPVideo licence-plate (ANPR) SDK sample, and three "Shaheen" hardware-planning PDFs (§2) |
| WSL | `wsl -l -v` | No distribution listed |
| This repository | Models, migrations, documentation | No building, floor, zone, camera or tracking concept (§4) |
| **Not searched** | The Shaheen pilot PC, other servers, GitHub or other remote repositories (no GitHub CLI on this workstation), any vendor portal | — |

## 2. The only evidence found: Shaheen hardware documents

`Shaheen_Hardware_Options_50-100_Cameras_v3.0.pdf` (marked confidential, 18 October 2026) and two
earlier variants plan hardware for "Shaheen AI video analytics" at 50 and 100 cameras. They are
hardware and cost plans, not model documentation. What they state:

- **Pilot:** 3 cameras on one RTX 3060; "3 continuous cameras fill one RTX 3060". Measured: about 0.77 GB
  of GPU memory and 2.3 GB of RAM per camera.
- **Software:** PyTorch. The models are not named; "Which PyTorch and CUDA versions does the software use,
  and which models (for example YOLO, RF-DETR or D-FINE)?" is listed as an open question.
- **What it analyses:** "Counting, tracking and alerts" are named as what the continuous cameras do.
- **Architecture:**
  - "Today every camera runs its own copy of the models".
  - "Each card still runs its own copy of the software with its own dashboard".
  - If one PC fails, its cameras stop, and "the other PCs cannot take them over".
  - A "full shared model service" is a future, high-effort stage.
- **Camera classes:** continuous (live video), near-real-time ("a few frames every few seconds") and
  periodic ("10 frames every 5 minutes"). The 50-camera plan has 6, 10 and 34 cameras of each.

**What this implies, as inference to be confirmed:**

- **No cross-camera identity is described.** Nothing describes cross-camera re-identification, an
  enrollment step, an identity gallery, appearance embeddings, an API or an event stream. "Tracking"
  next to "counting" and per-camera model copies matches per-camera multi-object tracking, where a
  track ID lives within one camera's stream. Independent processes per PC, each with its own dashboard,
  share no identity space across cameras.
- **Sparse cameras give sparse journeys.** A camera that analyses 10 frames every 5 minutes will
  usually never see a visitor who walks past it. If corridor and floor cameras are in that class, a
  floor-level journey would have long gaps whatever the model does.
- **"The existing Re-ID model" may not be Shaheen.** It cannot be assumed to be Shaheen. If it is
  Shaheen, it cannot be assumed to do Re-ID.

## 3. The capabilities the request depends on

| Needed | Status | Evidence |
|---|---|---|
| Cross-camera person Re-ID (one identity across cameras and floors) | **Unconfirmed; not evidenced** | §2: per-camera model copies, independent PCs |
| Enrollment input (image, crop, embedding, a track picked on a camera) | Unknown | None |
| Interface (HTTP API, Python package, message queue, database, files) | Unknown | Each PC has "its own dashboard"; no API is mentioned |
| Output fields (camera ID, timestamp, track ID, zone, confidence, match result) | Unknown | None |
| Camera → building / floor / zone mapping | Unknown | None in the model's documents; none in the VMS |
| Identity kept across camera handoffs, occlusion and re-entry | Unknown | None |
| Images or templates retained by the model, and for how long | Unknown | None |
| Hardware, latency, throughput | Partial | Pilot GPU load and memory measured (§2); latency and CPU decoding not measured ("this was not measured on the pilot") |
| Isolation by company and by visit | Unknown | Per-PC dashboards suggest one site, one operator |
| Measured matching accuracy (true and false match rates on site footage) | None | — |

## 4. The VMS today

- **No location model:** no buildings, floors, zones or cameras. Visits have a company, a host, a
  department, times and a status (`SCHEDULED`, `CHECKED_IN`, `CHECKED_OUT`, `CANCELLED`, `NO_SHOW`).
- **Multi-company:** one deployment serves several companies (tenants), each isolated. Shared cameras
  in a lobby or corridor used by several companies have no owner in this model; that needs a design
  decision (§6, question 8).
- **Written commitments the request would reverse.** The README says "The product collects no national
  ID numbers and no biometric data". `docs/security.md` lists among the data "Not collected": "photos or
  other biometric data". The README and `docs/architecture.md` place "AI features" outside the product's
  scope.
  - **Images:** an enrollment image is a photo of the visitor.
  - **Appearance data:** a Re-ID template is derived from the person's appearance, and can include the
    face.
  - **Movement:** journey events are a record of a named person's movements inside a building.
  - Building this needs the owner's explicit decision, these documents updated, and a privacy impact
    assessment before any enrollment code exists.

## 5. Legal and privacy

- **Law:** Jordan's Personal Data Protection Law (No. 24 of 2023) applies to visitor data. How it
  classifies appearance-derived templates and movement records, the lawful basis, the notice and any
  registration duty must be confirmed by the legal or privacy team. This assessment does not decide
  them.
- **Contracts:** the building's and tenants' contracts may restrict camera use.
- **Purpose and access:** the purpose, who may see a journey, retention periods and the visitor notice
  must be written down before real visitors are enrolled.

## 6. Open questions, for the model's owners and the VMS owner

1. Is "the existing Re-ID model" Shaheen? Who owns its code? Where does it run? Who can grant access to
   the code, its documentation and a test environment?
2. Does it re-identify a person across cameras, and across PCs? Or does it track within one camera only?
3. What does enrollment take (an image, a crop, an embedding, a track selected on a camera), and through
   which interface?
4. What does it emit for a match? Over what channel (webhook, queue, database, polling)? How is that
   channel authenticated?
5. Which cameras are at reception and on which floors and zones? What is each camera's analysis class
   (continuous, near-real-time, periodic)?
6. Does it store crops, embeddings or galleries? Where, for how long, and can one identity be deleted on
   request?
7. Has its matching accuracy been measured on this site's footage: true matches, false matches, and the
   effects of clothing, lighting and handoffs?
8. Do several VMS companies share the building and its cameras? Who owns a lobby camera's observations?
9. Who is the privacy owner who will approve the purpose, the lawful basis, the notice and retention?

## 7. What does not depend on the model

A provider-neutral boundary could be built without the model, with the provider switched off:

- the building / floor / zone / camera registry;
- a random per-visit tracking association with its lifecycle (check-out, cancellation and revocation end
  it);
- an authenticated ingestion contract, idempotent, tenant-checked and stale-aware;
- a journey view that shows "Unknown" or "Unavailable" while no provider is connected.

**Enrollment is the exception.** What is captured, where, and in what form depends on question 3, and on
the privacy decisions in §4–§5.

**A model-independent alternative:** the visitor pass already carries a QR code. Scanning it at floor
entrances (a tablet or reader per floor, using the reception desk's existing scan flow) would record
floor-level journey events that are exact rather than inferred. It needs no images and no biometric
data, so it keeps the commitments in §4. It covers only the doors that have a scan point, and a
visitor who does not scan is not recorded.

## 8. Gate 0 status

| Part | Status |
|---|---|
| Model assessment | **BLOCKED BY ENVIRONMENT**: no model, code, interface or documentation available |
| Design (`docs/visitor-journey-design.md`) | Not started. It waits for the answers to §6 questions 1–4 and 9, and for the owner's decision in §4: a design for an unconfirmed capability would encode guesses |
| Gates 1–5 | Not started |
