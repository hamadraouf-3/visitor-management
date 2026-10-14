# Phase 10 — backend decisions (SMTP delivery of the QR invitation)

Date: 2026-10-07. Scope: `backend/` (application code, tests, `pyproject.toml` and the two lock files),
`.env.example`, `deploy/env/backend.env.example`, `README.md` (§5.3, §7.1, §10, §13), `docs/development.md`,
`docs/security.md`, `docs/architecture.md` and this file. The product decision behind it: the QR invitation
e-mail is the core of the product and must reach real mailboxes now. Until now the only provider that sent
anything was Resend, which needs an account and a verified domain; development and the demo wrote files
(`outbox`). This phase adds an SMTP provider, so a deployment can start with Gmail (an App Password) or
any organisation's mail server and move to Resend with its own domain later, without code changes. Each
entry records a deviation from, or an addition to, `docs/initial-assessment.md` (revision 2) §9 and §7.

**Contract and configuration.** No migration, no new error code, no §8.1 change (no new `EmailKind`, no new
audit action): the contract snapshot (`frontend/src/types/backend-contract.json`) is unchanged and its test
passes; settings are not part of it. New provider value `EMAIL_PROVIDER=smtp` and six settings:
`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY` (`starttls` | `ssl` | `none`), `SMTP_USERNAME`, `SMTP_PASSWORD`,
`SMTP_TIMEOUT_SECONDS` (all in `.env.example`, which a test requires to list every setting). New CLI
command `python -m app.cli send-test-email --to <address>`. New refusals: in production `SMTP_SECURITY=none`;
in every environment, with `EMAIL_PROVIDER=smtp`, a missing `SMTP_HOST`, only one of `SMTP_USERNAME` and
`SMTP_PASSWORD`, credentials together with `SMTP_SECURITY=none`, non-ASCII credentials and an `EMAIL_FROM`
without an address; an `SMTP_HOST` that is not a host name or IP address whatever the provider. One
behaviour change for every provider: header values lose C1 control characters and the Unicode line and
paragraph separators as well (S10-5). New dev/test-only dependencies: `aiosmtpd` 1.4.6 (with `atpublic`
and `attrs`) and `cryptography` 50.0.2, pinned and hashed in `requirements-dev.txt`; `idna`, already
locked, is now declared as a direct runtime dependency (S10-8). `requirements.txt` is unchanged. The
repository's `.env` was not changed, and the running demo (ports 8000 and 5173, database `vms`) was not
touched.

| # | Decision | Reason |
|---|---|---|
| S10-1 | **`SmtpProvider` (`app/email/providers/smtp.py`): the standard library's `smtplib` and `email`, no new runtime dependency.** Like every provider, `send` is blocking and runs in the dispatcher's worker thread, in one of its delivery slots (RR1-02): the same way the Resend provider's blocking `httpx` call runs, never on the event loop or in a request thread. One connection per message: connect, EHLO, STARTTLS (`starttls`), EHLO again, AUTH when credentials are set, MAIL/RCPT/DATA (`send_message`), QUIT. **The message** is an `EmailMessage` with policy SMTP: `multipart/alternative` of the plain text and a `multipart/related` part holding the HTML and the QR PNG (`Content-ID: <visitor-pass-qr>`, `Content-Disposition: inline; filename="visitor-pass-qr.png"`, base64), the structure Gmail, Outlook and Apple Mail display inline; both text parts are quoted-printable, so the whole message is 7-bit and no server needs 8BITMIME. From, Reply-To and Subject are exactly what the Resend provider sends (`EmailService` builds them: EMAIL_FROM, EMAIL_REPLY_TO or the active host's address, the rendered subject); the provider adds `Date` (the application clock) and `Message-ID: <vms-email-<email_messages.id>@<the sender's domain>>`, which is also the `provider_message_id` stored on the row, and the same for every retry of one message. **Headers** are set as `Address` objects and strings through the `email` package, after `sanitize_header`: the package refuses any value that `str.splitlines()` would break, and a Reply-To or From that is no longer exactly one address is dropped (Reply-To: the message still goes, replies reach the sender) or refused (From: permanent, nothing sent). The recipient must be one bare address; the envelope names exactly that one recipient. Domains are sent in their IDNA (2008, the `idna` package `email-validator` uses) ASCII form; a non-ASCII local part needs the server's SMTPUTF8 and is a permanent error without it. Inline images need a safe Content-ID (`[A-Za-z0-9._-]{1,64}`, now shared with the outbox) and a plain MIME type. | The product decision above. Gmail's SMTP settings were checked against Google's help on 2026-10-07: `smtp.gmail.com`, port 587 (TLS/STARTTLS) or 465 (SSL), authentication required ([support.google.com/a/answer/176600](https://support.google.com/a/answer/176600)); App Passwords need 2-Step Verification and are created at myaccount.google.com/apppasswords ([support.google.com/accounts/answer/185833](https://support.google.com/accounts/answer/185833)); a personal account may send 500 messages a day ([support.google.com/mail/answer/22839](https://support.google.com/mail/answer/22839)). The MIME structure is the one the `email` package documents for HTML with related images. |
| S10-2 | **Settings and startup validation (`core/config.py`).** `SMTP_SECURITY` `starttls` (default) upgrades the connection before anything else is sent and fails when the server does not offer STARTTLS: never a fallback to plain text; `ssl` is TLS from the first byte; both verify the certificate against `SMTP_HOST` with `ssl.create_default_context()` (the system's trusted certificates, TLS 1.2 or later). `none` is for local capture servers: accepted in development and test, refused in production, and never with credentials (in any environment: they would cross the network unencrypted). `SMTP_PORT` defaults by mode to 587, 465 or 25 (`Settings.smtp_server_port`). `SMTP_USERNAME` and `SMTP_PASSWORD` go together (both empty: no AUTH, for relays that authorise by address) and must be printable ASCII, because `smtplib` encodes AUTH as ASCII (and its `UnicodeEncodeError` would name a character of the password). `SMTP_PASSWORD` is a `SecretStr`. `SMTP_HOST` is a host name (one label allowed: `localhost`, a compose service) or an IP address, never a URL or `host:port`. With `EMAIL_PROVIDER=smtp`, `EMAIL_FROM` must hold an address. `SMTP_TIMEOUT_SECONDS` 1–60, default 10. Every message names the setting and never its value (`hide_input_in_errors` as before). **Gmail App Password:** Google shows it as four groups of four letters; for `SMTP_HOST=smtp.gmail.com` a password of exactly that shape loses its spaces (an App Password has none); any other password is kept as given. **Startup warnings** (`email_configuration_warnings`, logged by `create_app` and printed by `send-test-email`, naming settings only): EMAIL_FROM's address is not SMTP_USERNAME while SMTP_HOST is smtp.gmail.com (Gmail sends from the signed-in account unless the address is a verified "Send mail as" alias); port 465 with `starttls`, or 25/587 with `ssl` (a mismatch hangs until the timeout or fails the handshake); and, for `smtp` or `resend`, a `QR_BASE_URL` on this computer (`localhost`, a loopback address), whose pass links no visitor's phone can open. | The task's requirements, plus what makes the first real delivery work: the most common Gmail failures are the account password instead of an App Password, a pasted App Password with spaces, a From address Gmail rewrites, and QR links that point to `localhost` (the demo's own `.env` has `QR_BASE_URL=http://localhost:5173`). Warnings rather than refusals for these, because each has legitimate exceptions (a verified alias, a server on a non-standard port, a developer testing on one computer). |
| S10-3 | **The per-delivery deadline bounds every wait, not only each operation.** The dispatcher passes the time left of the message's 20 s deadline (`timeout_seconds`, RR1-02). The provider gives the connection, every write and every read of a reply `min(SMTP_TIMEOUT_SECONDS, time left)` (`_BoundedSMTP` overrides `send` and `getreply` to set the socket's timeout before each, for `SMTP` and `SMTP_SSL` alike; the TLS handshakes run under the timeout set before them). A server that answers each command within the per-operation timeout but slowly cannot stretch one attempt past the deadline either. A wait that starts after the deadline still gets 0.05 s, so the protocol's clean-up after a refusal (RSET) ends at once instead of turning a permanent refusal into a timeout. `timeout_seconds <= 0` fails at once (transient); without `timeout_seconds` (direct use) the attempt gets 20 s. **EHLO name:** the host of `APP_BASE_URL` (an address literal for an IP origin), never `socket.getfqdn()`, which needs a DNS lookup that can stall the attempt and tells the mail server the internal machine name. **Greeting:** `smtplib`'s `connect()` returns the greeting's code without checking it (only its constructor does), so the provider checks for 220 itself. | A per-operation socket timeout alone lets an attempt run for (commands × timeout): about ten waits, 100 s at the default, against a 20 s deadline. The greeting check was found by the tests: without it a `421` greeting was read as a timeout during EHLO. |
| S10-4 | **Errors map onto the dispatcher's transient/permanent model, and configuration problems are logged once.** Transient: connection refused or reset, DNS failure, timeouts (also a connection closed by a read timeout), a dropped connection, TLS handshake failures other than certificate verification, and every 4xx reply (421 included; also a 4xx answer to AUTH, e.g. `454 4.7.0`). Permanent: every 5xx reply (550/553 for the recipient, 554/552 for the message, 553 for the sender), a refused sign-in (535, Gmail's 534 `5.7.9` "Application-specific password required"), `530` "authentication required" whichever command it answers, no STARTTLS or no AUTH offered, no usable AUTH mechanism, an unverifiable certificate, and a missing SMTPUTF8 for a non-ASCII address. Messages (stored in `last_error`, shown with the invitation, printed by the CLI) name the stage, the reply code and its enhanced status code only, e.g. "The mail server rejected the recipient address (SMTP 550 5.1.1).": never the server's own text (it repeats the recipient's address), never a credential. A refused sign-in, `530`, no STARTTLS, no AUTH, an unverifiable certificate and a refused sender are also logged once as `SMTP configuration problem: <what to check>` (ERROR, logger `app.email`, the settings to check, for a refused sign-in the App Password hint) until a message is sent again; the dispatcher's own per-attempt WARNING carries no error text. The error is raised outside the `except` block, so it keeps no reference to `smtplib`'s exception, whose frames hold the connection and, during AUTH, the password; `smtplib`'s copy of the password on the connection object is cleared after AUTH, and its protocol trace (which would print the AUTH exchange) stays off. Anything unexpected becomes a permanent "Unexpected error while sending (<class>)." with one ERROR line naming the class and stage only. | The task's classification. "Logged once" so that fifty invitations against a revoked App Password give one actionable line, not fifty, and the next success re-arms it. |
| S10-5 | **Header values lose C1 controls and U+2028/U+2029 too (amends §9 "CR/LF stripped from all header values"; every provider).** `rendering.sanitize_header` replaced runs of C0 controls and DEL with a space; it now also replaces C1 controls (NEL among them) and the Unicode line and paragraph separators: everything `str.splitlines()` breaks a line at. | A company name is in the invitation's subject as stored, and the SMTP provider sets the subject through the `email` package, which refuses a value with such a character: without this, a company name with a line separator would have failed every invitation of that company (permanently, as "The message could not be built"). For Resend the subject is JSON, where the characters were harmless but meaningless. |
| S10-6 | **`python -m app.cli send-test-email --to <address>`: one attempt through the configured provider, no database, no audit row.** The command prints the configuration warnings (S10-2), builds a short message (`EmailService.build_test_email`: template `test_email`, the same sender and Reply-To rules, subject "Test e-mail from <EMAIL_FROM's name>") with a sample QR code inline exactly as an invitation carries its pass; the code and the link point to `{QR_BASE_URL}/pass#sample-not-a-visitor-pass`, the address real invitations use, with no token (the pass page shows it as invalid). It sends with the dispatcher's 20 s deadline and no retry, then prints where the message went (`accepted by the mail server <host>:<port> (<mode>)`, `accepted by Resend`, `written to <outbox>`), the Message-ID and the sample's address; or `error: test e-mail not sent (permanent|temporary: a real message would be retried): <the classified error>` with exit code 2. It never prints a credential (the provider's errors cannot contain one). Allowed in every environment. **No audit row:** the CLI's audited commands record the business changes they make, each in a company (COMPANY_CREATED, VISIT_MARKED_NO_SHOW, VISIT_TIME_SHIFTED); `prune-sessions`, which changes rows but has no company, writes none. A test message changes nothing, belongs to no company, and is not an `email_messages` row; a new audit action would be a §8.1 enum and CHECK change for nothing a reviewer needs. Needing no database lets an operator check the mail settings before the database is up. **No new `EmailKind`:** the message object carries `VISITOR_INVITATION` (what it imitates, no `pass_url`) because the enum is part of the contract and the database's CHECK constraint, and nothing stores it. | The task's command. Printing the QR target makes the `localhost` problem visible at the moment a person tests. |
| S10-7 | **Tests against real SMTP servers (aiosmtpd) and a throwaway certificate.** `tests/smtp_support.py`: `SmtpTestServer` (aiosmtpd's threaded controller on 127.0.0.1; STARTTLS, implicit TLS or plain text; AUTH with a configurable failure reply; replies scripted per command; a delay before each reply; records each accepted message as received), `RawServer` (TCP: no greeting, or a 4xx/5xx greeting), `make_certificate` (an EC P-256 self-signed certificate for 127.0.0.1, generated per test session with `cryptography`; no key is ever written into the repository, which the release-tree check would refuse) whose `client_context()` is `ssl.create_default_context()` trusting only it. The QR PNG reader moved from `test_qr.py` to `tests/qr_png.py` (unchanged). **Unit (`test_smtp.py`, 71):** STARTTLS with AUTH (envelope; headers; Date; Message-ID; both EHLOs; text and HTML bodies as rendered; the image's Content-ID equals the HTML's `cid:`, inline, and the PNG decodes to exactly the pass URL; 7-bit), implicit TLS with AUTH, plain text to a capture server, the same Message-ID on a retry, no Reply-To, IDN domains and SMTPUTF8, a sender that is no address, header injection through every user-controlled field of an invitation (company, visitor and visitor company names, host, department, purpose) with eight payloads (CR/LF, LF, CR, U+2028, U+2029, NEL, VT/FF, FS/GS/RS: one Subject, one To, only the expected headers in every MIME part, exactly one envelope recipient) and through the provider's own subject, sender and Reply-To, single bare recipients, unsafe Content-IDs, a refused sign-in logged once and re-armed by a success, 535/534/454 on AUTH, no STARTTLS, no AUTH and no mechanism, eleven scripted RCPT/MAIL/DATA replies, 421/554 greetings, a silent server, connection refused, an untrusted certificate, implicit TLS against a STARTTLS port, the deadline (a silent server with 10 s per operation and 1.5 s left; a server answering every command in 0.4 s with 1 s left, then the same server with the whole deadline), no time left, and no credential (nor its AUTH PLAIN/LOGIN base64 forms) in any log record, error text, `repr` or exception chain. **CLI (`test_send_test_email.py`, 8)**, **settings (`test_config.py`, +35)**, **factory and warnings (`test_email.py`, +13)**. **Integration (`test_smtp_delivery.py`, 5):** through the API, the dispatcher and the database: an invitation reaches the server with the QR code of exactly the pass the API issued (row SENT, `provider_message_id` = the Message-ID, INVITATION_SENT); a 550 recipient fails at once (FAILED, the classified error without the address, Needs attention, INVITATION_FAILED, no retry); a 451 at DATA is retried and sent (2 attempts, 1 s back-off); a silent server ends a message at the dispatcher's deadline after one attempt; startup logs the Gmail sender warning. | The task's test list. aiosmtpd is the de-facto standard SMTP server for Python tests; `cryptography` is the only way to make a certificate at test time without committing a key. Notes for whoever extends the helpers: a handler that implements `handle_EHLO` must set `session.host_name` itself (aiosmtpd otherwise answers `503 send HELO first`, and `smtplib` takes a `503` to AUTH for success); an authenticator must return `handled=False` on failure or aiosmtpd sends no reply; the controller's own loop is passed to the SMTP class so that aiosmtpd never switches warnings to errors in its thread (`_get_or_new_eventloop`), which would race with pytest's warning filters. |
| S10-8 | **Dependencies.** `pyproject.toml` `[project.optional-dependencies] dev` gains `aiosmtpd>=1.4.6` and `cryptography>=46`; `requirements-dev.txt` pins `aiosmtpd==1.4.6`, `atpublic==8.0.1`, `attrs==26.1.0` and `cryptography==50.0.2` (its `cffi` is already in `requirements.txt`), with hashes written by `scripts/lock_hashes.py` (which left every other pin's hashes unchanged); they were installed into `backend/.venv` with `pip install --require-hashes --no-deps`. `idna>=3.7` is now a declared runtime dependency: the SMTP provider imports it, and it was already locked (`idna==3.20`) as a dependency of `httpx` and `email-validator`; `requirements.txt` is unchanged. aiosmtpd 1.4.6 (May 2024) was checked on this Python (3.14.6) with warnings as errors: STARTTLS, implicit TLS and AUTH work. | "No new runtime dependency" (the task) and "dev dependencies the way the project declares them" (SEC-25 locks). |
| S10-9 | **Not done, and residual risks.** (a) **Duplicates:** SMTP has no idempotency key; a retry after a final reply lost in transit (the server accepted the message, the reply never arrived) delivers a second copy. It carries the same Message-ID, subject and pass, so a visitor gets two identical, working invitations; marking it FAILED instead would invite a resend that rotates the pass and breaks the first copy. (b) **OAuth2 (XOAUTH2) for Gmail** is not implemented: App Passwords need 2-Step Verification, and Google calls them "not recommended"; if Google retires them for an account type, Gmail needs OAuth2 or the deployment moves to Resend or its own server. (c) **Custom CA bundle:** the system's trusted certificates only; an internal mail server with a private CA needs its CA in the system store (a setting can be added if a deployment needs it). (d) **One connection per message**, no pooling: at most `EMAIL_DELIVERY_CONCURRENCY` (4) connections at a time, which servers accept. (e) **Sending limits and reputation** are the mail service's: Gmail's 500 a day per personal account; DKIM, SPF and DMARC are configured at the sending domain, not by the application. (f) **Real delivery to Gmail was not run here** (no App Password on this machine): the provider was verified against aiosmtpd (STARTTLS, TLS, AUTH, the received MIME parsed and its QR decoded) and the CLI end to end against aiosmtpd's debugging server. | Recorded so that the next owner knows what the provider does not cover. |

## Verification (2026-10-07)

- Backend gate (`backend/`): `ruff check .` clean; `ruff format --check .` 239 files formatted; `mypy`
  clean on 130 source files; `pytest` 2327 passed and 3 skipped (the opt-in volume checks) in 274 s;
  `pytest --committed-first` 2327 passed and 3 skipped in 261 s. 132 test items were added (2195 at the
  final release gate): 71 in `test_smtp.py`, 8 in `test_send_test_email.py`, 5 in
  `test_smtp_delivery.py`, 35 in `test_config.py`, 13 in `test_email.py`. The existing e-mail, template,
  QR, Resend and dispatcher tests pass unchanged (`test_qr.py` now imports the PNG reader it used to
  define). The contract snapshot test passes without regeneration.
- Deployment files (repository root): `check_release_tree.py` OK (785 files, no development artefact or
  credential: the test certificate is generated at run time); `unittest discover -s deploy/verify` 27
  tests OK.
- Each fix was undone on its own and its tests failed: `sanitize_header` without C1 and the Unicode
  separators (6 injection cases), no per-wait deadline (the slow-server deadline test), no greeting check
  (both refused greetings), the configuration problem logged every time (1), the error raised inside the
  `except` (the credential test: it then references smtplib's exception), production accepting
  `SMTP_SECURITY=none` (1), credentials accepted over `none` (1), the Gmail App Password keeping its
  spaces (2), the image as an attachment instead of inline (1). All files were restored and the gate
  re-run.
- Live, against aiosmtpd's debugging server on 127.0.0.1:1025 with the development `.env` and four
  shell variables (`EMAIL_PROVIDER=smtp`, `SMTP_HOST=127.0.0.1`, `SMTP_PORT=1025`, `SMTP_SECURITY=none`):
  `python -m app.cli send-test-email --to you@example.com` printed the localhost QR warning, "test e-mail
  to you@example.com accepted by the mail server 127.0.0.1:1025 (none)", the Message-ID and the sample's
  address; the server printed the message (From, To, Subject, Date, Message-ID, `multipart/alternative`,
  the quoted-printable text and HTML, the inline PNG). A scratch script sent a real invitation over
  STARTTLS with AUTH to aiosmtpd and parsed it: `multipart/alternative` > [`text/plain`,
  `multipart/related` > [`text/html`, `image/png`]], headers exactly From, To, Reply-To, Subject, Date,
  Message-ID, MIME-Version, Content-Type; a wrong password gave the 535 error and one configuration line,
  an untrusted certificate the verification error.

## Hand-over

- **Contract owner (`docs/initial-assessment.md` §9, not edited here):** add to the provider list:
  "`SmtpProvider`: `smtplib` over STARTTLS or implicit TLS (certificate verified; `none` only outside
  production, without credentials) with optional AUTH; text and HTML alternatives with the QR as an inline
  related part (`cid:`); 4xx, timeouts and connection errors transient, 5xx and a refused sign-in
  permanent; every wait within the message's deadline (S10-1 to S10-4)." In "Header safety": "line breaks
  of every kind (CR, LF, C1 controls, U+2028/2029) are replaced in all header values" (S10-5). In §14,
  the decision log line for this phase.
- **Frontend:** nothing changes. The invitation's `error` can now read like "The mail server rejected the
  recipient address (SMTP 550 5.1.1)." (≤ 500 characters, as before).
- **Security audit owner:** TB4 now includes an SMTP server; `docs/security.md` §1, §2.1, §12.1 (the
  `SMTP_PASSWORD` row) and §12.3 were updated. Production accepts `smtp` over TLS; review S10-9 (b) and
  (c) for the deployment.
- **The person deploying (Gmail now, Resend later):** put the App Password into `.env` yourself (never in
  a chat or on a command line), restart the API, run `send-test-email` to your own address, and set
  `QR_BASE_URL` to an address a visitor's phone can reach. Moving to Resend later is `EMAIL_PROVIDER=resend`
  with `RESEND_API_KEY` and an `EMAIL_FROM` on the verified domain (README §10); nothing else changes.

## Review fixes (2026-10-07)

The SMTP provider's adversarial review demonstrated four defects. Each one was reproduced with the
reviewer's own probe before any change, fixed at its cause, and covered by tests that fail without the
fix. S10-10 to S10-13 amend S10-1, S10-3 and S10-4; where they disagree with those entries, these win.
S10-3's statement that "a server that answers each command within the per-operation timeout but slowly
cannot stretch one attempt past the deadline" was true only for whole replies. A reply spread out over
time was not bounded. Nothing else changed: no migration, no new setting, no contract change (the
snapshot test passes unchanged), no new dependency. The running demo (ports 8000 and 5173, database
`vms`) and the root `.env` were not touched.

| # | Decision | Reason |
|---|---|---|
| S10-10 | **The deadline is absolute: every wait asks for the time left, and no wait starts after the deadline (amends S10-3).** `_Budget.wait()` returns `min(SMTP_TIMEOUT_SECONDS, time left)` and raises `TimeoutError` once the deadline has passed. `_BoundedSMTP` asks it before each wait, not before each command. **Connect:** `_get_socket` replaces `socket.create_connection` and gives each resolved address of SMTP_HOST the time left (create_connection gave each address the whole timeout). **Reads:** `getreply` reads through `_ReplyReader`, a raw I/O object that calls `budget.wait()` before every `recv_into`. smtplib reads through `socket.makefile`, where every receive gets the whole timeout again, and it reads `220-`/`250-` continuation lines without limit. Once the deadline has passed, a receive takes only what has already arrived and never waits, so a reply the server sent in time is still read as that reply. **Writes:** `send` writes in a loop and arms each part. On failure it raises `SMTPServerDisconnected` with the `TimeoutError` as its context, as smtplib does. **Handshakes:** after every reply the socket gets `budget.handshake()`: the time left, but at least 0.05 s. The STARTTLS handshake runs under that timeout. With implicit TLS the handshake gets `budget.wait()` once connected. CPython bounds a whole handshake by its socket timeout (3.5+). The old 0.05 s floor that every wait got after the deadline is gone. It was the same bypass on a smaller scale: a byte every 0.04 s. It is replaced by the non-waiting receive above, which bounds the attempt and keeps what the floor was for. A refusal read before the deadline is still reported as that refusal: the clean-up that follows it (RSET) then fails at once with `SMTPServerDisconnected`, which smtplib's `_rset` ignores. **Reply size:** a reply is cut off after 64 KiB (`MAX_REPLY_BYTES`) because smtplib keeps every line in memory. The error is "The mail server's reply was too long.", transient like a dropped connection. **Not bounded:** the name lookup (`getaddrinfo`), which uses the system resolver and its own timeouts, as before. | Review finding 1 (medium). Before → after, same probes and values: a greeting trickled a line or a byte every 0.5 s with SMTP_TIMEOUT_SECONDS=1 and 2 s left went from 12.0 s to 2.0 s. With production values (SMTP_TIMEOUT_SECONDS=10, the real `EmailDispatcher` and its 20 s deadline, a `220-` line every 5 s for 45 s), the result went from "SENT after 45.0 s" to "FAILED after 20.0 s" with "did not respond in time" after one attempt. A host name resolving to 3 black-holed addresses, with 2.5 s left and SMTP_TIMEOUT_SECONDS=2, went from 6.0 s to 2.5 s. The reviewer's watchdog-thread option was not taken: it costs a thread per attempt, and it cannot interrupt the connect phase, where smtplib holds no socket yet. Asking the budget before each wait bounds the same steps inside the delivery thread. |
| S10-11 | **Every EHLO reply is checked (amends S10-4).** `_BoundedSMTP.greet` replaces `ehlo_or_helo_if_needed()` before TLS and the bare `ehlo()` after STARTTLS. A reply that is not 2xx raises `SMTPHeloError` at stage `ehlo`, which `_refusal` classifies. A 4xx is transient: "The mail server deferred the greeting (EHLO) (SMTP 421 4.7.0).". A 5xx is permanent: "refused the greeting (EHLO)". A 530 means "requires SMTP sign-in". Before TLS, a 5xx is still followed by HELO, smtplib's fallback for a server without ESMTP. A 4xx is no longer followed by HELO. | Review finding 2 (medium). smtplib's `ehlo()` returns an error reply instead of raising it, and the empty extension list it leaves behind read as a configuration problem. Probe `probe_ehlo421.py` (Gmail's `421 4.7.0 Try again later, closing connection. (EHLO)` after STARTTLS, real dispatcher). Before: FAILED at once with "does not offer SMTP sign-in (AUTH)" and an ERROR naming SMTP_SECURITY and SMTP_PORT. After: 3 attempts with 1 s and 3 s back-off, each "deferred the greeting (EHLO) (SMTP 421 4.7.0)", and no configuration log. The same unchecked reply before STARTTLS was also permanent: aiosmtpd then answered HELO, and the provider reported "requires SMTP sign-in (SMTP 530)" or "no STARTTLS". |
| S10-12 | **One AUTH per message (amends S10-1 and S10-4).** `_BoundedSMTP.login` sends one AUTH, with the first of PLAIN and LOGIN (`AUTH_MECHANISMS`) that the server offers. smtplib's `login` tries every offered mechanism in turn (CRAM-MD5, PLAIN, LOGIN) until one succeeds. A wrong password is now one refused sign-in per message instead of two, and Google counts each one towards locking the account. A server that hangs up after its 535 now gives the 535: permanent, logged once with the App Password hint. Before, the error was "closed the connection", retried three times. **CRAM-MD5 is no longer used.** Credentials only cross TLS (S10-2), where PLAIN and LOGIN are what Gmail, Microsoft 365 and Postfix/Dovecot offer. smtplib's fallback to the next mechanism, for a server that advertises one it cannot complete, is given up on purpose. A server that offers neither mechanism gets the existing permanent "no SMTP sign-in method this client supports". | Review finding 3 (low). Probe `probe_dispatch.py` with the real dispatcher. A 535 followed by a hang-up went from FAILED after 3 connections, 6 AUTH commands and "The mail server closed the connection." (×3) to 1 connection, 1 AUTH and the 535 error (final). A 535 without a hang-up went from 2 AUTH commands to 1. A 454 went from 6 AUTH commands to 3 over its 3 attempts. |
| S10-13 | **No RFC 2047 encoded word reaches a header unintended (amends S10-1; S10-5 unchanged).** **Addresses:** `validate_email_address` refuses a local part that contains `=?` after NFKC, with "Enter a valid email address. The part before the @-sign cannot contain "=?"." This covers every address the API, the CLI and `EmailService` accept. The provider's `_mailbox` also refuses `=?` anywhere in the To, From or Reply-To address, for addresses stored before this change. The recipient and sender are refused permanently ("The recipient is not a valid e-mail address.", "EMAIL_FROM is not a valid e-mail address."), and such a Reply-To is left out. **Subject:** `_literal_text` puts a space after each `=` that opens `=?`, so `=?` becomes `= ?`, before the Subject is set. Only the SMTP message changes: the stored `email_messages.subject`, the rendered bodies and what Resend receives stay as rendered. Display names come only from EMAIL_FROM and EMAIL_REPLY_TO (configuration) and are unchanged. | Review finding 4 (low). `email.headerregistry` decodes encoded words in every value it is given, inside an addr-spec too, which RFC 2047 §5 forbids. The To line then named a different mailbox from the envelope, and the decoded Subject could hold CR/LF. **The reviewer's Subject fix does not work.** Encoding the text ourselves with `email.header.Header(..., "utf-8")` was tried: the package decodes our encoded word too and writes the decoded text out unencoded. That text still contains `=?...?=`, so the client decodes it a second time and the CR/LF comes back. The package has no way to set literal header text that contains an encoded word. Probe results after the fix: `probe_rcpt_wire.py` now stops at the validator. In `probe_mime.py` the decoded Subject is "Your visit to = ?utf-8?q?Acme=0D=0ABcc:_victim@evil.test?= on Monday, 12 October 2026", one line. The Arabic subject is still sent as `=?utf-8?b?...?=` and decodes as typed. |

**Residual (S10-13).** An address with `=?` in its local part that was stored before this change can
only exist if someone entered it on purpose. It would now fail `EmailService._queue`'s re-validation like
any stored address the validator refuses: the request that queues mail to it ends in `INTERNAL_ERROR`, and
no message is queued. Before, the message was sent with a rewritten To line. The demo database `vms`
was not inspected (it is off limits here).

### Tests (S10-10 to S10-13)

`tests/smtp_support.py` gains `ScriptedServer`, a TCP listener that runs a function of the test for each
connection: a reply spread out over time, a reply that never ends, a hang-up after a reply, a stalled
handshake. `RecordingHandler.script("EHLO", ...)` now scripts EHLO replies, where an empty reply answers
as usual. New tests, 22 in all: 19 in `test_smtp.py` (now 90 tests) and 3 in `test_schemas.py`:

- A greeting spread out a line or a byte at a time (every 0.2 s for 6 s, with 10 s per operation and 1.5 s
  left) ends at the deadline.
- The addresses of one host name share the time left. Three black-holed addresses, simulated with a fake
  socket and clock, get timeouts of 1.0 s and 0.2 s, and the third is never tried.
- The TLS handshake after a STARTTLS reply that took 1.2 s of 2 s gets only the 0.8 s left.
- A 1 MiB greeting is cut off.
- A 550 to RCPT that arrives as the deadline passes is still the permanent refusal. This guards the
  RSET clean-up; it passes before and after the fix.
- A reply that arrived in time is still read once the deadline has passed, and then nothing more is
  waited for. This test uses a socket pair and the private `_ReplyReader`, so it is deterministic.
- A wrong password costs one AUTH per message.
- LOGIN is used when PLAIN is not offered.
- A server that hangs up after its 535 gives the permanent refused sign-in, with 1 AUTH and 1 connection.
- A 421 to EHLO after STARTTLS, a 554 after STARTTLS, and a 421 before STARTTLS.
- Three encoded-word company names reach the client as literal one-line subjects.
- Three encoded-word addresses: refused as recipient and sender, left out as Reply-To.
- The validator refuses `=?` in a local part, also written in fullwidth characters.

All 19 tests aimed at a reported defect failed on the unfixed code, for the reasons the review gives.
The refusal at the deadline and LOGIN without PLAIN passed before and after the fix. The test of a reply
read after the deadline covers a refinement of S10-10.

The first full-suite run found a race in the refusal-at-the-deadline test. Its server moved the fake
clock before the provider was waiting for the reply, so under load the provider began its read after the
deadline, before the 550 had arrived, and timed out. Two changes followed. The provider now reads a reply
that has already arrived even after the deadline, instead of raising at once; the old 0.05 s floor used to
give this, and the first version of the fix had lost it. The server in that test now waits 0.5 s before
moving the clock. The ten timing-sensitive tests then passed 30 times out of 30: five runs in each of six
parallel processes, 300 executions in all.

Each fix was then undone on its own while the rest stayed in place, and its tests failed:

| Fix undone | Tests that failed |
|---|---|
| per-receive reads | 3 |
| reading what has arrived after the deadline | 1 |
| reply size cap | 1 |
| per-address connect | 1 |
| post-STARTTLS handshake timeout | 1 |
| EHLO check | 3 |
| one AUTH | 2 |
| provider `=?` check | 3 |
| literal subject | 3 |
| validator `=?` check | 3 |

All files were restored afterwards.

### Verification (S10-10 to S10-13)

Backend gate (`backend/`), run after the last change:

- `ruff check .`: clean.
- `ruff format --check .`: 239 files already formatted.
- `mypy`: no issues in 130 source files.
- `pytest`: 2349 passed and 3 skipped (the opt-in volume checks) in 268 s.
- `pytest --committed-first`: 2349 passed and 3 skipped in 266 s.

That is 22 more tests than the 2327 recorded above. The suite ran against throwaway databases on
localhost:5433. `VMS_TEST_*` pointed at the server's `postgres` database, so `vms` was never connected to.
An earlier `--committed-first` run was stopped while the race fix was being written. Its four throwaway
databases were dropped, and the cluster holds only `postgres`, `vms` and `vms_e2e` again.

The reviewer's probes were re-run on the final code with their original ports and values. The results
match the Reason column of S10-10 to S10-13. A server that sends nothing at all still ends as before:
20.0 s and 2 attempts with production values (`probe_silent.py`).

---

# Phase 10 — backend decisions (brand, languages and bilingual e-mail)

Date: 2026-10-07. Scope: `backend/` (application code, migration `0011`, tests, the e-mail templates and
the packaged logo, `pyproject.toml`'s package data, the Dockerfile's labels), the contract snapshot
(`frontend/src/types/backend-contract.json`), the types of `frontend/src/types/api.ts`, `.env.example`,
`deploy/env/backend.env.example`, `docs/api.md`, the `EMAIL_FROM` examples of `README.md` and
`docs/development.md`, and this file. The product decisions behind it (from the user): the product is
branded entirely as «موضوع» / «Mawdoo3» with its logo; the colours come from the logo (teal `#169897`);
the design follows direction C ("Bold Modern"); the interface is Arabic and English, switchable, Arabic
by default for the demo company; e-mails are bilingual, Arabic first; the company is «موضوع» / «Mawdoo3».
`docs/initial-assessment.md` is the lead's file: the exact text proposed for it is in the hand-over below.
The root `.env`, the running demo (ports 8000 and 5173) and the database `vms` were not touched.

**Contract and configuration.** One migration (`0011`), one endpoint (`PATCH /api/v1/auth/preferences`),
one request model (`PreferencesUpdate`), one enumeration (`Language`: `ar`, `en`), new fields on `Me` and
`CompanySettings` / `CompanySettingsUpdate`; no new error code and no new audit action. Two settings,
`BRAND_NAME_AR` and `BRAND_NAME_EN`, and a new `--language` option of `send-test-email`. No new
dependency.

| # | Decision | Reason |
|---|---|---|
| B10-1 | **Migration `0011` (`20261007_0011_languages_and_arabic_company_name.py`, down revision `0010`).** The task said "0012, check the current head": the head was `0010` (the SMTP work added no revision), so this is `0011`. `users.preferred_language varchar(2) NULL` with `ck_users_preferred_language_valid` (`IS NULL OR IN ('ar','en')`); `companies.default_language varchar(2) NOT NULL DEFAULT 'ar'` with `ck_companies_default_language_valid`; `companies.name_ar varchar(200) NULL` with `ck_companies_name_ar_not_blank` (`IS NULL OR btrim(name_ar) <> ''`; the service stores a blank name as NULL, like the other optional text). Enums are `VARCHAR` + `CHECK` (contract §4), the CHECKs are built from `models.enums.Language` in the models and spelled out in the migration, and `test_models_match_migration` proves they agree. **Grants:** none needed. The runtime role holds table-level `SELECT, INSERT, UPDATE` on both tables (revisions `0001`, `0006`), which cover new columns; the downgrade-then-upgrade test compares the privileges before and after. Adding a nullable column or one with a constant default rewrites no table (PostgreSQL 11+). Existing companies become Arabic (the column default), the product's default. **Downgrade** refuses while a value exists that the next upgrade would not restore (an Arabic name, a user's preference, a company default other than `ar`), after locking both tables (SEC-39), and names the statements that clear them; `docs/development.md` §4.1 asks for exactly this when a downgrade would lose data. | The shared contract's three fields. `varchar(2)` because both values are two letters and the CHECK fixes the set; a third language is a new revision anyway. |
| B10-2 | **Company settings: `name_ar` and `default_language`.** `GET /company/settings` returns both; `PATCH` accepts `name_ar` as `OptionalName200` (the type of the other optional names: trimmed of white space and invisible characters, NFC, at most 200 characters, one line, no control or text-direction characters; blank or `null` clears it) and `default_language` as `Language`, not null. `name` keeps its rules and stays the English (or only) name. Both are in the service's `_UPDATABLE`, so `COMPANY_SETTINGS_UPDATED` names them in `changed_fields` like every other setting (never the values). An enumeration value is stored as its text. | "Same length and validation rules as name" (the task). The display rule (Arabic interface: `name_ar` when set, else `name`) belongs to the clients and the e-mails (B10-9). |
| B10-3 | **`PATCH /api/v1/auth/preferences` `{"language": "ar" \| "en"}` → 200 `Me`.** Declared with `SessionAuth`, not `CurrentAuth`: it works while `must_change_password` is true, like `GET /auth/me`, so the forced-change screen can switch language; every other endpoint stays closed. The global CSRF and Origin middleware covers it like every unsafe request (it is not on the exemption list), and `SessionAuth` spends the per-user API budget and nothing else. `PreferencesUpdate` is a `RequestModel` (unknown fields refused) whose `language` is required: anything else, `null` and a wrong case included, answers 422 `VALIDATION_ERROR` on `language` ("Choose one of: 'ar' or 'en'."). `PreferencesService.set_language` writes only when the value changes (the same language again writes nothing, `updated_at` included) and changes only the caller's own row. The enumeration is published in the snapshot as `$defs.Language`. In `api.ts` the alias `Language` is **not exported**: `api.contract.test.ts` requires every exported name to be a snapshot entry or on its `CHECKED_INDIRECTLY` list, which is a frontend file; `PreferencesUpdate['language']` gives the type. | The shared contract. Clearing a preference (back to the company's default) is not in it; it would be `null`, a later additive change. |
| B10-4 | **A language change is not audited; company settings stay audited.** The audit policy (`docs/security.md` §8.1) records authentication, denials, administration, visitors, visits, passes and e-mail outcomes: events that change access or data someone else relies on. A display preference changes neither. The per-user API budget allows 600 requests a minute, and an append-only table that the runtime role cannot prune must not grow at a user's request rate (§8.5's flood controls exist for that). The two company fields are settings like the others and are audited as above. | The task: "decide and document". |
| B10-5 | **Brand settings `BRAND_NAME_AR` (default «موضوع») and `BRAND_NAME_EN` (default «Mawdoo3»).** NFC, trimmed, 1–60 characters, and refused when they hold a character of Unicode category Cc, Cf, Cs, Co, Cn, Zl or Zp (controls, bidi and zero-width marks, line and paragraph separators, unassigned): one line of visible text for subjects, headings and alt text. The message names the setting, never the value. Used by the e-mails (the logo's alt text, the footer, the test e-mail's sender fallback) and by the OpenAPI title (`"{BRAND_NAME_EN} API"`; there was no `APP_NAME` setting: the title was the application's name). `EMAIL_FROM`'s default became `Mawdoo3 <no-reply@localhost>`. "Visitor Management" is gone from every user-facing string of the backend: subjects, bodies, footers, the test e-mail, the OpenAPI title, the image label of the Dockerfile and the `EMAIL_FROM` examples of `.env.example`, `deploy/env/backend.env.example`, `README.md` and `docs/development.md`. Internal identifiers stay (`vms-email-<id>` Message-IDs, cookie names, the `vms_app` role, the package name). | The user's brand decision. A setting rather than constants so another deployment can carry its own name; the defaults are the brand. |
| B10-6 | **The logo inline in every e-mail, and the e-mail design.** `backend/app/email/assets/brand-logo.png` is the user's `logo-teal.png` byte for byte (462 × 149 px, RGBA, 12,624 bytes, no metadata chunks; SHA-256 `95659e2f121b1951f6f256dfa145d1ae4c976c3c827abbbb13d6f6f58a4c4409`), packaged (`pyproject.toml` package data; the Dockerfile copies `app/`). `EmailService` attaches it to **every** message as `InlineImage(content_id="brand-logo", filename="brand-logo.png")`, after the QR code of an invitation or a test e-mail. The header shows it at 124 × 40 (`LOGO_WIDTH`, `LOGO_HEIGHT`: the image's aspect ratio, about 3.7 image pixels per CSS pixel for dense screens) with the brand name in the leading language as `alt`. The three providers needed no change: they already carried any number of inline images (the outbox writes `<id>-brand-logo.png`, SMTP adds a second inline part to `multipart/related`, Resend a second attachment with `content_id`). **Design** (direction C with the logo's teal instead of the lime "Volt", the Mawdoo3 logo instead of the "Visitor" wordmark): a **light header** with the teal logo, a 3-px teal rule and a pill naming the kind of message; the leading language's heading and greeting; for an invitation a **dark ink pass card** (`#0B1A22`, a navy tinted to teal) holding the QR code on a white tile, the check-in window as two large figures ("Check in from 09:00", "Pass expires 12:00", the zone under them), the "Open my visitor pass" button in the brand teal with ink text and the personal-pass note; a bordered **details grid** (date, time, host, department, address, purpose); **numbered arrival steps** (ink squares, teal figures); a light-teal tip panel; the second language; a grey footer in both languages. A light header was chosen over a dark band: the packaged logo is the teal one, a white header with explicit colours survives clients that invert backgrounds (Gmail's and Outlook's dark modes keep a transparent teal logo readable on either background), and `color-scheme: light` keeps Apple Mail from inverting. **Palette** (contrast on its background, WCAG AA): ink `#0B1A22` 17.7:1 on white; body `#3A4152` 10.2:1; muted `#5A6275` 6.1:1 (5.4:1 on the footer `#F5F6F9`); buttons on light surfaces `#0F7675` with white text 5.4:1 (the brand `#169897` with white text is 3.5:1, so it carries ink text instead: 5.0:1); link-coloured text `#0B5F5E` 7.5:1; on the ink card white 17.7:1, `#AEB5C8` 8.6:1, `#7FD6D3` 10.5:1. **Client safety:** tables and inline styles; no web font and no remote resource (Readex Pro is used when installed, else Tahoma or Segoe UI, both with Arabic; a Google Fonts link would make the visitor's mail client call a third party); one `<style>` block with a phone media query (`max-width: 480px`: narrower side padding, the details grid stacked) as progressive enhancement, ignored without harm by clients that drop `<style>`. **Deviations from the mockup:** the pass card stacks (QR code above the text) instead of two columns, which would squeeze the code beside the text on a 360-px phone; the QR tile is 200 CSS px (the earlier template had 240; the PNG keeps 8 px per module, so it is sharp at that size and on paper); there is no visit code ("VIS-4821"): e-mails show no internal identifiers (contract §9). | The user's design and logo decisions. Inline `cid:` images show without "load remote images" in Gmail, Outlook and Apple Mail, as the QR code already did. |
| B10-7 | **Bilingual templates from one catalog (`app/email/i18n.py`).** Every e-mail has a section per language, the leading one first and the other one complete as well (details, instructions, the pass button, the link, the personal-pass note), so a reader of either language has every fact; only the QR card is shown once (the second section points to "the QR code above"). The plain-text part has both languages in full, separated by a line with the second language's name. Templates are written once: macros render a section for a given language with `t(language, key, **values)`; each section carries `dir` and `lang` and aligns to its own start (`START`/`END`), so Arabic reads right to left in every client that honours HTML direction. `t` inserts the values and returns plain text, which the HTML template escapes like any other value: no translated text carries markup, and no name can break out of it. **Copy:** English keeps the wording the e-mails had (only "visitor management" gave way to the brand): the E2E suite reads `Hello <name>`, `Host: <name>`, `Department: <name>`, the purpose, the pass URL and `Your visitor <name> has arrived and checked in` from the text part, and all of them are still there. Arabic is Modern Standard Arabic for a Levantine audience; every Arabic text starts with an Arabic word (a client that takes a paragraph's direction from its first letter lays it out right to left even when a Latin name follows); second-person forms are unvowelled and read for any reader; the generic masculine is used for third persons, as Arabic interfaces do; minutes follow Arabic number agreement (`دقيقة واحدة`, `دقيقتين`, `3 دقائق`, `30 دقيقة`). | "Bilingual (Arabic RTL first, then English LTR)". One catalog keeps both languages in step: a test fails when a key lacks a language or the two have different placeholders. |
| B10-8 | **Arabic dates and times: Levantine month names, Latin digits, the company's time zone.** `الاثنين، 5 تشرين الأول 2026`, `09:00`, `10:00 – 11:00`, `22:42 – 00:42 من اليوم التالي`, short dates `الثلاثاء، 6 تشرين الأول` (Arabic has no abbreviated names). This is exactly what `Intl.DateTimeFormat('ar-JO-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })` writes (checked with Node 24's ICU: `الأربعاء، 7 تشرين الأول 2026`, no invisible marks), the format the frontend uses. Zones: `بتوقيت عمّان، UTC+3` for the zones of a fixed table of Arabic place names (the region's capitals and the zones companies there use), else `بتوقيت UTC+5:30`; English is unchanged (`Amman time, UTC+3`). The password-changed notice now shows the zone the same way instead of the IANA name. | The task. A Latin place name inside Arabic text reads poorly; the offset is unambiguous. |
| B10-9 | **Which language leads, and the subjects.** E-mails to **visitors** (invitation, reschedule, cancellation) lead with the company's `default_language`, and their subject names both languages, the company's first: `زيارتك إلى موضوع يوم الاثنين، 5 تشرين الأول 2026 \| Your visit to Mawdoo3 on Monday, 5 October 2026`; the company can only guess a visitor's language, and a visitor who reads only the other one still recognises the message. E-mails to **staff** (host arrival, password reset, password changed) lead with the recipient's `preferred_language`, else the company's default, and their subject is in that language only, as the task asks. The **test e-mail** has no company: it leads with `--language` (`ar` by default, the product's default). The Arabic text names the company by `name_ar` when it is set, else by `name`; the English text by `name`. The footer says who sent the message: "This is an automated message from Mawdoo3." when the company's name in that language is the brand's, else "... from Mawdoo3 on behalf of Other Corp."; "Please do not reply to this email." / «يُرجى عدم الرد على هذه الرسالة.» when nobody reads replies, as before. Subjects of the SMTP provider are RFC 2047 encoded words in UTF-8 (the `email` package folds them into lines under 998 characters); the stored `email_messages.subject` keeps its 300-character cut. | The task's language rules. |
| B10-10 | **Seeds.** `seed-demo` and `seed-e2e` create the demo company as `Mawdoo3`, `name_ar` «موضوع», `default_language` `ar`; the slug (`demo-company`), every seed ID and every user e-mail stay as they were. `Other Corp` (E2E's second tenant) is English by default and has no Arabic name, so the suite has a company of each kind. **Re-running a seed** on an existing company never changes users or departments and never renames a company, except that the demo company's former seed name, exactly `Demo Company` (nothing a person chose), becomes `Mawdoo3`; it fills `name_ar` only when it is NULL and sets the seed's `default_language` only while the column still holds its default (`ar`). Each change is audited as `COMPANY_SETTINGS_UPDATED` (`changed_fields`, `source: cli`, no actor) and listed as "companies updated". `create-admin` creates a company with the column defaults (Arabic, no Arabic name). | The task ("idempotent for these new fields ... do NOT rename an existing company's name automatically, except ... Demo Company"). |
| B10-11 | **The test factory makes English companies by default** (`Factory.company(default_language="en")`; `Factory.user(preferred_language=...)` is new). The suite's many assertions on English subjects (password notices, invitations through the API) keep their meaning; Arabic as the default is covered by the language tests, the seeds and the migration test, which see the column's real default. | Changing 30 assertions to Arabic would have tested the same thing less legibly. |
| B10-12 | **Tests** (all new ones listed; the updated ones assert the new brand, the second inline image and the bilingual subjects). `tests/unit/test_email_i18n.py`: every key in both languages with the same placeholders, no invisible characters or Arabic-Indic digits, every Arabic text starting with an Arabic word, the kept English wording, the helpers, minutes. `tests/unit/test_email_templates.py` (rewritten, 37): every template in both languages, parsing the rendered HTML for the leading section's `lang`/`dir` and the logo `<img>` (width, height, alt), the CIDs the HTML references equal to the attached images in every template and language, Latin digits, Levantine months, the `name_ar` fallback, staff language for four combinations, the footer's "on behalf of", brand settings, the Arabic date wording, escaping of hostile Arabic names, header injection through `name_ar` (U+2028). `tests/integration/test_preferences_api.py` (21): every role, the Me payload, refused bodies, 401, CSRF and Origin, the forced-change screen, no audit row, no write for the same value, own row only, the per-user API budget, the preference deciding a reset e-mail's language. `tests/integration/test_email_languages.py` (5): invitations of an Arabic and an English company through the API, a default-language change, the host's own language for the arrival notice. `test_departments_and_company.py` (+3 tests, +8 validation cases), `test_cli.py` (+5: an earlier `Demo Company` renamed and completed and audited once, a company someone named left alone, only a missing Arabic name filled, Other Corp moved off the default, `create-admin`), `test_migrations.py` (+3: the CHECKs as the runtime role, the downgrade guard for each kind of value, a preference written during the downgrade), `test_config.py` (+10 brand settings), `test_smtp.py` (+1: an Arabic subject sent as UTF-8 encoded words, folded, decoding to the subject; the MIME helper now checks the logo part in every delivery test), `test_send_test_email.py` (+2: `--language en`, an unknown language; the logo part and file), `test_resend.py` (+1: both attachments with their Content-IDs), `test_email.py` (+1: the outbox writes the logo file). | |
| B10-13 | **Not done, and what others must do.** (a) **E2E specs** (frontend owner): every e-mail now has two inline images and the logo comes first in the HTML, so `inlineImages(message)` returns `[brand-logo, visitor-pass-qr]`: `e2e/flows/acceptance.spec.ts:333` (`toHaveLength(1)`) and the `[0]` of `acceptance.spec.ts:334`, `invitation-failure.spec.ts:71` and `pass-outcomes.spec.ts:182` must select the image whose `cid` is `visitor-pass-qr`. The text-part assertions still hold. (b) **Frontend fixtures**: the new required response fields made `tsc -b` fail in four fixture files (`src/test/api.ts`, `src/features/admin/settingsForm.test.ts`, `src/features/admin/testRoutes.ts`, `src/features/reception/testing/receptionFixtures.ts`); the frontend builder has updated them, and `tsc -b` and `api.contract.test.ts` (62 tests) pass. (c) **The running demo** (lead): its API process still runs the old code, but Jinja reloads changed templates from disk, so it cannot render e-mails any more; before restarting it: `alembic upgrade head` and `python -m app.cli seed-demo` on `vms` (the seed renames `Demo Company` and adds «موضوع»). (d) **The root `.env`** still has `EMAIL_FROM=Visitor <...>`: the From name recipients see. Change it to `Mawdoo3 <...>` (or «موضوع»). (e) **Clients:** Outlook for Windows ignores `border-radius` and the `<style>` block (square corners, the desktop layout on phones), and some clients ignore `dir` on table cells; the text stays readable and correctly ordered by Unicode's bidirectional algorithm. Rendering was checked in Chromium at 680 and 375 px (screenshots of all seven templates in both leading languages), not in real mail clients. (f) The old product name remains in titles of project documents (`README.md`, `docs/architecture.md`, `docs/security.md`, …), which belong to the lead. | Recorded so the next owner knows. |

## Verification (B10)

Backend gate (`backend/`), run after the last change:

- `ruff check .`: clean.
- `ruff format --check .`: 245 files already formatted.
- `mypy`: no issues in 132 source files.
- `pytest`: 2646 passed and 3 skipped (the opt-in volume checks) in 260 s.
- `pytest --committed-first`: 2646 passed and 3 skipped in 321 s.

That is 297 test items more than the 2349 of the SMTP review fixes: 221 in `test_email_i18n.py` (the
catalog, per key), 21 in `test_preferences_api.py`, 5 in `test_email_languages.py`, 16 more in
`test_email_templates.py` (37), 10 brand settings in `test_config.py`, 11 in
`test_departments_and_company.py`, 5 in `test_cli.py`, 3 in `test_migrations.py`, 2 in
`test_send_test_email.py`, and one each in `test_smtp.py`, `test_resend.py` and `test_email.py`. The
contract snapshot test (`tests/unit/test_contract_snapshot.py`) passes with the regenerated snapshot
(`python -m app.contract --out ../frontend/src/types/backend-contract.json`, the command behind
`npm run contract:snapshot`); the frontend's `api.contract.test.ts` passes (62 tests) and `tsc -b` is
clean (the frontend builder had already updated its fixtures). The suite ran against throwaway databases;
afterwards the cluster holds only `postgres`, `vms` and `vms_e2e`.

Deployment files (repository root): `check_release_tree.py` OK (830 files; the logo is not an outbox
artefact); `unittest discover -s deploy/verify` 27 tests OK.

Live, against an API of this code on 127.0.0.1:8711 (`app.serve`, the outbox provider, `COOKIE_SECURE=false`)
with a throwaway database `vms_b10_smoke` (migrated to `0011`, `seed-e2e`; dropped afterwards; the demo on
8000 and 5173 was left alone): `GET /auth/me` for `admin@demo.local` returned `company` `{name: "Mawdoo3",
name_ar: "موضوع", timezone: "Asia/Amman", default_language: "ar"}` and `preferred_language: null`; the
OpenAPI title was "Mawdoo3 API"; `PATCH /auth/preferences` answered 200 with `en`, 422 with "Choose one of:
'ar' or 'en'." for `fr` and 403 `CSRF_FAILED` without the header; a visit created with an invitation was
SENT, its subject was `زيارتك إلى موضوع يوم الأربعاء، 7 تشرين الأول 2026 | Your visit to Mawdoo3 on
Wednesday, 7 October 2026`, the outbox held `<id>.html|.txt|.json`, `<id>-visitor-pass-qr.png` and
`<id>-brand-logo.png`, and the text part held everything the E2E suite reads (`Hello <name>`,
`Host: <name>`, the purpose, the pass URL). Every template was also rendered in both leading languages and
screenshotted in Chromium at 680 and 375 px (the scratch renders of this phase); the Arabic sections read
right to left with Latin digits, and the phone layout stacks the details grid.

## Hand-over (B10)

**Frontend: the exact new API surface.**

- `GET /api/v1/auth/me`, `POST /api/v1/auth/login` and `PATCH /api/v1/auth/preferences` return `Me`:
  - `user.preferred_language: 'ar' | 'en' | null` (null: follow the company);
  - `company.name_ar: string | null`;
  - `company.default_language: 'ar' | 'en'`.
- `PATCH /api/v1/auth/preferences`, body `PreferencesUpdate { language: 'ar' | 'en' }` (required), returns
  200 `Me`. Send the CSRF header like every unsafe request. Allowed while `must_change_password` is true.
  422 `VALIDATION_ERROR` with `details.fields.language` for anything else. 429 `RATE_LIMITED` only from
  the per-user API budget.
- `GET /api/v1/company/settings` (`CompanySettings`) has `name_ar: string | null` and
  `default_language: 'ar' | 'en'`; `PATCH /api/v1/company/settings` (`CompanySettingsUpdate`, admin)
  accepts `name_ar?: string | null` (the rules of `name`; blank or null clears it) and
  `default_language?: 'ar' | 'en'` (not null). Errors on them are 422 field errors on `name_ar` and
  `default_language`.
- `api.ts` has these fields and `PreferencesUpdate`; its `Language` alias is not exported (B10-3): add
  `'Language'` to `CHECKED_INDIRECTLY` in `api.contract.test.ts` if you export it.
- Error responses keep their English `message`; translate by `code` (no new code).
- E-mails: see B10-13 (a) for the E2E inline-image change. Seeds: B10-10 (`Mawdoo3` / «موضوع», Arabic;
  `Other Corp` English).
- E-mail palette, if the interface wants the same values: brand `#169897`, buttons with white text
  `#0F7675`, link text `#0B5F5E`, light teal surface `#E8F6F6`, ink `#0B1A22`, body `#3A4152`, muted
  `#5A6275`, on-ink accent `#7FD6D3`, on-ink muted `#AEB5C8` (contrast ratios in B10-6).

**Contract owner (`docs/initial-assessment.md`, not edited here): the proposed text.**

- §4 *companies*, append: "`name_ar varchar(200) NULL` (CHECK not blank; the Arabic name; `name` is the
  English or only name), `default_language varchar(2) NOT NULL DEFAULT 'ar'` (CHECK `ar`/`en`; the
  interface language of users without a preference and the leading language of visitor e-mails)."
- §4 *users*, add a row: "`preferred_language` | varchar(2) NULL | CHECK `ar`/`en`; the user's interface
  and e-mail language; NULL follows the company (revision 0011)."
- §7.2, the forced-change rule: "`must_change_password` → every endpoint except `GET /auth/me`,
  `POST /auth/change-password`, `POST /auth/logout` and `PATCH /auth/preferences` returns `403
  PASSWORD_CHANGE_REQUIRED`."
- §8 endpoint table, after `POST /auth/change-password`: "| PATCH `/auth/preferences` | auth (also while
  a password change is required) | `{language: 'ar' \| 'en'}` → `Me` (not audited) |".
- §8.1: "`type Language = 'ar' | 'en'`"; in `Me`: "`user: { …; must_change_password: boolean;
  preferred_language: Language | null }`, `company: { id: string; name: string; name_ar: string | null;
  timezone: string; default_language: Language }`"; in `CompanySettings`: "`name_ar: string | null;
  default_language: Language`" after `name`; new request "`interface PreferencesUpdate { language:
  Language }`".
- §9, replace the Templates paragraph's first sentence with: "Templates: professional table-based HTML +
  plain text, **bilingual** (Arabic and English: the leading language first and complete, then the
  other, also complete), with the brand logo inline (`cid:brand-logo`) in every message. Visitor e-mails
  lead with the company's `default_language` and carry both languages in the subject; staff e-mails lead
  with the recipient's `preferred_language`, else the company's, with the subject in that language.
  Arabic dates use Levantine month names and Latin digits in the company's time zone." and add
  "`BRAND_NAME_AR` / `BRAND_NAME_EN` name the product in e-mails."
- §10 *Visual design*: the lead's to restate for direction C (teal `#169897` from the logo) together with
  the frontend's decisions.
- §14: "**Phase 10** (SMTP delivery; brand, languages and bilingual e-mail): `docs/decisions/phase-10-backend.md`
  (S10-1 … S10-13, B10-1 … B10-13) and the frontend's phase-10 file."

---

## Review fixes (B10-14, B10-15) (2026-10-07)

The review of the brand and language work demonstrated two low-severity defects. Both were reproduced
before any change: the reviewer's Chromium screenshots and probe, and renders of the real templates in this
phase's scratch folder. Each is fixed at its cause and covered by tests that fail without the fix. B10-14
amends B10-7 ("`t` ... returns plain text"): in HTML templates `t` now returns escaped markup. B10-15
amends B10-10. Where they disagree with those entries, these win. Nothing else changed: no migration, no
new setting, no contract change (the snapshot test passes unchanged), no new dependency. The running demo
(ports 8000 and 5173, database `vms`) and the root `.env` were not touched.

| # | Decision | Reason |
|---|---|---|
| B10-14 | **Values keep their own direction inside the other language's sentences (`app/email/bidi.py`).** **Cause:** `translate()` inserted names into Arabic sentences as plain text, and the details grid printed each value in a right-to-left cell with no direction of its own. The Unicode bidirectional algorithm then joined a value's neutral characters to the sentence: the full stop of "Quarterly budget review." and of "John Smith Jr." moved to the wrong end, and `2001:db8:85a3::8a2e:370:7334` read as `db8:85a3::8a2e:370:7334:2001`. **HTML:** `t` is now context-aware (`pass_eval_context`). In an HTML template it escapes the catalog text and each value on its own (`Markup.format`), and wraps each isolated value in `<span dir="ltr">` or `<span dir="rtl">`. In a plain-text template it wraps each line of the value in FSI (or LRI) and PDI, the only isolation plain text has. A line break ends every isolate (UAX #9 X8), which is why a multi-line value is wrapped line by line. The direction of a span is computed by `direction_of`: the first strong character, skipping isolated runs (UAX #9 P2/P3). That is what `dir="auto"` and FSI do in the client. Computing it on the server keeps it right in clients that know neither: `dir` on a span dates from HTML 4, and Word-based Outlook writes `<span dir=LTR>` itself. **Which sections:** a right-to-left section isolates every value, because there even Latin letters and digits are reordered. A left-to-right section isolates only a value that contains a right-to-left character (classes R, AL, AN) or an explicit direction control. Without one, every character of a left-to-right sentence resolves to level 0, so nothing can move. As a result, the English text with Latin values is byte for byte what it was, including the strings the E2E suite reads (`Hello <name>`, `Host: <name>`, `Department: <name>`, the purpose, `Your visitor <name> has arrived and checked in`). An Arabic name in an English sentence is isolated (`Hello <span dir="rtl">هند</span>,`). **Which values** (`i18n.py`, checked by a test so a new placeholder cannot go unclassified): names, companies, the brand and the sender are isolated in their own direction (`ISOLATED_VALUES`). `ip` and `url` are isolated as left to right (`LEFT_TO_RIGHT_VALUES`), as the reviewer asked for the IP. Dates, times, zones and durations (`FORMATTED_VALUES`) are inserted as they are: the service writes them in the sentence's own language, and an Arabic time range must read right to left with its line. Isolating `10:00 – 11:00` as left-to-right text would put its end first. Measured in Chromium: 10:00 is drawn to the right of 11:00. A placeholder in none of the sets is isolated, the safe side. **Details grid:** every value is a block with `dir` from `direction_of`, and so is the note beside a label. In the text part, the user values of "Label: value" lines go through the new `isolate(lang)` filter (host, department, address, visitor, company, invited by, purpose, reason). **Footers** are now `Sentence`s (catalog key and values) that the templates render with `t`, so the company named in "on behalf of" is isolated too. **Attributes:** the QR code's `alt` uses `t_text` (isolate characters, never markup inside an attribute). **Subjects** still use `translate` and carry no isolate characters, as the reviewer asked. The stored `email_messages.subject` is unchanged. **Safety:** a value cannot leave its span, because it is escaped inside it (tested with `</span><a href=…>`). A purpose, reason or address may hold direction controls (multi-line fields allow them, SEC-10). An override left open in one now ends at its value's PDI, or at the end of its span, instead of reordering the rest of the sentence. **Verified in Chromium** with the reviewer's values: the Arabic grid shows "Quarterly budget review." with its full stop at its right end (glyph x 583 against 399 for "Quarterly"). The greeting reads «مرحباً John Smith Jr.،». The full stop of "ACME Inc." stays at its end in the Arabic sentence and in the footer. The security notice shows `2001:db8:85a3::8a2e:370:7334` as typed. All seven templates were rendered in both leading languages with mixed-script values: there is no markup inside any attribute, isolate characters are balanced in every text part, and no subject has one. | Review finding (low, demonstrated). The reviewer offered two options: a Jinja helper that returns markup with `<bdi>` or `<span dir="auto">`, or FSI/PDI around values. Both are used, each where it works best: computed spans in HTML, isolate characters in plain text and attributes. `<bdi>` and `dir="auto"` were not used because Word-based clients and some sanitisers know neither. |
| B10-15 | **A seed never overrides a field a person changed.** **Cause:** `Seeder.complete_company` treated `default_language = 'ar'` as "never chosen", because it is the column's default and what an earlier seed left. It treated a NULL `name_ar` the same way. A company administrator's deliberate choice of either value was therefore undone by the next `seed-demo` or `seed-e2e`, and audited as a CLI change. **Fix:** before the back-fill, the seeder reads the fields a person has changed for the company (`AuditLogRepository.fields_changed_by_people`). These are the `changed_fields` of every `COMPANY_SETTINGS_UPDATED` row about the company that has an actor. A field named there is left alone: `name` (the `Demo Company` rename), `name_ar` and `default_language`. Rows the seed writes itself have no actor, so they do not count. Each field is decided on its own: an administrator who changed only the address still gets the Arabic name and language back-filled. The audit trail is append-only, protected by a trigger, and never pruned, so the record of a choice cannot disappear. **Unchanged:** a plain re-run is idempotent (no change and no audit row), and a database seeded before Phase 10 still gets `Mawdoo3`, «موضوع» and Other Corp's English. **Limit:** saving a setting with the value it already had writes no audit row (the settings service audits changed fields only), so that cannot count as a choice. It also changes nothing, so the seed acts as it would have. | Review finding (low, demonstrated). The reviewer's first option (back-fill only while the name is one of `former_names`) was not taken. Other Corp has no former name, so it would never move off the column default on a database seeded before Phase 10, which B10-10 intends. The audit rule fixes both demonstrated cases and keeps that. The seed commands are refused in production (`APP_ENV=production`), so only development, demo and E2E data are affected. |

### Tests (B10-14, B10-15)

- `tests/unit/test_email_bidi.py` (new, 16):
  - `direction_of`, 10 cases: Latin, Arabic, mixed, digits first, no strong character, a mark, an isolated run, an isolate left open;
  - `needs_isolation` in each direction;
  - plain-text isolation: FSI, LRI, RLI, line by line with CRLF and empty lines, an override left open;
  - HTML isolation and escaping, including `</span><script>`;
  - every placeholder of the catalog in exactly one set;
  - `translate_text` and `translate_html` on the IPv6 notice: names isolated, dates not; English with Latin values equal to `translate`; an Arabic name in English isolated; subjects untouched;
  - HTML escaping of the catalog and of values.
- `tests/unit/test_email_templates.py` (+6, now 43):
  - the reviewer's invitation (greeting, booker, host, company, footer, `alt` with isolate characters and no markup, subject without isolates);
  - the Arabic details grid (purpose, host and date spans with their `dir`, the note, the text part's "Label: value" lines, an address line by line, dates and times not isolated);
  - the host arrival to an Arabic reader (visitor, company);
  - the IPv6 security notice;
  - English sections keep Latin values exactly (the E2E strings) and isolate an Arabic name;
  - an isolated value cannot break out of its span.

  The helpers `_plain` and `_read` now read the text a reader sees: isolating spans dropped, isolate characters removed. The existing wording assertions use them.
- `tests/integration/test_email_languages.py`: the Arabic greeting and arrival sentences are asserted in their isolated form, through the API.
- `tests/integration/test_cli.py` (+4, now 26):
  - Other Corp's administrator chooses Arabic and clears the Arabic name, and `seed-e2e` keeps both: the reviewer's case;
  - the demo's administrator clears «موضوع» and `seed-demo` keeps it cleared: the reviewer's case;
  - `Demo Company` typed back in the settings is not renamed;
  - an administrator's change to another field does not stop the back-fill.

  The first two fail on the previous `complete_company` (checked by reverting it): `('Other Corp', None, 'en')` and `('Mawdoo3', 'موضوع', 'ar')`.

### Verification (B10-14, B10-15)

Backend gate (`backend/`), run after the last change:

- `ruff check .`: clean.
- `ruff format --check .`: 247 files already formatted.
- `mypy`: no issues in 133 source files.
- `pytest`: 2672 passed and 3 skipped (the opt-in volume checks) in 259 s.
- `pytest --committed-first`: 2672 passed and 3 skipped in 269 s.

That is 26 test items more than the 2646 of B10. The suite ran against throwaway databases on
localhost:5433; `VMS_TEST_*` pointed at the server's `postgres` database, so `vms` was never connected
to. Afterwards the cluster holds only `postgres`, `vms` and `vms_e2e`. The contract snapshot test passes
unchanged (no API change).

### Hand-over (B10-14, B10-15)

- **E2E (frontend):** nothing to change. The English part of every text body is byte for byte what it
  was for Latin values, and the suite pins its companies to English. The HTML still references
  `cid:brand-logo` and `cid:visitor-pass-qr` exactly as before.
- **The running demo (lead):** as B10-13 (c) says, its API process runs the code from before Phase 10,
  while Jinja reads templates from disk. The templates now also use the `isolate` and `direction` filters
  and footer sentences, which that old process does not provide. Restart it, after
  `alembic upgrade head` and `python -m app.cli seed-demo` on `vms`, before it sends e-mail. The restart
  was not done here: the demo must not be stopped by this work.
- **Not done:** a name that ends with a full stop and closes a sentence gives two full stops ("on behalf
  of ACME Inc.."). This was already so before this change, and the review did not report it. Rendering
  was checked in Chromium, not in Outlook for Windows (B10-13 (e)).

---

# Phase 10 — backend decisions (product name, Mawdoo3 palette, field codes, Arabic demo data)

Date: 2026-10-07. Scope: `backend/` (settings, the e-mail service, catalog, templates and logo, the 422 field
codes in `core/`, the schemas and the services, the seed, tests), `scripts/` (`email_logo.py`, new; the
operator messages of `backup.*` and `restore.*`), `deploy/` (the headers of `nginx.conf`,
`vms.conf.template`, `10-vms-roles.sh` and `backend.env.example`), the header of `docker-compose.yml`,
`.env.example`, `docs/api.md` §4, the contract snapshot (`frontend/src/types/backend-contract.json`) and this
file. The product decisions behind it (from the user, 2026-10-07): the product is «زوار موضوع» / "Mawdoo3
Visitors" while the company (tenant) stays «موضوع» / "Mawdoo3"; mawdoo3.com's own colours; no explanatory
notes; direction C; Arabic and English. These entries amend B10-5, B10-6, B10-7, B10-9 and B10-10 where they
differ. The root `.env`, the running demo (ports 8000 and 5173) and the database `vms` were not touched.

**Contract and configuration.** No migration, no endpoint, no request or response model change, no new error
code and no new audit action. Additive: a 422 `VALIDATION_ERROR` now carries `details.field_codes` beside
`details.fields`, and the contract snapshot has a new top-level section `field_error_codes` (the vocabulary
with each code's parameter names). Two settings, `PRODUCT_NAME_AR` (default «زوار موضوع») and
`PRODUCT_NAME_EN` (default "Mawdoo3 Visitors"), both in `.env.example` and `deploy/env/backend.env.example`.
`EMAIL_FROM`'s default is now `Mawdoo3 Visitors <no-reply@localhost>`; the OpenAPI title is "Mawdoo3 Visitors
API". `seed-demo` names its users and departments in Arabic; `seed-e2e` is unchanged. No new dependency.
`ScanWarning` already carries a code (`OUTSIDE_SCHEDULED_TIME`, `OVERSTAYED`): nothing to add there.

| # | Decision | Reason |
|---|---|---|
| B10-16 | **The product, the company and the brand are three names, with one rule for every e-mail (amends B10-5 and B10-9).** New settings `PRODUCT_NAME_AR` / `PRODUCT_NAME_EN` sit beside `BRAND_NAME_AR` / `BRAND_NAME_EN`, with the same validation (NFC, trimmed, 1–60 characters, one line of visible text, the value never echoed). **The product** (this software) is who sends every message: the footer ("Sent by Mawdoo3 Visitors." / «أُرسلت عبر زوار موضوع.»), the first line of every plain-text part (`Mawdoo3 Visitors \| زوار موضوع`), `EMAIL_FROM`'s default display name, the test e-mail's text and its subject's fallback sender, and the OpenAPI title. **The company** (the tenant: `companies.name`, `name_ar`) is whose visit or account it is: subjects, headings, sentences, and "on behalf of <company>" in the footer. **The brand** (the organisation whose logo heads every e-mail: Mawdoo3, «موضوع») is the logo's text alternative, which says what the image says, and the one company whose e-mails need no "on behalf of": the product's name already names it. `is_brand_company`: one of the company's names, in either language, equals one of the brand's names, ignoring case; then neither language adds it, so Mawdoo3 without an Arabic name never gets «… نيابةً عن Mawdoo3». **Footer wording:** EN "Sent by {product} on behalf of {company}." / "Sent by {product}."; AR «أُرسلت عبر {product} نيابةً عن {company}.» / «أُرسلت عبر {product}.»; then, as before, "Please do not reply to this email." when nobody reads replies. It replaces "This is an automated message from …": shorter, and the wording of direction C's mockup («مرسل عبر … نيابةً عن …»). The test e-mail has no company: "Sent by Mawdoo3 Visitors."; its explanatory footer (the `send-test-email` command) is gone. | Decision 1. The brand settings were kept for the organisation instead of being renamed to mean the product: the logo is Mawdoo3's whatever the product is called, and without the brand's name the footer could not tell that "Sent by Mawdoo3 Visitors on behalf of Mawdoo3" repeats itself. A deployment for another organisation sets all four. |
| B10-17 | **The e-mails in mawdoo3.com's palette, with the white logo baked onto the header's teal (amends B10-6's palette and light header; layout, client safety, sizes and fonts stay).** **Header:** a band of teal `#188086` (mawdoo3.com's side navigation, the family of the app shell) with the white wordmark, a 4-px turquoise `#27B5BB` rule under it, and the kind of message as a pill: white with teal text, or yellow `#F7B916` with ink text for a change the reader must notice (rescheduled, cancelled, security notice). **Text:** ink `#1E2A32` (a deep slate of `#33444E`) for headings and values, slate `#33444E` for text, muted `#5A6872`, teal `#146E73` (the accessible step of the teal family) for the language eyebrow and the outline button. **Direction C's dark pass:** the visitor pass and the test e-mail's sample are a dark slate card `#1E2A32` with a turquoise label, a white title, the check-in window in 26-px figures and a turquoise button with ink text; the arrival steps are ink squares with turquoise figures. **Notices** are panels with a coloured edge at the start of the line: light turquoise `#E5F6F7` for what still holds (the QR code of a rescheduled visit, "please meet your visitor", the reachable pass address of the test e-mail) and light yellow `#FEF5DC` for what no longer does (a cancelled pass, a password change the reader did not make). Page `#F1F1F1`, footer `#F8F8F8` (mawdoo3.com's greys). **Contrast (WCAG 2.x), every text pair AA or better:** white on teal `#188086` 4.70:1 (the primary button; the header carries only the logo and the pill); teal text `#146E73` on white 5.99:1, on the footer 5.64:1; ink on white 14.66:1; slate on white 10.11:1; muted on white 5.74:1, on the footer 5.41:1, on light turquoise 5.16:1; on the dark card white 14.66:1, `#B8C4CB` 8.24:1, turquoise 5.87:1; ink on turquoise 5.87:1 (the pass button), on yellow 8.31:1 (the pill), on light turquoise 13.16:1, on light yellow 13.48:1; slate on light turquoise 9.08:1, on light yellow 9.29:1. White on turquoise would be 2.50:1, so turquoise is only ever a fill behind ink, a rule, an edge or text on the dark card. **The logo:** `assets/brand-logo.png` is now `frontend/public/brand/logo-white.png` composited onto `#188086`: 462 × 149, opaque 8-bit RGB, 18,914 bytes, SHA-256 `5699cc62168cae2c0a036b6fa21579c35d864b49435c6eac0135eab5130ec345`, written by `scripts/email_logo.py` (standard library only, reproducible; `--check` compares). A transparent white logo would vanish where a mail client recolours or inverts the band (Gmail's iOS dark mode inverts dark backgrounds as well); with the teal baked in it then shows as a teal tile carrying the wordmark. Same size (124 × 40 CSS px), Content-ID and file name, so the three providers and the E2E reader of inline images are unchanged; the `<img>` also styles its `alt` text white and bold for clients that block images. | Decisions 2 and 4: "Mawdoo3's colours", the navy gone, the shell's teal with the white logo, turquoise never under small white text, slate text, yellow for attention. |
| B10-18 | **A stable code per field error: `details.field_codes` (additive).** `details.fields` keeps `{path: message}` exactly as before; for the same paths `details.field_codes` maps each to `{"code": <code>, "params": {...}}`, where `params` always holds exactly the parameters the code declares (`{}` for most). **Where codes come from:** Pydantic's error types map to codes in `core/errors.field_problem` (with the schema's limit: `too_long`/`max`, `too_small`/`min`, `invalid_choice`/`choices` read from Pydantic's context); every schema validator raises `FieldValueError(problem)`, a ValueError that carries its `FieldProblem` (code, English message, parameters) and that Pydantic keeps in `ctx["error"]`; model validators build the same error at a location (`_field_error`); the services collect `FieldProblem`s in `FieldErrors` or raise `ValidationFailed` with them, so a message is written once next to its rule, together with its code, and mypy refuses a plain message where a problem is expected. **Vocabulary** (`core/field_errors.FieldCode`, 60 codes, one per distinct meaning; the English message of a code may vary with the context, e.g. "Email address is too long." and "Enter at most 200 characters." are both `too_long`): see the hand-over for the list with parameters, also published in the snapshot (`field_error_codes`) and in `docs/api.md` §4.4. Generic codes for the shape of input (`required`, `not_allowed`, `invalid_*`, `too_short`/`too_long`, `too_few_items`/`too_many_items`, `too_small`/`too_large`, the date ranges, control, direction and line-break characters, e-mail, domain, phone, time zone, `not_found`, `duplicates`), and specific ones for the product's rules (visit schedule, walk-in, lost pass, re-invitations, password policy). The password policy's length rules use `too_short`/`too_long` with its limits (12, 128); "Describe the reason for this walk-in." is `required`; a null where null is not allowed is `required`. `invalid` is the fallback (an uncoded validator keeps its message under it): no request model produces it, which a test checks by validating every field of every request body and query model, nested models included, with 24 hostile values. Request models use inclusive bounds only (`ge`/`le`; a test checks that the schemas have no exclusive bound), so `too_small`/`too_large` say exactly what their limit is. | The frontend matched the English wording (`frontend/src/i18n/fieldMessages.ts`) and broke silently on any rewording. Codes in the payload rather than a separate endpoint or message ids: the client already reads `details`, and nothing else changes for it. A parallel map rather than objects inside `fields`: additive, so clients that read `fields` as strings keep working. `ctx["error"]` carries the code through Pydantic without inventing error types that could collide with Pydantic's own (`too_long` is Pydantic's name for a list that is too long). |
| B10-19 | **E-mail copy without explanatory filler, and one full stop per sentence (amends B10-7's copy).** Removed, in both languages: the invitation's "Here are the details of your visit.", "Please present this QR code at reception when you arrive." under the card's own "Show this QR code at reception", "If the QR code is not displayed, open your visitor pass in your browser:" above the button, the offline tip panel, and the text part's "The QR code is attached to the HTML version of this email…" (now "Show the QR code of your visitor pass at reception when you arrive. Open your pass here:"); the reschedule's "These are the new details." and "Please present it at reception…"; the reset's "Select the button below to choose a new password."; the password notice's "If you made this change, you do not need to do anything."; the test e-mail's explanations of its sample and its footer. Shortened: "If you did not request this, ignore this email. Your password will not change." Kept, because the reader needs them: the details grid, the pass, its window and zone, the arrival steps, who to contact, the pass link and its copyable address, "This pass is personal. Please do not forward this email.", the cancelled pass, the security notice's call to act. Every string the E2E suite reads from the text part is unchanged (`Hello <name>`, `Host: <name>`, `Department: <name>`, the purpose, the pass URL, the cancellation reason, `Your visitor <name> has arrived and checked in`). **Full stops:** a catalog sentence drops the full stop that follows a value which already ends with `.`, `!`, `?`, `…` or `؟` (`catalog_text`, for subjects, text, HTML and attributes alike), wherever the value is: "on behalf of ACME Inc." and the preheader's "at ACME Inc. Show the QR code …" no longer show "..". | Decision 3 for the e-mails: "remove purely explanatory filler where it does not serve the recipient"; the B10-15 note's double full stop. |
| B10-20 | **`seed-demo` in Arabic, `seed-e2e` unchanged.** `seed-demo` creates the demo company's users as أمل حداد (admin), عمر خليل, لينا صالح, رامي ناصر, دينا فرح and نور عباس, and its departments as المكتب التنفيذي، المالية، تقنية المعلومات، العمليات، الموارد البشرية; e-mail addresses, phones, roles and every seed ID are as before. `SeedDepartment` separates the `key` (the English name, from which the seed ID is derived, `seed_id(slug, "department", key)`) from the `name` it is given, and a department is now found by its seed ID first (whatever it is called), then by name (one a person created), else created. `seed-e2e` uses `E2E_DEMO_COMPANY`, the same company with the English names, so a fresh `vms_e2e` gets exactly the rows and audit rows it got before. **Re-running `seed-demo` on a database seeded earlier** renames a seed user or department only while its name is exactly an earlier seed's English name (`former_names`) and no person changed it: no USER_UPDATED or DEPARTMENT_UPDATED row with an actor names `full_name` or `name` (B10-15's rule), and for a department no other department already has the Arabic name. Each rename is audited like a change in the administration pages, without an actor (`{"changed_fields": ["full_name"], "source": "cli"}`, DEPARTMENT_UPDATED with `["name"]`), refreshes the name snapshots of the SCHEDULED visits (D-17, as a rename by a person does; checked-in visits keep theirs) and is listed: `users updated: <addresses>` and `departments updated: <slug>/<key>` (ASCII only: a Windows console in code page 1252 cannot print Arabic). `seed-e2e` knows no former names and never renames the Arabic names back. | Decision 5 and the task: the demo company is Arabic by default, its people and departments should read naturally in Arabic; E2E reads the English names. |
| B10-21 | **Operator-visible names.** "Visitor Management" is gone from the operator-visible strings outside the docs: the headers of `.env.example`, `deploy/env/backend.env.example`, `deploy/nginx/nginx.conf`, `deploy/nginx/templates/vms.conf.template`, `deploy/postgres/initdb/10-vms-roles.sh` and `docker-compose.yml`, and the messages of `scripts/backup.ps1`/`.sh` ("is $Database the Mawdoo3 Visitors database?") and `scripts/restore.ps1`/`.sh` ("… is not a Mawdoo3 Visitors archive"). Internal identifiers stay (`vms` file names, roles, databases, cookies, `VMS_*` variables, Message-IDs). `docs/*.md` and `README.md` are left to the docs phase (hand-over). | Decision 1: "never Visitor Management". |

### Tests (B10-16 to B10-21)

- `tests/unit/test_field_codes.py` (new, 78):
  - the vocabulary: snake_case, every code's parameters sorted and published, the snapshot equal to it;
  - a `FieldProblem` refuses parameters its code does not declare; `ValidationFailed` gives messages and
    codes for the same paths;
  - **every field of every request body and query model** (the snapshot's 20 requests and 8 queries, and
    the CLI's `AdminBootstrap`), entered through each tag of the check-in and check-out unions, and every
    field of a nested request model (`visitor` of a visit or walk-in), with 24 hostile values and an
    unknown field: no problem is the generic `invalid`, and each carries exactly its code's parameters;
  - 29 cases of a code with its parameters (the visitor-source rule, the walk-in note, enumerations with
    their `choices`, e-mail, phone, direction controls, line breaks, lengths, offsets, the date and
    date-time ranges, the date range, a multi-value filter, page bounds, the report range, duplicate and
    missing roles, the e-mail length, the domain, a null, the grace minutes, the language, an audit
    filter's format);
  - the English messages are unchanged; an uncoded validator falls back to `invalid` with its message;
    request models have no exclusive bound;
  - a source check of `app/schemas/*.py` and `app/core/text.py`: every `raise` is a coded error.
- `tests/integration/test_field_codes_api.py` (new, 6): through the API, `details` has exactly `fields` and
  `field_codes` with the same paths: schema problems with their limits; the visit rules of the service
  (`end_not_after_start` with `department_inactive` together, `visit_too_long`, `too_far_ahead`, `not_found`,
  `host_unavailable`); a walk-in's expected end; the password policy (`too_short` with `min: 12` and its
  unchanged English message, `password_common`, `password_unchanged`); `invalid_timezone`; the
  preference's `invalid_choice`; query problems; invalid JSON.
- `tests/unit/test_email_design.py` (new, 12): the logo is opaque, 462 × 149, every pixel a mix of white and
  the header teal, and exactly what `scripts/email_logo.py` writes from the frontend's white logo; every
  template in both leading languages has the teal header and the turquoise rule, none of the retired
  colours, and only ink text on turquoise; the yellow pill exactly for rescheduled, cancelled and the
  security notice; the cancelled pass and the call to act in a yellow notice.
- `tests/unit/test_email_templates.py` (+5, now 48): the footer names the product and the company only when
  it is not the brand's (both languages, text and HTML, and the plain text starts with the product); the
  brand's own company recognised by any of its names (4 cases); one full stop after "ACME Inc."; the
  product and the brand from the settings, the logo's `alt` being the brand; the invitation without the
  removed filler.
- `tests/unit/test_email_i18n.py`: the removed keys are gone; one full stop after a value ending with `.`,
  `!`, `?` or `…` (4 cases) and the ordinary full stop otherwise. The per-key tests follow the catalog (11
  keys removed, 3 added), so the file has 18 items fewer (309).
- `tests/unit/test_config.py` (+5): the product's defaults, `EMAIL_FROM`'s default, trimming, and four
  refused product names. `tests/unit/test_contract_snapshot.py` (+1): `field_error_codes`.
  `tests/integration/test_http_behaviour.py` (+1): the OpenAPI title.
- `tests/integration/test_cli.py` (+4, now 30): `seed-demo` creates the Arabic names with the English keys'
  seed IDs; `seed-e2e` keeps the English names and writes no rename; `seed-demo` after `seed-e2e` renames
  6 users and 5 departments, audited without an actor, refreshes a SCHEDULED visit's host and department
  snapshots, lists them, and a second run changes nothing; a name a person set (even back to the English
  seed name), a department name taken by another department and Other Corp's users are left alone;
  `seed-e2e` after `seed-demo` neither duplicates nor renames back.
- Updated for the new behaviour: `test_errors.py` (the 422 details), `test_passwords.py` (the policy returns
  a `FieldProblem`), `test_reception_rules.py`, `test_service_helpers.py`, `test_schemas.py`,
  `test_email.py`, `test_http_behaviour.py` and `test_query_contract.py` (exact `details`), and
  `test_smtp.py` (a sender without an address no longer spelled "Visitor Management").

Each fix was undone on its own while the rest stayed, its tests failed, and the file was restored:

| Fix undone | Tests that failed |
|---|---|
| one full stop after a value that ends a sentence | 6 |
| the brand's own company needs no "on behalf of" | 6 |
| the product's name in the footer | 6 |
| `field_codes` in the 422 details | 10 |
| `choices` read from Pydantic's context | 3 |
| a validator raising an uncoded ValueError (the phone rule) | 8 |
| a user's rename by a person respected | 1 |
| a department's rename by a person respected | 1 |
| a department name taken by another | 1 |
| snapshots refreshed by a seed rename | 1 |
| `seed-e2e` using the Arabic spec | 3 |
| departments found by their seed ID | 3 |
| the OpenAPI title from the product | 1 |
| the old teal logo packaged again | 2 |

### Verification (B10-16 to B10-21)

Backend gate (`backend/`), run after the last change:

- `ruff check .`: clean.
- `ruff format --check .`: 251 files already formatted.
- `mypy`: no issues in 134 source files.
- `pytest`: 2872 passed and 3 skipped (the opt-in volume checks) in 265 s.
- `pytest --committed-first`: 2872 passed and 3 skipped in 274 s.

The baseline at the start of this work was 2778 passed and 3 skipped (both orders; the B10-14/15 record
above says 2672: later catalog work between that record and this one added the difference). This work
adds 94 items. The suite ran against throwaway databases on localhost:5433 with `VMS_TEST_*` pointing at
the server's `postgres` database, so `vms` was never connected to; its throwaway databases were all dropped.
The cluster also holds four databases this work did not create and did not touch (`vms_adminpass_p10b`,
`vms_analytics_p10b`, `vms_receptionpass_p10b`, `vms_visits_p10v`).

- Contract snapshot: regenerated with `python -m app.contract --out ../frontend/src/types/backend-contract.json`;
  `tests/unit/test_contract_snapshot.py` passes. The only change is the new top-level `field_error_codes`.
  The frontend's `api.contract.test.ts` now fails in exactly one test, "compares every section of the
  backend snapshot" (61 of 62 pass), until the frontend handles the new section (hand-over).
- Deployment files (repository root): `unittest discover -s deploy/verify -p "test_*.py"` 27 tests OK;
  `check_release_tree.py` OK (871 files); `check_nginx_headers.mjs` 7 headers in sync.
- `python scripts/email_logo.py --check`: up to date.
- **Rendering:** all seven templates in both leading languages (Arabic: Mawdoo3 itself, Arabic names; English:
  "ACME Inc.", which ends with a full stop and is not the brand) rendered with the real service and
  screenshotted in Chromium at 680 and 375 px: 28 screenshots, with the rendered HTML and text parts, in
  the session scratchpad's `phase10b-shots/email/`. No horizontal overflow at either width; Arabic sections
  read right to left with Latin digits; the details grid stacks on the phone; the footer reads "Sent by
  Mawdoo3 Visitors." for Mawdoo3 and "Sent by Mawdoo3 Visitors on behalf of ACME Inc." (one full stop)
  otherwise. Not checked in real mail clients (B10-13 (e) still applies).

### Hand-over (B10-16 to B10-21)

**Frontend: field codes (B10-18).** Every 422 `VALIDATION_ERROR` now has, beside `details.fields`, a map with
exactly the same keys:

```ts
/** A 422's machine code per field (backend B10-18); `params` holds exactly the code's parameters. */
export type FieldErrorCode =
  | 'required' | 'not_allowed' | 'invalid_json' | 'invalid' | 'invalid_text' | 'invalid_format'
  | 'invalid_choice' | 'invalid_id' | 'invalid_integer' | 'invalid_number' | 'invalid_boolean'
  | 'invalid_list' | 'invalid_object' | 'invalid_date' | 'invalid_datetime' | 'offset_required'
  | 'offset_not_allowed' | 'too_short' | 'too_long' | 'too_few_items' | 'too_many_items' | 'too_small'
  | 'too_large' | 'date_out_of_range' | 'datetime_out_of_range' | 'out_of_range' | 'unstorable_value'
  | 'control_characters' | 'bidi_controls' | 'line_breaks' | 'invalid_email' | 'invalid_domain'
  | 'invalid_phone' | 'invalid_timezone' | 'duplicates' | 'end_before_start' | 'not_found'
  | 'host_unavailable' | 'department_inactive' | 'visitor_required' | 'visitor_both'
  | 'end_not_after_start' | 'visit_too_long' | 'end_in_past' | 'start_in_past' | 'too_far_ahead'
  | 'range_too_long' | 'expected_end_in_past' | 'check_out_before_check_in' | 'check_out_in_future'
  | 'walk_in_expected_visit' | 'walk_in_during_window' | 'walk_in_before_window' | 'walk_in_needs_record'
  | 'too_many_reinvitations' | 'password_is_email' | 'password_common' | 'password_guessable'
  | 'password_personal' | 'password_unchanged'

export interface FieldErrorCodeEntry {
  code: FieldErrorCode
  params: Record<string, number | string | string[]>
}

export interface ValidationErrorDetails {
  fields?: Record<string, string>
  field_codes?: Record<string, FieldErrorCodeEntry>
}
```

- **Parameters** (all other codes have `{}`): `invalid_choice` `choices: string[]` (the API's own values,
  e.g. `["ar","en"]`); `too_short`, `too_few_items`, `too_small` `min: number`; `too_long`,
  `too_many_items`, `too_large` `max: number`; `date_out_of_range`, `datetime_out_of_range` `min`, `max`
  (`"1900-01-01"`, `"9998-12-31"`); `visit_too_long` `max_hours` (24); `too_far_ahead` and
  `range_too_long` `max_days` (365, 366); `walk_in_before_window` `time` (`"HH:MM"`, company time);
  `too_many_reinvitations` `count`, `limit`. The snapshot's `field_error_codes` lists them per code.
- **Translate by code**: `catalogText('errors', 'fieldCodes.<code>', params)` (or the group name you choose)
  when `field_codes[path]` exists, else the old message matching, else the server's message (an older
  server). `walkInReason` is now `required` on `reason_note`, the password length rules are
  `too_short`/`too_long` with `min: 12` / `max: 128`, "Email address is too long." is `too_long` with
  `max: 320`, "This field cannot be null." is `required`. New to the frontend's table:
  `password_unchanged`, `offset_required`, `offset_not_allowed`, `out_of_range`, `unstorable_value`. Not
  field codes (they are 409s): "A department with this name already exists." (`CONFLICT`) and the
  registered-visitor message (`VISITOR_EXISTS`).
- **Contract test** (`src/types/api.contract.test.ts`): add `'field_error_codes'` to `HANDLED_SECTIONS`
  (sorted, after `error_codes`), `'FieldErrorCode'` and `'FieldErrorCodeEntry'` to `CHECKED_INDIRECTLY`, the
  `field_error_codes: Record<string, string[]>` member to `BackendContract`, and a test
  `expect(stringLiterals(api, 'FieldErrorCode')).toEqual(Object.keys(contract.field_error_codes).toSorted())`.
  A catalog test can check that each `fieldCodes.<code>` text uses exactly the placeholders
  `contract.field_error_codes[code]` lists, in both languages.
- `ScanWarning` already has `code` (`OUTSIDE_SCHEDULED_TIME` | `OVERSTAYED`): translate by it.

**Frontend: names and colours.**
- The product is `PRODUCT_NAME_*` on the server, «زوار موضوع» / "Mawdoo3 Visitors" by default; the API does
  not expose it (a static product name belongs in the frontend's catalog). The company is
  `me.company.name` / `name_ar` as before.
- E-mail palette (B10-17), if the interface wants the same values: header and primary `#188086` (white
  4.70:1), turquoise `#27B5BB` (fills behind ink only, 2.50:1 with white), ink `#1E2A32`, slate `#33444E`,
  muted `#5A6872`, teal text `#146E73` (5.99:1 on white), dark card `#1E2A32` with `#B8C4CB` muted
  (8.24:1), notices `#E5F6F7` / `#FEF5DC`, yellow `#F7B916` with ink (8.31:1), greys `#F1F1F1` / `#F8F8F8`.
- E2E: nothing to change. The text parts keep every string the suite reads, the HTML still references
  `cid:brand-logo` before `cid:visitor-pass-qr`, and `seed-e2e` creates exactly what it did.

**The running demo (lead).** As B10-13 (c): the demo's API process runs older code while Jinja reads the
templates from disk; the new templates need `product` in their context, which that process does not
supply, so it cannot render e-mails until it is restarted. Before restarting: `alembic upgrade head` (no new
revision here) and `python -m app.cli seed-demo` on `vms`, which now also renames the six demo users and
five departments to Arabic (audited, listed as updated). The root `.env` still sets `EMAIL_FROM` with an
older display name: change it to `Mawdoo3 Visitors <...>` (the setting overrides the new default). None of
this was done here: the demo and the root `.env` are off limits to this work.

**Docs owner.** `README.md` §10 (the `EMAIL_FROM` default is now `Mawdoo3 Visitors <no-reply@localhost>`;
add `PRODUCT_NAME_AR` / `PRODUCT_NAME_EN` to the settings table), `docs/development.md` (seed-demo is
Arabic, seed-e2e English; `scripts/email_logo.py`), `deploy/README.md` and the titles of the project
documents still say "Visitor Management". `docs/api.md` §4 was updated here (§4.1 and the new §4.4).

**Contract owner (`docs/initial-assessment.md`, not edited here).** §8.2, the 422 row: "`details.fields:
{path: message}` and `details.field_codes: {path: {code, params}}` (the vocabulary is the snapshot's
`field_error_codes`, B10-18)". §9: "The footer says who sent the message: the product (`PRODUCT_NAME_*`),
on behalf of the company unless it is the brand's own; the header is the white logo on teal `#188086`."
§14: add B10-16 … B10-21 to the Phase 10 line.

---

# Phase 10 — backend final touches: the administrator's Arabic name, the product in the image labels (2026-10-08)

Scope: `backend/app/email/i18n.py` (one Arabic sentence and the module docstring), `backend/Dockerfile` (labels and header),
`backend/pyproject.toml` (description), `tests/unit/test_email_i18n.py`, and, at the repository level, `frontend/Dockerfile`'s
labels, `deploy/verify/smoke_test.py`'s help line and the new `deploy/verify/test_brand_names.py` (recorded in the frontend file
as F10-final-1 and F10-final-2). No migration, endpoint, setting, contract or dependency change. The root `.env`, the running
demo (ports 8000 and 5173) and the database `vms` were not touched.

| # | Decision | Reason |
|---|---|---|
| B10-22 | **One Arabic name for the administrator as a person, and the product's name in the image labels.** The password-changed e-mail ended «… وأبلغ مسؤول النظام.»; it says «… وأبلغ مدير النظام.», the name the interface now gives the role beside a person (F10-final-1: «مدير النظام», «موظف», «موظف استقبال», «الإدارة العليا») and the one the `LAST_ADMIN` error already used («مدير نظام نشط»). English is unchanged ("tell your administrator"). The image's `org.opencontainers.image.title` was its name, `vms-backend`; it is "Mawdoo3 Visitors API", and the description and the header comment say "Mawdoo3 Visitors API …" instead of "Mawdoo3 visitor-pass API" (the brand where the product is meant, B10-16); `pyproject.toml`'s description follows. The image name `vms-backend:local`, the `vms` user of the image and the package name stay identifiers (B10-5, B10-21). The catalog's module docstring no longer quotes the old product name, so the repository check of retired names (`deploy/verify/test_brand_names.py`) has no exception for it. | The lead's decision on role names beside a person (one word per role across the screens and the e-mails, as F10-rf-3 did for checking in), and the brand sweep: "Mawdoo3 Visitors" wherever a person or an operator reads the product's name. |

### Tests (B10-22)

- `tests/unit/test_email_i18n.py::test_arabic_texts_name_the_administrator_as_the_interface_does` (new): no Arabic text of the
  catalog says «مسؤول النظام», and `changed.act` says «مدير النظام».
- `deploy/verify/test_brand_names.py` (new, 6; see F10-final-2): the image labels and the package description start with
  "Mawdoo3 Visitors", and no retired name is left in the backend's application code, templates, scripts or configuration
  examples.

### Verification (B10-22)

- `ruff check .`: clean. `ruff format --check .`: 251 files already formatted. `mypy`: no issues in 134 source files.
- The affected modules: `test_email_i18n.py`, `test_email_templates.py`, `test_email_bidi.py`, `test_email_design.py`,
  `test_email.py` (509 passed); `test_dependency_locks.py`, `test_config.py`, `test_send_test_email.py`;
  `tests/integration/test_http_behaviour.py` (34 passed, the OpenAPI title "Mawdoo3 Visitors API").
- The full `pytest`: 2971 passed and 3 skipped (the opt-in volume checks) in 233 s; 2970 before, plus the new test. Afterwards the cluster holds only `postgres`, `vms` and `vms_e2e`.
- The suite ran against throwaway databases with `VMS_TEST_*` pointing at the server's `postgres` database, so `vms` was never
  connected to.

### Hand-over (B10-22)

- **Docs owner:** `README.md` §10 and `docs/development.md` still show `EMAIL_FROM=Mawdoo3 <…>` (the default is
  `Mawdoo3 Visitors <…>`), and the titles and prose of `README.md`, `deploy/README.md`, `docs/architecture.md`,
  `docs/development.md`, `docs/security.md`, `docs/security-audit.md` and `docs/production-readiness.md` still say "Visitor
  Management".
- **Lead:** the root `.env`'s first line is the comment "Visitor Management System — environment configuration." (not read by
  anyone but an operator; its `EMAIL_FROM` already says "Mawdoo3 Visitors"). `backend/var/outbox/` holds e-mails written before
  phase 10 ("Demo Company visitor management"): generated and git-ignored; the lead may delete them.

---

# Phase 10 — gap closure: the demo company's address in Arabic (2026-10-08)

Scope: `backend/app/services/seeding.py`, `tests/integration/test_cli.py`; documents (`README.md` §10, §11 and §15,
`.env.example`, `deploy/env/backend.env.example`, `docs/production-readiness.md`, `docs/security.md`,
`docs/architecture.md`). The frontend's part of the same pass is F10-gap-1 to F10-gap-8 (phase-10-frontend.md). No
migration, endpoint, setting, contract or dependency change. The root `.env`, the running demo (ports 8000 and 5173) and
the database `vms` were not touched.

| # | Decision | Reason |
|---|---|---|
| B10-23 | **`seed-demo` gives the Arabic demo company an Arabic address.** `DEMO_COMPANY.address` is «مبنى رقم 14، شارع الملك عبدالله الثاني، عمّان 11953، الأردن» (`ARABIC_DEMO_ADDRESS`), the same fictional address as before in Arabic; `E2E_DEMO_COMPANY` keeps the English one (`ENGLISH_DEMO_ADDRESS`), so `seed-e2e` creates exactly what it did. `SeedCompany` gained `former_addresses`, and `complete_company` replaces the address of an existing seed company only while it is exactly a former seed address and no person changed `address` in the settings (B10-15's rule, read from the audit trail); the change is audited as COMPANY_SETTINGS_UPDATED `{"changed_fields": ["address"], "source": "cli"}` without an actor and listed as "companies updated". `seed-e2e` knows no former address, so it never turns an Arabic address back. The seed's `demo.local` domain stays: it is the domain of the six sign-in addresses the README and the E2E suite use, and `.local` is reserved, so no message to a seeded user reaches a real mailbox while the demo sends real e-mail. | The Arabic acceptance run and the final critic: the English address showed in the Arabic part of every visitor e-mail («العنوان: Building 14, …») and in the Arabic settings page, the one English text left in an otherwise Arabic demo (request 1, "the product must look finished", and request 4). The rename rule is the one B10-20 uses for the users and departments, so the user's own demo database gets the address on its next `seed-demo` without overriding a choice. |

### Tests (B10-23)

`tests/integration/test_cli.py`: `test_seed_demo_is_idempotent` now asserts the Arabic address and the `demo.local` domain;
new `test_seed_demo_writes_the_arabic_company_address_in_arabic_and_seed_e2e_keeps_the_english_one` (no Latin letter in
the Arabic address; `seed-e2e` stores the English one), `test_seed_demo_replaces_the_earlier_english_seed_address` (a
company holding the earlier address gets the Arabic one, one audit row without an actor, listed; a second run changes and
audits nothing) and `test_seed_demo_keeps_an_address_a_person_set` (the English address typed back in the settings stays;
another company's address is never touched).

### Verification (B10-23)

- `ruff check .`: clean. `ruff format --check .`: 251 files already formatted. `mypy`: no issues in 134 source files.
- `tests/integration/test_cli.py`: 33 passed (30 before, plus the 3 new tests).
- The full `pytest`: 2974 passed and 3 skipped (the opt-in volume checks) in 304 s; `--committed-first` the same in
  309 s; with `--cov=app --cov-branch` the same in 315 s, lines 97.97 % (8,483 of 8,659), branches 93.56 % (1,641 of
  1,754). 2971 before, plus the 3 new tests. The suite ran against throwaway databases with `VMS_TEST_*` pointing at the
  server's `postgres` database, so `vms` was never connected to; afterwards the cluster holds only `postgres`, `vms` and
  `vms_e2e`.
- Deployment: `unittest discover -s deploy/verify -p "test_*.py"` 33 tests OK; `check_release_tree.py` OK (885 files:
  the two new frontend test files); `check_nginx_headers.mjs` 7 headers in sync; `ruff check deploy` and `ruff format
  --check deploy` clean.
- The full E2E suite (which seeds with `seed-e2e`, unchanged): 235 passed, 18 skipped, 0 failed (phase-10-frontend.md,
  gap closure).

### Documents (with the frontend's part)

- README §10: the demo's Gmail check is dated "before the final bilingual templates, the inline logo and the last wording
  changes", and what the next check needs (the mailbox owner's consent, `send-test-email`, one real invitation, a
  reachable `QR_BASE_URL`) is named; §11: the Arabic seed address and why `demo.local` stays; §15: the three layout
  defects fixed, the Gmail check dated.
- `.env.example` and `deploy/env/backend.env.example` lead Gmail with `SMTP_PORT=465` and `SMTP_SECURITY=ssl`, with
  587/`starttls` as the alternative where that port is open (the demo's network blocks 587), and `.env.example` says
  `QR_BASE_URL` must open on a phone.
- production-readiness: L-21, L-22 and L-23 fixed (L-22 names all six walk-in reasons); L-25 "mm/dd/yyyy in headless
  Chromium regardless of the UI language"; L-28's address, subtitle and «قبل < 1 د» fixed, the sign-in/check-in term kept
  with its reason; L-4 dates the Gmail check and says what the next one needs; §1, §4, §10, §11, §12, §15 I and §16
  follow; security.md §18 dates the Gmail check; architecture.md: the pass page and the camera without notes, toasts at
  the top.

### Hand-over (B10-23)

- **Lead / user:** the demo API on 8000 was started at 02:28 and runs code from before B10-22 and B10-23 (it has no
  reload). At a convenient moment: `alembic upgrade head` (no new revision), `python -m app.cli seed-demo` on `vms` (the
  Arabic address, audited, unless someone set an address in Settings), then restart the API. With the mailbox owner's
  consent, `send-test-email` and one real invitation through Gmail 465/ssl to a real inbox: the sender "Mawdoo3 Visitors",
  the inline logo and QR, Arabic first in Gmail web and mobile, and the pass link opening on a phone once `QR_BASE_URL` in
  the root `.env` is the demo machine's LAN address or a public `https://` origin (L-4, L-26). Record the result in this
  file.

---

# Phase 10 — backend: invitations in the inviter's own name; departments and the address in both languages (2026-10-08)

The user's two requirements of 2026-10-08: (A) "every employee can only make an invitation in their own name;
they cannot make one for the others", and (B) "when the interface is in English, even the department is in
English". Scope: `backend/` (migration `0012`, models, schemas, services, the e-mail service and two
templates, the seeds, tests), the contract snapshot (`frontend/src/types/backend-contract.json`,
regenerated), `docs/api.md`, the capability matrix of `docs/security.md` §5.2, README §11 and the
command table, the demo-data line of `docs/development.md`, and this file. No other frontend file was
edited: the frontend builder works in parallel on the same shared contract. The root `.env`, the running
demo (ports 8000 and 5173), the database `vms` and the E2E ports and database were not touched.

**Contract and configuration.** One migration (`0012`), one capability (`INVITE_FOR_ANY_HOST`), one field
code (`host_must_be_self`; the vocabulary now has 61 codes), new response and request fields (hand-over
below). No new error code, audit action, setting, endpoint or dependency. `Me.company` is unchanged: it
carries no address.

| # | Decision | Reason |
|---|---|---|
| B10-24 | **The host of a new invitation is the caller; only an administrator invites on behalf of another host (amends D-02 and contract §7.5).** `POST /visits` by a caller without SYSTEM_ADMIN whose `host_id` is not their own ID answers 422 `VALIDATION_ERROR` with the field error `host_id`: "You can only invite visitors you host yourself.", code `host_must_be_self` (no parameters). The rule is a capability of the matrix (`Capability.INVITE_FOR_ANY_HOST`, SYSTEM_ADMIN only, `security/permissions.py`), not a role list in the service, so EMPLOYEE + MANAGEMENT and EMPLOYEE + RECEPTIONIST are refused like EMPLOYEE, and SYSTEM_ADMIN (alone or with EMPLOYEE) still names any active host. The check runs before the host is looked up (`VisitsService._chosen_host`): whoever the other ID names (an administrator, a receptionist, an inactive user, nobody, another company's user), the answer is the same, so it reveals nothing about that user; nothing is written (no visitor, visit, pass, e-mail or audit row). The roles it reads are the request's, which `begin_visit_change` re-checks under the company lock (SEC-07): a demoted administrator's request in flight cannot book for others. **Unchanged:** walk-ins (`RECEPTION`: the desk registers the walk-in for whichever colleague the visitor came to see, also when the person at the desk holds EMPLOYEE as well); ownership of existing visits (host or creator, §7.5), so visits employees booked for colleagues before this change keep both owners; a visit's host is never changed afterwards (`VisitUpdate` has no `host_id`, a 422 `not_allowed`); the invitation's "invited by … on behalf of …" wording, which an administrator's booking still uses (B57-02). **Lead's decision:** administrators keep booking for others (an office manager inviting for a colleague). | Requirement A. A capability rather than `Role.SYSTEM_ADMIN in roles`: the matrix is the single source of truth (`test_permissions.py` pins it). Checking before the lookup avoids an oracle about other accounts. |
| B10-25 | **Migration `0012` and the API: departments and the company's address in two languages, and the department's Arabic name recorded on visits.** `departments.name_ar varchar(120) NULL` with `ck_departments_name_ar_not_blank` and the unique index `uq_departments_company_name_ar` on `(company_id, lower(name_ar)) WHERE name_ar IS NOT NULL` (as `uq_departments_company_name` for `name`); `companies.address_ar text NULL` (no CHECK, as `address`). **Beyond the shared contract: `visits.department_name_ar varchar(120) NULL`.** A visit's `department` is a snapshot (D-17: set at creation, refreshed while SCHEDULED, frozen from check-in on), so its Arabic name must be one too: read from the current department instead, a checked-out visit would show today's Arabic name beside the English name it recorded. Visit creation and walk-ins record both names; a change of department, and a rename in either language, refresh both on SCHEDULED visits (`VisitSnapshotRefresher.department_renamed`, `VisitRepository.refresh_department_names`). **API:** `DepartmentRef` gains `name_ar: string \| null`, so every embedded department carries it (Me, users, the host directory, visits, visit detail, scan results and scan errors, reception today, inside/evacuation, history, visitor history, dashboards, visitor search); `Department` gains `name_ar`; `POST /departments` accepts `{name, name_ar?}` and `PATCH` `{name?, name_ar?: string \| null, is_active?}` (`OptionalDepartmentName`: the rules of `name`, i.e. trimmed, at most 120 characters, one line, no control or text-direction characters; null or blank clears it; omitted leaves it); a duplicate Arabic name answers 409 `CONFLICT` with `details.field = "name_ar"` and "A department with this Arabic name already exists." (a duplicate `name` is reported first); `DEPARTMENT_UPDATED` names `name_ar` in `changed_fields` like `name`. `CompanySettings` and `CompanySettingsUpdate` gain `address_ar` (the type of `address`), audited in `COMPANY_SETTINGS_UPDATED`. The reports' `DepartmentCount` gains `name_ar` (the department's current Arabic name, null for "No department"). **Both names are checked before either changes** in `DepartmentsService.update`: a lookup flushes pending changes, and a rename flushed outside the guarded save would turn a concurrent duplicate into a 500 instead of the 409. **Grants:** none; the runtime role's table-level SELECT, INSERT and UPDATE (revisions 0001, 0006) cover the new columns, which a test writes as that role. **Downgrade** refuses, after locking the three tables (SEC-39), while an Arabic department name, an Arabic address or an Arabic department name on a visit exists, and names the statements that clear them. A checked-out or cancelled visit cannot be changed (`visits_terminal_immutable`), so once one holds an Arabic department name the way back is a backup taken before the upgrade; the refusal says so. | Requirement B, and the contract's "DepartmentRef everywhere". The display rule (Arabic interface and `name_ar` set → `name_ar`, else `name`; the address likewise) belongs to the clients and the e-mails (B10-26). |
| B10-26 | **E-mails: each language shows the department and the address in that language.** The Arabic part of an invitation and a reschedule notice shows the visit's `department_name_ar` when it is set, else `department_name`, and the company's `address_ar` when it is set, else `address`; the English part shows `department_name` and `address` (`EmailService.department_names`, `company_addresses`; the templates read `department_name[lang]` and `company_address[lang]`). **One addition:** an English part whose company has no `address` but an `address_ar` shows the Arabic address rather than none, so a visitor who reads only English still learns where to go. The values keep B10-14's isolation (a block with its own `dir` in the details grid, FSI/PDI in the plain text, line by line for an address) and the department its one-line rule; subjects are unchanged. With Latin values the English text part is byte for byte what it was, so the E2E suite's `Department: <name>` and the rest still hold. People's names, visitor companies and purposes stay as typed. | Requirement B for the e-mails, as the lead's contract states it. |
| B10-27 | **Seeds: the demo's departments and address in both languages, and the conversion of a database `seed-demo` wrote in Arabic only (amends B10-20 and B10-23).** `seed-demo` creates the five departments with their English `name` (the seed keys: Executive Office, Finance, IT, Operations, Human Resources) and their Arabic `name_ar` (المكتب التنفيذي، المالية، تقنية المعلومات، العمليات، الموارد البشرية), and the company with the English `address` and the Arabic `address_ar`; the users keep their Arabic names (names people type stay as typed). `seed-e2e` is unchanged: English names, the English address, no Arabic name or address. **On an existing database** (the user's `vms`, renamed to Arabic by B10-20 and B10-23), with B10-15's rule (a field named in a `DEPARTMENT_UPDATED` or `COMPANY_SETTINGS_UPDATED` row with an actor is a person's and is left alone): a seed department whose name is exactly the Arabic name B10-20 gave it gets its English name back (`former_names`), unless a person changed `name` or another department already has the English name; a seed department whose name is the seed's English name and that has no Arabic name gets the seed's Arabic name, unless a person changed `name_ar` or another department already shows that text in either language (two departments must not read the same in the Arabic interface); the company's address that is exactly B10-23's Arabic one becomes the English one, and a company whose address is the seed's English one and has no Arabic address gets the Arabic one. Each change is audited without an actor (`DEPARTMENT_UPDATED` `["name", "name_ar"]` or `["name_ar"]`, `COMPANY_SETTINGS_UPDATED` `["address", "address_ar"]` or `["address_ar"]`, `source: cli`) and listed (`departments updated: <slug>/<key>`, `companies updated: <slug>`); a second run changes and audits nothing. **Visits:** the SCHEDULED visits of a changed department get both names (D-17, as a rename by a person); its checked-in and no-show visits that recorded one of its two names and no Arabic name get both as well (`VisitRepository.complete_department_names`): the same name, now known in the other language, which a person's rename never does. Checked-out and cancelled visits cannot be changed (`visits_terminal_immutable`) and keep the name they recorded; the repository refuses to be pointed at them (a `ValueError` before any SQL). | Requirement B for the user's own demo database, with the conversion rule the lead specified. The completion of checked-in visits keeps the reception's inside list and the evacuation list in English for visitors who are in the building now. |
| B10-28 | **Not done, and what others must do.** (a) **The user's `vms`:** run `alembic upgrade head` (revision `0012`) and `python -m app.cli seed-demo`, then restart the API on 8000 (it has no reload). Visits checked out or cancelled since B10-20's Arabic rename recorded the Arabic department name only and cannot be changed: in the English interface they show it in Arabic. Their number: `SELECT count(*) FROM visits WHERE department_name_ar IS NULL AND department_name ~ '[؀-ۿ]' AND status IN ('CHECKED_OUT', 'CANCELLED');` after the seed. Changing them would mean disabling the immutability trigger as the schema owner, which this work does not do. (b) **Frontend** (hand-over below): the frontend's `api.contract.test.ts` fails until `api.ts` has the new fields and `host_must_be_self`. (c) **Contract owner:** the proposed text for `docs/initial-assessment.md` is in the hand-over. (d) An administrator's own invitation form still offers every host; an employee's offers none (the frontend's part of B10-24). | |

### Tests (B10-24 to B10-28)

- `tests/integration/test_visits_api.py` (+10): an EMPLOYEE, EMPLOYEE + MANAGEMENT and EMPLOYEE + RECEPTIONIST caller refused with
  exactly `host_must_be_self` for a colleague, with nothing written (visits, visitors, `VISIT_CREATED`, e-mail), and allowed
  in their own name with their own department (3); the same answer whatever the other ID names (5); SYSTEM_ADMIN and
  SYSTEM_ADMIN + EMPLOYEE book for a colleague, with the host's department, the "on behalf of" invitation and both owners (2);
  an administrator's host must be an active host of the company (4, formerly an employee's); PATCH refuses `host_id` (1).
  `test_employee_may_choose_another_active_host` is gone (its rule is gone). Fixtures that had an employee book for a
  colleague (`test_employee_isolation`, `test_owners_and_administrators_may_reissue`,
  `test_deactivating_a_host_cancels_their_scheduled_visits`) keep their intent through `tests/support.create_visit_booked_by`:
  created by an administrator, then attributed to the employee exactly as such a visit is stored.
- `tests/integration/test_reception_api.py`: a RECEPTIONIST + EMPLOYEE registers a walk-in for a colleague but cannot invite
  for them; an administrator registers walk-ins for anyone (1).
- `tests/integration/test_field_codes_api.py`: `host_must_be_self` through the API; `not_found` and `host_unavailable` now
  through an administrator.
- `tests/integration/test_departments_and_company.py` (+21): creation with an Arabic name (trimmed, blank and null are none);
  uniqueness per company ignoring case, inactive departments included, other companies not, many without one, `name` reported
  first; a concurrent duplicate Arabic name (past the service's check) and a concurrent duplicate name in a rename that also
  changes the Arabic name are both 409s; change, clear, no write for the same value, audit `changed_fields` without values;
  six invalid Arabic names on create and update; 120 characters; administrators only; `DepartmentRef` with `name_ar` in Me,
  a user, the host directory, a created visit, visit detail, the list, visitor history, the employee dashboard, reception
  today, a scan, a check-in, the inside list, a walk-in and the report; the snapshot of a SCHEDULED visit follows a change in
  either language while a checked-in visit keeps its names; a visit moved to another department records both of its names and
  none of the old one's; `address_ar` set, audited, cleared, validated (3) and administrators only.
- `tests/integration/test_cli.py` (+2, 7 rewritten): `seed-demo` creates both names and both addresses with the English keys'
  seed IDs; `seed-e2e` keeps English only; `seed-demo` after `seed-e2e` adds the Arabic names, the Arabic address and the Arabic
  user names, refreshes a SCHEDULED visit's snapshots, lists and audits each change once and changes nothing on a second run; a
  person's rename, a name typed back, an Arabic name set or cleared, a text another department shows, and Other Corp's users are
  left alone; `seed-e2e` after `seed-demo` takes nothing away; the address in both languages, its Arabic one added to an
  earlier English seed address, and a person's address (and cleared Arabic address) kept; **the conversion of the Arabic-only
  demo** (departments and address as B10-20 and B10-23 left them, simulated with that earlier seed specification): every
  department back to English with its Arabic name, the address likewise, a scheduled, a checked-in and a no-show visit with both
  names, a checked-out and a cancelled visit unchanged, audited and listed once, idempotent; and **where a person changed it**
  (a department renamed, one renamed and typed back, an English name another department has, an Arabic name another
  department shows, an address typed in the settings), only the rest converted.
- `tests/integration/test_migrations.py` (+4): the new columns empty after the upgrade, the partial unique index, the runtime
  role writing all three, the CHECK and the index refusing a blank and a duplicate (ignoring case) and allowing another
  company's; the downgrade refused by each kind of value and clean without them (columns and index gone, upgrade again); a
  cancelled visit's Arabic department name that cannot be cleared refuses the downgrade with the backup advice; a write in
  flight during the downgrade still blocks it. `test_downgrade_then_upgrade_is_clean` and `test_models_match_migration` cover
  the schema and the privileges unchanged.
- `tests/integration/test_database_rules.py`: `uq_departments_company_name_ar` is the constraint a duplicate reports.
- `tests/integration/test_visit_snapshot_hook.py` (+2): a change of the Arabic name alone calls the D-17 refresher in the
  renaming transaction, the same value again does not; the snapshot completion refuses checked-out and cancelled visits.
- `tests/unit/test_email_templates.py` (+8): invitation and reschedule, Arabic-led and English-led, each part with its own
  department and address in HTML and plain text and nothing of the other language; without Arabic values both parts show the
  English ones as before, and without a department or address neither part shows the line; an Arabic-only address reaches
  the English part; an Arabic department name stored with a line break prints one line and markup is escaped; subjects and
  people's names unchanged. `tests/integration/test_email_languages.py` (+1): the same through the API, the dispatcher and the
  memory provider, and an Arabic rename reaching the SCHEDULED visit's reschedule notice.
- Updated for the new field: `test_auth_login.py`, `test_users_api.py`, `test_reception_api.py`, `test_reports_api.py` (the
  report fixture's IT department has an Arabic name), `test_schemas.py`, `test_permissions.py` (+5: the matrix's new
  capability for each role, and `INVITE_FOR_ANY_HOST` for three role combinations).

Each fix was undone on its own while the rest stayed, its tests failed, and the file was restored:

| Fix undone | First failing test |
|---|---|
| the host rule | `test_a_caller_who_is_not_an_administrator_invites_only_as_the_host` |
| administrators may name another host | `test_an_administrator_may_invite_on_behalf_of_any_active_host` |
| an invitation records the Arabic name | `test_every_embedded_department_carries_its_arabic_name` |
| a walk-in records the Arabic name | the same |
| a visit's edit refreshes the Arabic name | `test_a_visit_moved_to_another_department_records_both_of_its_names` (written after this check found the gap) |
| a rename refreshes the Arabic snapshot | `test_a_department_s_arabic_name_reaches_its_scheduled_visits_only` |
| an Arabic-only rename refreshes snapshots | the same |
| visit views carry the Arabic name | `test_every_embedded_department_carries_its_arabic_name` |
| reports carry the Arabic name | `test_report_matches_the_hand_computed_fixture` |
| the Arabic e-mail part shows the Arabic department / address | `test_each_language_shows_the_department_and_the_address_in_its_own_language` (2) |
| the English part falls back to the Arabic address | `test_an_address_given_in_arabic_only_reaches_the_english_reader_too` |
| a 409 for a concurrent duplicate Arabic name | `test_a_concurrent_duplicate_arabic_name_is_a_conflict_on_name_ar` |
| both names checked before either changes | `test_a_concurrent_duplicate_name_with_an_arabic_name_is_still_a_conflict_on_name` |
| the seed converts the Arabic-only names | `test_seed_demo_turns_the_arabic_only_demo_into_both_languages` |
| the seed completes checked-in and no-show snapshots | the same |
| the seed fills the Arabic address only beside its own address | `test_seed_demo_gives_an_earlier_demo_company_the_brand_and_its_arabic_name` |
| the seed respects names other departments show | `test_seed_demo_never_changes_what_a_person_changed` |
| the seed respects a person's rename | `test_seed_demo_leaves_the_arabic_only_demo_where_a_person_changed_it` |
| the seed respects a person's Arabic name | `test_seed_demo_never_changes_what_a_person_changed` |
| the seed fills an Arabic name only beside its own name | the same |
| the downgrade guard counts visits | `test_the_bilingual_columns_cannot_be_lost_by_a_downgrade` |
| the downgrade guard locks before counting | `test_an_arabic_name_written_during_the_0012_downgrade_still_blocks_it` |

All files were restored afterwards. The gap the check found (a visit's change of department did not
show in any test) was closed by the test named in that row.

### Verification (B10-24 to B10-28)

Backend gate (`backend/`), run after the last change:

- `ruff check .`: clean. `ruff format --check .`: 252 files already formatted. `mypy`: no issues in 134 source files.
- `pytest`: 3028 passed and 3 skipped (the opt-in volume checks) in 245 s; `pytest --committed-first`: the same in 248 s.
  2974 before, plus 54: 21 in `test_departments_and_company.py`, 10 in `test_visits_api.py`, 8 in
  `test_email_templates.py`, 5 in `test_permissions.py`, 4 in `test_migrations.py`, 2 each in `test_cli.py` and
  `test_visit_snapshot_hook.py`, and one each in `test_email_languages.py` and `test_reception_api.py`.
- Contract snapshot regenerated (`python -m app.contract --out ../frontend/src/types/backend-contract.json`);
  `tests/unit/test_contract_snapshot.py` passes.
- Deployment files (repository root): `unittest discover -s deploy/verify -p "test_*.py"` 33 tests OK;
  `check_release_tree.py` OK (892 files).
- The suite ran against throwaway databases with `VMS_TEST_*` pointing at the cluster's `postgres` database, so `vms`
  was never connected to; afterwards the cluster holds only `postgres`, `vms` and `vms_e2e`.
- **Live**, against an API of this code on 127.0.0.1:8711 (`app.serve`, the outbox provider into the session scratchpad,
  `COOKIE_SECURE=false`) and a throwaway database `vms_b10_24_smoke` (migrated to `0012`, then seeded with the
  Arabic-only demo of B10-20 and B10-23; dropped afterwards; ports 8000, 5173, 8700 and 5199 untouched):
  `host@demo.local` inviting for لينا صالح answered 422 `{"fields": {"host_id": "You can only invite visitors you host
  yourself."}, "field_codes": {"host_id": {"code": "host_must_be_self", "params": {}}}}`, in their own name 201, and
  `admin@demo.local` for لينا صالح 201. `python -m app.cli seed-demo` printed `companies updated: demo-company` and
  `departments updated:` with all five keys, and a second run only "users already present". Afterwards
  `GET /departments` listed Executive Office / المكتب التنفيذي, Finance / المالية, Human Resources / الموارد البشرية,
  IT / تقنية المعلومات and Operations / العمليات; the settings held the English address with the Arabic one as
  `address_ar`; the visit booked before the conversion read `{"name": "Finance", "name_ar": "المالية"}`; the report's
  `by_department` carried both names; and a new invitation's text part read «القسم: المالية» and «العنوان: مبنى رقم 14،
  شارع الملك عبدالله الثاني، عمّان 11953، الأردن» in Arabic, "Department: Finance" and "Address: Building 14, King
  Abdullah II Street, Amman 11953, Jordan" in English.

### Hand-over (B10-24 to B10-28)

**Frontend: the exact API surface.**

- `DepartmentRef` is `{ id: string; name: string; name_ar: string | null }` everywhere: `Me.user.department`,
  `User.department`, `Host.department`, `Visit.department` (and so `VisitCreateResult.visit`, `VisitPassResult.visit`,
  `ScanResult.visit`, `ScanErrorDetails.visit`, `ReceptionToday` lists, `InsideVisit`, `EmployeeDashboard.today`,
  `VisitorSearchItem.today_visits`, `VisitPage`). In a visit both are the snapshots recorded on the visit.
- `Department` is `{ id, name, name_ar: string | null, is_active, created_at, updated_at }`.
- `DepartmentCreate` is `{ name: string; name_ar?: string | null }`; `DepartmentUpdate` is
  `{ name?: string; name_ar?: string | null; is_active?: boolean }` (`name_ar`: at most 120 characters, one line; null or
  blank clears it; omitted leaves it). Errors: 422 field errors on `name_ar` (`too_long` `{max: 120}`, `line_breaks`,
  `bidi_controls`, `control_characters`, `invalid_text`); 409 `CONFLICT` with `details: {field: "name_ar"}` and the
  message "A department with this Arabic name already exists." (a duplicate `name` is still `{field: "name"}` and is
  reported first).
- `CompanySettings` gains `address_ar: string | null`; `CompanySettingsUpdate` gains `address_ar?: string | null` (the rules
  of `address`: at most 1000 characters, line breaks allowed; null or blank clears it). `Me.company` is unchanged.
- `ReportSummary.by_department[]` is `{ department_id: string | null; name: string; name_ar: string | null; count: number }`.
- `POST /visits`: a caller without SYSTEM_ADMIN must send their own ID as `host_id`; otherwise 422 `VALIDATION_ERROR` with
  `details.fields.host_id = "You can only invite visitors you host yourself."` and `details.field_codes.host_id =
  {code: "host_must_be_self", params: {}}`. New `FieldErrorCode` member: `'host_must_be_self'` (no parameters; the
  snapshot's `field_error_codes` has 61 codes). Walk-ins (`POST /reception/walk-ins`) are unchanged.
- Display rule: an Arabic interface shows `name_ar` when it is set, else `name`; English shows `name`; the address
  likewise. E-mails follow the same rule, and an English part without an address shows the Arabic one (B10-26).
- `api.contract.test.ts` fails until `api.ts` has these fields and the code. E2E: `seed-e2e` is unchanged (English names,
  no Arabic names or address), and every English text part is byte for byte what it was; specs where an employee invites
  for another host would now get the 422.

**Contract owner (`docs/initial-assessment.md`, not edited here): the proposed text.**

- §4 *companies*, append: "*(rev. 3, revision 0012)* `address_ar text NULL` (the address in Arabic; `address` is the English
  or only address)." §4 *departments*: "`company_id`, `name varchar(120)`, *(revision 0012)* `name_ar varchar(120) NULL`
  (CHECK not blank; the Arabic name), `is_active bool default true`. Unique indexes `uq_departments_company_name` on
  `(company_id, lower(name))` and `uq_departments_company_name_ar` on `(company_id, lower(name_ar)) WHERE name_ar IS NOT
  NULL`." §4 *visits*, the snapshot row: "`visitor_name`, `visitor_company_name` (NULL), `host_name`, `department_name`
  (NULL), `department_name_ar` (NULL, revision 0012)".
- §7.5 matrix: "| Create visit / invitation | ✓ (any host) | ✓ (themselves as host only) | – | – |", and in the bullets:
  "Only SYSTEM_ADMIN invites on behalf of another host (`INVITE_FOR_ANY_HOST`); anyone else naming another `host_id` gets
  `422` `host_must_be_self`. Walk-ins name any active host."
- §8 endpoint table: "| POST `/departments`, PATCH `/departments/{id}` | admin | `{name, name_ar?}` / `{name?, name_ar?,
  is_active?}` → `Department` |".
- §8.1: "`interface DepartmentRef { id: string; name: string; name_ar: string | null }`", "`interface Department { id:
  string; name: string; name_ar: string | null; is_active: boolean; … }`", `CompanySettings` "`address: string | null;
  address_ar: string | null`", "`// PATCH /company/settings also accepts address_ar?: string | null (the rules of
  address)`", `ReportSummary` "`by_department: { department_id: string | null; name: string; name_ar: string | null;
  count: number }[]`", and the `VisitCreate` comment "`host_id: string // the caller's own ID unless the caller is an
  administrator`".
- §9 Templates: "The Arabic text names the department and the company's address by their Arabic values when they are set
  (an English part without an address shows the Arabic one)."
- §10 *Invite visitor form*: "defaults: host = me (administrators may choose another host; nobody else can) …"; *Languages*:
  "Departments are named by `name_ar` in the Arabic interface when it is set, else by `name`; the company's address
  likewise."
- §13 D-02: "*(revised, B10-24)* Only administrators pick another active host; creator **and** host own the visit. Host = self
  for everyone else."
- §14: add B10-24 … B10-28 to the Phase 10 line.

**The running demo (lead / user).** On `vms`, at a convenient moment: `alembic upgrade head` (revision `0012`), then
`python -m app.cli seed-demo` (prints `companies updated: demo-company` and the five departments unless a person changed
them), then restart the API on 8000. Nothing of this was done here. B10-28 (a) explains the finished visits that keep
their Arabic-only department name and gives the query that counts them.

**Documents edited here beside this file:** `docs/api.md` (the new field code, the capability, the schemas, the
departments, company settings, visit creation and report sections), `docs/security.md` §5.2 (the capability row), README
§11 and its command table, and the demo-data line of `docs/development.md`.

### Integration (B10-24 to B10-28 with the frontend's F10-dept-1 to 7, 2026-10-08)

The integrator joined this work with the frontend's (phase-10-frontend.md, F10-dept-1 to 7), ran every gate and checked
both requests live. No code was changed: the two sides met the shared contract as built.

| # | Decision or finding | Reason |
|---|---|---|
| INT-dept-1 | **The contract snapshot and `api.ts` agree as delivered.** `python -m app.contract` regenerated into a scratch file is byte-identical to `frontend/src/types/backend-contract.json` (61 field codes, `host_must_be_self` included); `api.contract.test.ts`, `fieldMessages.test.ts` and `auditVocabulary.test.ts` pass against it. | Step 1 of the integration. |
| INT-dept-2 | **The conversion of the user's database was rehearsed on a copy of its history, not on `vms`.** A throwaway database was migrated to `0012` and seeded with the English demo company (`E2E_DEMO_COMPANY`, what `vms` held after B10-10). It was then seeded again with the B10-20/B10-23 specification: departments named in Arabic with the English names as `former_names`, and the Arabic address with the English one as a former address. That run wrote exactly the rows and audit rows those seeds wrote: five `DEPARTMENT_UPDATED {"changed_fields": ["name"], "source": "cli"}`, one `COMPANY_SETTINGS_UPDATED ["address"]` and six `USER_UPDATED ["full_name"]`, all without an actor. The departments read «المالية» and so on with `name_ar` NULL, and the address was Arabic with `address_ar` NULL. Four visits were then booked through the API as `host@demo.local`, each with the department snapshot «المالية» only: one scheduled for tomorrow, one checked in, one checked out and one cancelled. | The task's check (e): convert only exact seed values that no person changed, as on `vms`. |
| INT-dept-3 | **The new `seed-demo` converts that state exactly once.** The first run printed `companies updated: demo-company` and `departments updated: demo-company/Executive Office, …/Finance, …/IT, …/Operations, …/Human Resources`. Afterwards: departments Executive Office / المكتب التنفيذي, Finance / المالية, Human Resources / الموارد البشرية, IT / تقنية المعلومات and Operations / العمليات; the address in English with the Arabic one as `address_ar`; five `DEPARTMENT_UPDATED ["name", "name_ar"]` and one `COMPANY_SETTINGS_UPDATED ["address", "address_ar"]`, without an actor; the users unchanged (Arabic). Visits: the SCHEDULED and CHECKED_IN ones read Finance / المالية; the CHECKED_OUT and CANCELLED ones keep «المالية» with no Arabic name (B10-28 (a)). The second run printed only "users already present" and wrote no audit row. A fresh database seeded twice got the same departments and address, `COMPANY_CREATED` 1, `DEPARTMENT_CREATED` 5 and `USER_CREATED` 6, and nothing on the second run. | Idempotency and the conversion rule, end to end through the CLI. |
| INT-dept-4 | **Finished visits recorded before the conversion stay Arabic in the English interface (open, for the lead).** The live check shows it. In English, *My visits* lists the checked-out pre-conversion visit with «المالية»; the cancelled one is hidden by the default "All but cancelled" filter. Every other department on every page is English, and the report counts that visit under "Finance", because reports use the current names. On `vms` this applies to the visits checked out or cancelled since B10-20's rename; B10-28 (a) has the query that counts them. The options: (1) accept it (D-17: history shows what the visit recorded); (2) a read-time rule in `VisitViewBuilder`: a snapshot without an Arabic name whose name equals its department's current `name_ar` is shown as that department's `name`, with the snapshot as `name_ar` (one more query per page of visits, and a change to D-17); (3) a one-off completion run as the owner that bypasses the `visits_terminal_immutable` trigger (needs a security sign-off). Nothing was changed here. | The user's request B, applied to legacy data. This is a product and security decision, not an integration one. |

**Gates (integration, 2026-10-08).**

- Backend (`backend/`; throwaway databases created through the cluster's `postgres` database with `VMS_TEST_*`):
  - `ruff check .`: all checks passed. `ruff format --check .`: 252 files already formatted. `mypy`: no issues in 134 source files.
  - `pytest`: 3,028 passed and 3 skipped (the opt-in volume checks) in 251.90 s. `pytest --committed-first`: the same in 285.39 s.
- Frontend:
  - `typecheck` and `e2e:typecheck`: 0 errors. `lint`: 0 warnings and 0 errors on 503 files (231 rules).
  - Vitest: 129 files, 1,383 tests passed in 95.67 s.
  - `npm run build -- --outDir <scratchpad>`: 2,719 modules, no warning; `app` 259.00 / 73.61 kB, `react` 218.84 / 68.25 kB,
    stylesheet 89.84 / 16.30 kB.
- **E2E** (`npm run e2e -- --retries=0`, ports 8700/5199, `vms_e2e`): 253 tests, 235 passed, 18 skipped, 0 failed, 7.7
  minutes. The acceptance spec's employee steps read the read-only host.
- Deployment files: 33 unit tests OK; `check_release_tree.py` OK (892 files); nginx headers in sync (7); `ruff` clean on `deploy`
  (6 files formatted).
- Afterwards the cluster holds only `postgres`, `vms` and `vms_e2e`.

**Live check.** Setup:

- An API running this code on 127.0.0.1:8930 (`app.serve`, the outbox provider into the session scratchpad, `COOKIE_SECURE=false`,
  no SMTP), and Vite on 5930 proxying to it.
- Database `vms_integ_live` (INT-dept-2 and 3), plus `vms_integ_fresh` for the fresh seed. Both were dropped afterwards.
- Ports 8000, 5173, 8700 and 5199 and the databases `vms` and `vms_e2e` were not used.

Playwright (Chromium) ran 147 checks through the UI, and all passed:

- (a) `host@demo.local` in English:
  - There is no host combobox. "Host" is a read-only textbox showing «عمر خليل».
  - The department select defaults to "Finance" and lists only English names.
  - The invitation answered 201 with the employee's own `host_id` and `department {name: "Finance", name_ar: "المالية"}`.
  - The outcome page, *My visits*, the visit page, reception's Expected list and the reports show English department names.
  - The outbox e-mail's text part has «القسم: المالية» and «العنوان: مبنى رقم 14، شارع الملك عبدالله الثاني، عمّان 11953،
    الأردن» in the Arabic part, and "Department: Finance" and "Address: Building 14, King Abdullah II Street, Amman 11953,
    Jordan" in the English part. The HTML part matches.
- (b) The same in Arabic: «المالية» everywhere. The e-mail is as in (a), with the Arabic address set in (c).
- (c) `admin@demo.local`:
  - The host picker is present. Choosing لينا صالح moved the department to "Operations". The invitation answered 201 with her
    as host and the administrator as creator.
  - "Legal" / «الشؤون القانونية» was created through the dialog, which sent both names.
  - Renaming only the Arabic name sent `{"name_ar": "القانونية"}` and kept "Legal". It was audited as `changed_fields
    ["name_ar"]`, and the toast said "Legal saved".
  - The settings' "Arabic address" showed the seeded address. Saving a new one sent only `address_ar` and left `address` in
    English.
- (d) `POST /visits` as `host@demo.local` with لينا صالح's ID answered 422 `VALIDATION_ERROR`, with `fields.host_id` "You can
  only invite visitors you host yourself." and `field_codes.host_id.code` `host_must_be_self`. Nothing was written.
- (e) See INT-dept-2 and 3.

axe-core checked these pages in Arabic and English, light and dark, at 1440 and 390 px: the employee's and the administrator's
invite forms, departments, company settings, *My visits*, the visit page, reception's Expected list and the reports. It also
checked the rename dialog in both languages. 66 runs found no violation. No page had a page error or horizontal scroll.
Screenshots are in the session scratchpad's `dept-host-shots/` (`<page>-<ar|en>-<1440|390>.png`).

**Documents (integration).** The contract `docs/initial-assessment.md` now carries this work as revision 3 text:

- the revision note;
- §4: `companies.address_ar`, `departments.name_ar` and its index, `visits.department_name_ar`;
- §7.5: the matrix row "✓ (any host)" / "✓ (themselves as host only)" and the host-rule bullet;
- §8: the rows for departments, company settings and `POST /visits`;
- §8.1: `DepartmentRef`, `Department` and its bodies, `CompanySettings` and its PATCH, the display rule, `VisitCreate.host_id`,
  `ReportSummary.by_department`, and 61 field codes;
- §9: the department and the address in the e-mails;
- §10: the invite form's host, and the languages;
- D-02 (revised) and §14.

Also updated:

- README: the visit flow, the roles table, departments' Arabic names and the Arabic address, revision `0012`;
- `docs/development.md`: the repository layout, the migration example (now `0013`), the downgrade-guard examples;
- `docs/architecture.md`: head `0012`, the revision table, the column reference, the host step of the visit-creation sequence;
- `docs/security.md`: the code state;
- `deploy/README.md`: upgrading now applies `0012`.

**Still to do (lead or user).**

- Convert `vms` (B10-28 (a)): `alembic upgrade head`, then `python -m app.cli seed-demo`, then restart the API on 8000.
- Decide INT-dept-4.
- Departments a person created or renamed on `vms` keep what that person typed and have no Arabic name. An administrator adds
  one in *Departments*.

# Phase 10 — backend: no two departments read the same, in either language (2026-10-11)

Findings of the UX review, reproduced: `POST /departments {"name": "تقنية المعلومات"}` succeeded beside IT / «تقنية
المعلومات», `{"name": "Cross", "name_ar": "Finance"}` and `{"name": "Procurement", "name_ar": "Finance"}` beside Finance,
`{"name": "المالية"}` beside Finance / «المالية», and the dialog accepted «العمليات» / "Operations" beside Operations /
«العمليات». The Arabic interface shows `coalesce(name_ar, name)` and the English one `name` (with `name_ar` under it in
the administrators' list, B10-25), so the invite form's department select, the history filter, the reports and the users
list showed two identical labels. The two unique indexes compare `name` with `name` and `name_ar` with `name_ar` only.
The seed already kept the stricter rule (`SeedingService._shown_by_no_other`: no other department shows the text in
either language). The lead's direction after the review: the set {name, name_ar} of one department must not intersect,
ignoring case, the set of any other department of the company.

Scope: `app/services/departments.py` (the repository's existing lookups are reused), the lock-order docstring of `app/repositories/locking.py`, the tests,
`docs/initial-assessment.md` §4, `docs/api.md` (§9 bodies, §10.4), `docs/architecture.md` (the invariants table) and this
file. No migration, field code, error code, message, setting, endpoint or dependency; the contract snapshot regenerated
into a scratch file is byte-identical to `backend-contract.json`. The root `.env`, the demo on 8000/5173, `vms`, and
ports 8950/5950 were not touched.

| # | Decision | Reason |
|---|---|---|
| B10-29 | **No value of a department, `name` or `name_ar`, may be a value of another department of the company, ignoring case, inactive ones included.** `DepartmentsService._require_free` runs, for `name`: the existing name check (409 on `name`, "A department with this name already exists."), then another department's Arabic name (409 on `name`, "A department with this Arabic name already exists."); for `name_ar`: the existing Arabic-name check (409 on `name_ar`, "… this Arabic name …"), then another department's name (409 on `name_ar`, "… this name …"). The same language comes first, so every case the indexes covered keeps its field and message; the cross-language case reuses the existing message that states the fact (the other department has this as its Arabic name, or as its name). So `{"name": "المالية"}` beside Finance / «المالية» is 409 on `name`, `{"name": "Procurement", "name_ar": "Finance"}` 409 on `name_ar`, «العمليات» / "Operations" beside Operations / «العمليات» 409 on `name`, and `{"name": "تقنية المعلومات", "name_ar": "الحاسوب"}` beside IT / «تقنية المعلومات» 409 on `name` (the English interface would show both as «تقنية المعلومات»). A department's own values never conflict: its name and Arabic name may be equal, and it may swap them. **Update:** only a value that changes is checked; a value that changes only in case is checked against its own language (the index's rule) but not across the languages, so a pair of departments that already share a value (written before this rule) can still have their other values, their activity and a change of case saved. Clearing `name_ar` never conflicts. **No new field code or message:** a 409 carries `details.field` and a message, not a 422 code. | B10-25's display rule makes each department's labels the identity people choose from, in both interfaces. The set rule covers the Arabic label (`coalesce(name_ar, name)`), the English label (`name`) and the administrators' list, where each row shows both. It is also the rule the seed already applied, so the seeds and the API now agree. |
| B10-29a | **No index or constraint (no migration `0013`); the service check is serialised instead.** The rule across the languages cannot be one unique index (it compares two columns of different rows; an exclusion constraint over `ARRAY[lower(name), lower(name_ar)]` with `&&` would need the `btree_gist` extension), and either would fail to build on existing violations, which it cannot exempt. Reasoned from the seeds, without reading `vms`: `seed-demo`'s five departments use ten distinct values (Executive Office, Finance, IT, Operations, Human Resources; المكتب التنفيذي، المالية، تقنية المعلومات، العمليات، الموارد البشرية); its conversion (B10-27) never gives an Arabic name another department shows in either language, and leaves a department with only its Arabic-only name when one would collide; `seed-e2e` has English names only. A database holding only seeded departments therefore satisfies the rule. But from revision `0012` until this fix the API accepted exactly the writes the review demonstrated, and departments people created on `vms` keep what they typed (B10-28), so `vms` or any deployment may already hold a pair, and `alembic upgrade head` must not fail on it. **Instead:** every department change that names a department (`POST`, and a `PATCH` with `name` or `name_ar`) takes the company row `FOR UPDATE` instead of `FOR KEY SHARE` (`lock_company_for_change`), as company settings and role changes do; two such changes in one company run one after the other, and under READ COMMITTED the second's lookups see the first's committed department. A `PATCH` of `is_active` alone keeps `FOR KEY SHARE`. The lock order is unchanged (company, then the department row, then visits). Visit and visitor changes, which take the company row `FOR KEY SHARE`, wait for a naming change to commit (a short admin transaction), as they already wait behind a role change. The two unique indexes stay, and still turn a same-language race into the 409 they did. | The task's condition: a migration must not fail on existing data, and a conditional migration would leave the schema different per database (`test_models_match_migration`). The row lock makes the rule race-free without an index. Operators can list existing pairs with `SELECT a.company_id, a.id, b.id FROM departments a JOIN departments b ON a.company_id = b.company_id AND a.id < b.id AND (lower(a.name) IN (lower(b.name), lower(b.name_ar)) OR lower(a.name_ar) IN (lower(b.name), lower(b.name_ar)));` and rename one of each pair; nothing here does that on `vms`. |

### Tests (B10-29)

- `tests/integration/test_departments_and_company.py`, 7 new: a new name equal to another department's Arabic name, with
  or without an Arabic name of its own, and the swapped «العمليات» / "Operations" case (409 on `name`, ignoring case); a new
  Arabic name equal to another department's name, whether or not that department has an Arabic name (409 on `name_ar`),
  the same language reported first; the review's calls beside Finance / «المالية»; inactive departments count and another
  company's do not, in both directions; renames in either language and both at once, nothing written or audited by a
  refusal, a cleared Arabic name never conflicting; a department's own values (Arabic name = name, case changes, swapping
  its two names); a legacy pair that already shares a value: other values, activity and a case change pass, a new shared
  value is refused. Every 409 is asserted with its code, message and `details.field`.
- `tests/integration/test_department_races.py` (new, `committed`, 3 cases): the first administrator's request is held after
  its insert and before its commit (a one-shot gate on `DepartmentRepository.add`); the second (a create on `name`, a
  rename on `name_ar`, the swapped names) must wait for a lock, then answers 409 on the right field, and exactly one
  department holds the value. With the company row back at `FOR KEY SHARE` all three fail ("the second request ran beside
  the first"), checked by temporarily reverting the lock.
- Changed: `test_cli.py::test_seed_demo_leaves_the_arabic_only_demo_where_a_person_changed_it` created "Ops" / «العمليات»
  through the API while Operations was still named «العمليات», the very collision now refused; it now asserts the API's 409
  on `name_ar` and inserts that department directly, as data written before the rule (which the seed's conversion must
  still respect). `test_visit_concurrency.py::_move_while_the_department_changes` held only the department row as "the
  lock the change takes first"; a rename now takes the company row `FOR UPDATE` first, so the hold takes the same locks as
  the service. Holding the department row alone and then letting the service take the company row deadlocked against the
  waiting visit change, which a real rename cannot do, because it locks the company row first.

### Verification (B10-29)

Final gate run, after the lead's widening to both languages and the audit-details fix (reference machine; throwaway
backend databases; E2E on 8700/5199 against `vms_e2e`):

- Backend (`backend/`): `ruff check .` all checks passed; `ruff format --check .` 253 files already formatted; `mypy` no
  issues in 134 source files.
- `pytest`: 3,038 passed, 3 skipped (the opt-in volume checks), 0 failed, 667.81 s. `pytest --committed-first`: 3,038
  passed, 3 skipped, 0 failed, 722.34 s. (Before: 3,028 + 3.) The machine was busy during these runs; the same suite took
  271.70 s earlier the same day. One earlier full run under that load failed `test_access_log.py::
  test_the_response_time_excludes_background_work` (a trivial request took 530.6 ms against its 500 ms bound; no
  department code on that path); the file passed alone (3 passed) and the whole suite passed on the rerun above.
- Frontend (`frontend/`): `npm run typecheck` and `npm run e2e:typecheck` exit 0; `npm run lint` (oxlint --deny-warnings)
  exit 0, no diagnostics; `npm test` 129 files, 1,390 tests passed, 0 failed, 110.61 s (before: 1,383).
- `npm run e2e -- --retries=0`: 256 tests, 238 passed, 18 skipped (by their project conditions), 0 failed, 6.9 minutes
  (before: 253 / 235 / 18). The 3 new tests are the audit-details axe check in desktop, tablet and mobile.
- `python -m unittest discover -s deploy/verify -p "test_*.py"`: 33 tests OK.
- Afterwards the cluster holds `postgres`, `vms` and `vms_e2e`.
