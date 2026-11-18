# P2P Receipt Sharing: Technical Plan (rev 3)

Status: design, not implemented. Supersedes rev 2 (group-scoped tickets, per-group Realtime topics, Supabase JWT on every client). Section 16 lists what changed and why.

Spec links: [database-and-sync-spec.md](./database-and-sync-spec.md), [architecture.md](./architecture.md), [coding-standards.md](./coding-standards.md).

Design in one paragraph: receipts stay on devices. All signaling goes through our API, which authorizes every single message against the live database using the existing HMAC session, under one rule: a receipt is visible to whoever can currently read its transaction. Supabase Realtime is used only as a push pipe into per-user, receive-only inboxes; clients never publish to Realtime and never hold a Supabase Auth session for P2P. Bytes move over WebRTC DataChannels and are accepted only if they match the hash in the synced pointer. Availability is improved by pushing receipts to online co-members at attach time and prefetching on sync; an end-to-end encrypted relay is an opt-in later phase that requires the user to relax "we never store receipts" to "we never store readable receipts".

## 1. Goals and non-goals

Goals

- Receipt bytes never reach Supabase, the API, or any server we run (phases A to C). They live in Dexie `localReceiptBlobs` on devices of people who can read the transaction.
- Access rule is per transaction (section 3): group expense = current members of its group; non-group expense = its current participant roster; deleted expense, deleted group, or detached receipt = nobody. Moving an expense between scopes moves access with it.
- Nobody outside the rule can fetch a receipt, learn that it exists, or learn that someone asked for it, even with a modified client or a willing seeder.
- Auth stays server-side: password and Google sign-in keep working exactly as today; no client-side `signInWithPassword`.
- Integrity: a requester keeps bytes only if they hash to the `sha256` of its own synced pointer.
- Web, Android (Capacitor WebView), iOS (WKWebView), Tauri; no native daemon.
- $0 at small scale on existing vendors (Supabase Free, Cloudflare TURN free allowance).

Non-goals

- Availability when no device holding the receipt is in the foreground (phases A to C). The UI says so plainly. Section 13 covers the opt-in fix.
- Background seeding on mobile.
- Revoking a copy someone was entitled to and already downloaded (screenshots exist).
- Protecting against a person with current access who edits the expense (they can already edit it).
- Hiding IP addresses between two people who both have access to the same transaction (optional relay-only mode, section 10).
- Protecting against our own API acting maliciously (it is the authorization authority and already holds every ledger row). Section 4, A7.
- Demo sandbox users (`authMethod: 'demo'`): P2P disabled.

## 2. Facts this design is built on

Verified in code (2026-11-15):

- Sessions are custom HMAC tokens (`issueSessionToken`, `GRANT_TOKEN_SECRET`, 7 days, `typ: WS-JWT`); `verifyRequestAuth` resolves `{ userId, email, authMethod }`. Supabase cannot verify them.
- Password login runs `signInWithPassword` on the server and discards the Supabase session. Google clients hold a Supabase session in the browser `supabase-js` client. No Realtime channel is used anywhere today.
- `expenses.group_id` is nullable. Non-group expenses store the roster in `ad_hoc_participants` JSONB: `[{ id, displayName, invitedEmail, upiId, avatarInitials, memberOrder }]`. `payers[].memberId` and `splits[].memberId` reference roster ids (spec rule 3 in database-and-sync-spec.md "Every member_id ... belongs to ... ad_hoc_participants"); `validateExpenseInvariants` checks sums only, not this membership.
- Roster ids are client-chosen (`adhoc_arjun`), not profile ids. A roster entry identifies an app user only through `invitedEmail` or an `id` equal to a profile id. A payer or split id with no roster entry identifies nobody.
- For non-group expenses the client sets `createdByMemberId` to a roster id (`LedgerContext.tsx` `myMemberId`). `is_standalone_expense_participant()` and `isUserParticipantInStandaloneExpense()` compare it to the caller's profile id, so the "creator" shortcut only fires when the roster id equals a profile id. The field is client-written.
- `ExpenseEditorModal` lets a user change the scope of an existing expense (`expense-group-scope-select`): group to non-group, non-group to group, group A to group B, keeping the same expense id and its receipts. Moves are real.
- Receipt pointers live in `expenses.receipts` JSONB and `receipt_attachments` (`id` PK, `expense_id`, denormalized `group_id`, `sha256_hex`). `sha256` is `sha256Hex(dataUrl)` over the full `data:<mime>;base64,...` string. `receipt_attachments` rows are upserted from sync and never deleted when a receipt is removed from the JSONB.
- Receipt ids are guessable (`rcp_<expenseId>_<Date.now()>`).
- `LocalReceiptBlobRecord` has `id, expenseId, groupId, mimeType, sizeKb, dataUrl, ...`; `groupId` goes stale when an expense moves.
- The API is a stateless Bun container (`Dockerfile.api`, Pyrite Cloud), not a Cloudflare Worker.

Assumed fixed by the concurrent server/migration/sync work (this plan depends on them and does not re-specify them): per-entity authorization instead of whole-table checks; delta sync instead of full snapshots; exact lowercase email equality instead of `ilike`; no PostgREST grants to `authenticated` on `wise_spliter`; no demo writes in production; a removed group creator is not a member.

Verified in official docs (fetched 2026-11-15; URLs in section 12):

- Realtime Authorization: private channels are authorized by RLS on `realtime.messages`; claims are readable via `current_setting('request.jwt.claims')`; policies are cached per connection and re-evaluated only on join or when a new JWT is sent; a client is disconnected when its JWT expires without refresh. Do not `ALTER TABLE realtime.messages`.
- Broadcast can be sent server-side via REST (`POST /realtime/v1/api/broadcast/<topic>/events/<event>?private=true`, `apikey` header, also a batch endpoint) or SQL `realtime.send(..., private => true)`. A private broadcast reaches only private subscribers; a public one only public subscribers. Only database-sent messages are replayable (72 h retention).
- JWT signing keys: you can mint your own JWTs by importing an ES256 private key. A newly imported key is standby and not yet accepted; after "Rotate keys" both the current and previously used key are accepted until one is revoked. Minted JWT needs `role` set to an existing Postgres role and a future `exp`; `sub` is optional. Supabase products (Auth, Data API, Storage, Realtime) honor revocation immediately. `supabase gen signing-key --algorithm ES256` generates the key.
- Third-party auth: custom OIDC needs an HTTPS issuer with discovery and asymmetric `kid`-tagged keys, a `role` claim, and is not available in the Supabase CLI. Free plan includes 50,000 third-party MAU.
- Realtime Free: 200 concurrent connections, 100 messages/s, 100 joins/s, 100 channels per connection, 256 KB broadcast payload, 2,000,000 messages/month. A broadcast counts 1 sent plus 1 per receiving subscriber.
- Durable Objects run on Workers Free (SQLite-backed only): 100,000 requests/day, incoming WebSocket messages billed 20:1, 13,000 GB-s/day; hibernating idle WebSockets incur no duration. Workers Free: 100,000 requests/day.
- R2 free: 10 GB-month storage, 1 million Class A, 10 million Class B operations per month, egress free, deletes free. Lifecycle expiry is in days; objects are typically removed within 24 h of expiry.
- Supabase Storage Free: 1 GB storage; egress quota 5 GB uncached plus 5 GB cached.
- Cloudflare TURN: $0.05 per GB outbound; first 1,000 GB per month free.

## 3. The access rule (single predicate)

`can_read_receipt(pid, rid)` is true only when all hold, evaluated against live rows:

1. `ra := receipt_attachments WHERE id = rid` exists, and `e := expenses WHERE id = ra.expense_id` exists with `e.deleted_at IS NULL`.
2. `e.receipts @> [{"id": rid}]` (receipt still attached; a stale `receipt_attachments` row grants nothing).
3. `can_read_expense(pid, e)`:
   - Group expense (`e.group_id IS NOT NULL`): `groups.deleted_at IS NULL` and an active row in `group_members` for that group (`removed_at IS NULL`) with `user_id = pid` or `lower(invited_email) = lower(profile(pid).email)`. No creator shortcut.
   - Non-group expense (`e.group_id IS NULL`): some roster element of `e.ad_hoc_participants` has `id = pid` or `lower(invitedEmail) = lower(profile(pid).email)`. Payers and split participants are covered because they are roster ids. No `created_by_member_id` shortcut (open question 2).

Rules that follow:

- Access is resolved from the expense's current `group_id`, never from `receipt_attachments.group_id` or the device's `LocalReceiptBlobRecord.groupId`.
- `receipt_attachments.expense_id` and `sha256_hex` are immutable after insert (trigger, section 11). This is what makes pointer injection useless: writing `rid` of expense E2 into E1's JSONB fails check 1/2 for E1.
- `can_read_expense` must be the same predicate the delta sync uses to decide what a user may read. If they diverge, P2P either leaks what sync hides or denies what the user can see. One SQL function, used by both.
- No API accepts a hash. No UNIQUE constraint on `sha256_hex`. Devices never look up blobs by hash.

## 4. Threat model

Assets: receipt bytes; the fact that a receipt exists; the fact that someone requested it; pointer metadata (expense id, hash, size).

| # | Adversary | Must not |
| --- | --- | --- |
| A1 | Internet user with the publishable key | Read any inbox, publish to any inbox, call P2P endpoints |
| A2 | Signed-in user with no access to expense E | Fetch, discover, or learn of demand for E's receipts; distinguish "exists, no access" from "does not exist" |
| A3 | Removed group member, modified client, still connected | Receive any signaling about G's expenses after removal; fetch after a bounded window (section 9) |
| A4 | Person with access to E1 only, including via a seeder who also has E2 | Fetch E2 receipts by naming E2 ids or hashes, or by writing E2 ids into E1's pointer JSONB |
| A5 | Malicious seeder with access | Make a requester keep wrong bytes |
| A6 | Malicious requester with access | Exhaust a seeder's battery or data without limit |
| A7 | Supabase Realtime (transport) or anyone who can rewrite messages in it | Read bytes. Accepted: Supabase could rewrite SDP and MITM; same trust as the database it already hosts. Our API is the authority and is trusted |
| A8 | TURN relay | Read bytes (DTLS) |
| A9 | Holder of leaked TURN credentials | Use our TURN quota at scale |
| A10 | Non-group participant removed from E's roster | Same as A3, scoped to E |
| A11 | Group member when E moves from group G to non-group (or to group H) and they are not in the new scope | Same as A3, scoped to E; the new scope's people gain access immediately |
| A12 | Non-group participant who rewrites `created_by_member_id` to themselves before being removed | Keep access through a creator shortcut (there is none) |
| A13 | Holder of a minted inbox token (stolen or own) | Read another user's inbox, publish anything, use it as a general Supabase session with data access |

Accepted leakage:

- Our API and Supabase see: who requested which receipt ids of which expenses, timing, SDP (IP candidates, DTLS fingerprints). Same trust as ledger rows they already hold. The server knows each receipt's SHA-256, so it could confirm a guessed image.
- STUN/TURN providers see IPs, timing, volume.
- Two people with access to the same expense see each other's IP candidates when they connect.

## 5. Signaling authorization: options and decision

The hard constraint: clients hold only our HMAC session. Realtime can only authorize a JWT it trusts, and its RLS decision is cached per connection, so per-message checks are impossible inside Realtime. Therefore all authorization moves to our API, per message, and the only question is how messages are delivered to the recipient.

| Option | How it authorizes | Delivery | $0 limits | New moving parts | Verdict |
| --- | --- | --- | --- | --- | --- |
| a1. API relay, long-poll (`GET /api/p2p/inbox`) | HMAC session per request; per-message SQL check | Poll interval latency; held requests re-query an inbox table | No vendor quota; DB load grows with open clients (each held poll re-queries) | Inbox table, cleanup job; Pyrite request timeout unknown | Fallback if the key import (option c) is rejected |
| a2. Cloudflare Worker + Durable Object per user inbox, WebSocket hibernation | Worker verifies a short-lived ES256 connect ticket from our API; publishing still goes through our API for the SQL check | Push | Workers Free 100,000 req/day; DO 100,000 req/day (incoming WS 20:1), 13,000 GB-s/day; no 200-connection cap | New vendor deploy, wrangler, secret in two places, separate local dev | Revisit only if Realtime's 200 concurrent connections becomes the binding limit |
| b. Server-minted Realtime JWT, clients publish to per-expense private topics with RLS | RLS on join, cached until token expiry | Push | Realtime Free | Key import; per-expense topics hit 100 channels per connection; revocation window = token TTL | Rejected: no per-message check, channel cap |
| b'. Third-party custom OIDC with our API as issuer | Same as b | Push | 50,000 third-party MAU free | Public HTTPS discovery endpoint; not available in Supabase CLI (no local parity) | Rejected |
| c. API publishes via Realtime REST; clients subscribe receive-only with a server-minted, inbox-scoped JWT | HMAC session + per-message SQL check at our API; Realtime RLS only lets a token read its own inbox; no INSERT policy, so clients cannot publish | Push | Realtime Free: 200 connections, 2,000,000 messages/month | One-time ES256 key import; one RLS policy; one mint endpoint | **Chosen** |

Why c: every message is authorized against current rows (revocation for signaling is immediate, no epochs, no per-group topics), clients cannot publish to Realtime at all, the read right is "your own inbox" which never changes with group membership so Realtime's policy cache is harmless, and it adds no vendor. Sign-in is untouched: the token is minted by the API after `verifyRequestAuth`, carries no `sub`, and can only read one topic.

### 5.1 Inbox token (option c details)

- Key: generate with `supabase gen signing-key --algorithm ES256`; import as a standby key in the project's JWT signing keys; it becomes accepted only after a rotation. Two operational choices (open question 1): (i) leave it in use, so Supabase Auth also signs Google sessions with it; treat the private key exactly like `SUPABASE_SECRET_KEY`; or (ii) rotate back so it sits in "previously used", which the docs say stays accepted until revoked. Server env: `P2P_RT_SIGNING_JWK` (private JWK), `P2P_RT_KID`. Signing uses `node:crypto` ES256 with `dsaEncoding: 'ieee-p1363'`; no dependency.
- `POST /api/p2p/rx-token` (HMAC auth, non-demo, 30 per user per hour) returns `{ "token": "<jwt>", "topic": "p2p:u:<pid>", "exp": <unix s> }`.
- Header `{ "alg": "ES256", "typ": "JWT", "kid": "<P2P_RT_KID>" }`. Payload:

```json
{ "role": "authenticated", "ws_scope": "p2p_rx", "ws_pid": "<profile id>", "iat": 1763200000, "exp": 1763200600 }
```

- No `sub`: `auth.uid()` is NULL, so every existing `wise_spliter` helper returns false; with the concurrent revocation of `authenticated` grants on `wise_spliter`, the token has no data access there. Blast radius check: any `TO authenticated` policy elsewhere in this Supabase project that does not test `auth.uid()` would admit it. Every Google user's real session already has that same power, so this adds no new class of access; still audit (open question 1). Spike: a dedicated Postgres role instead of `authenticated`.
- TTL 600 s. The client uses a dedicated `supabase-js` instance with `accessToken` returning the cached token, and calls `realtime.setAuth()` with a fresh token at 80% of TTL.
- Policy (no INSERT policy for `p2p:` topics, so clients cannot publish):

```sql
CREATE POLICY ws_p2p_inbox_read ON realtime.messages
  FOR SELECT TO authenticated
  USING (
    realtime.messages.extension = 'broadcast'
    AND (current_setting('request.jwt.claims', true)::json ->> 'ws_scope') = 'p2p_rx'
    AND (SELECT realtime.topic()) = 'p2p:u:' || (current_setting('request.jwt.claims', true)::json ->> 'ws_pid')
  );
```

- Server publishing: REST batch `POST {SUPABASE_URL}/realtime/v1/api/broadcast` (or per-message `.../broadcast/<topic>/events/sig?private=true`) with `apikey: SUPABASE_SECRET_KEY`. REST, not `realtime.send()`, so SDP is not written to `realtime.messages` (spike verifies).

## 6. Signaling protocol

Identifiers: `pid` profile id; `dev` random 22-char base64url per install (kvStore); `sid` random 22-char base64url per fetch session. `dev` and `sid` are routing filters, not security boundaries.

### 6.1 Client to API: `POST /api/p2p/signal`

Body at most 16 KB, `sdp` at most 12 KB, `rids` at most 20 ids matching `SAFE_IDENTIFIER_REGEX`.

```json
{ "v": 1, "t": "want",   "sid": "<s>", "dev": "<d>", "rids": ["<rid>"], "to": null }
{ "v": 1, "t": "have",   "dev": "<d>", "rids": ["<rid>"] }
{ "v": 1, "t": "offer",  "sid": "<s>", "dev": "<d>", "to": "<pid>", "toDev": "<d>", "rids": ["<rid>"], "sdp": "<offer>" }
{ "v": 1, "t": "answer", "sid": "<s>", "dev": "<d>", "to": "<pid>", "toDev": "<d>", "rids": ["<rid>"], "sdp": "<answer>" }
```

Server handling (stateless; one SQL RPC per message):

1. `verifyRequestAuth` (HMAC); reject demo (403), malformed (400), oversize (413), rate limit (429). Per user: 60 signals/min, 600/hour.
2. Respond `202 {"ok":true}` immediately. Authorization and publishing run after the response, so status and timing are identical for "no access", "does not exist", and "routed".
3. Compute `x`, the list of `[rid, expenseId]` pairs, server-side only:
   - `want` with `to = null`: `p2p_targets(caller, rids)`: for rids the caller can read, every other pid that can read them, plus the caller (other devices). At most 25 recipients (group: by `group_members.last_accessed_at` desc; non-group: roster order). Each recipient gets only the pairs it can also read.
   - `want` with `to`, `have`, `offer`, `answer`: `p2p_shared_rids(caller, to, rids)`: pairs both can read. `have` fans out like an untargeted `want`.
4. If `x` is empty, drop silently. Otherwise publish to `p2p:u:<recipient>`, event `sig`. Client-supplied rids are never echoed; only server-computed `x`.

### 6.2 API to inbox (event `sig`)

```json
{ "v": 1, "t": "want",   "sid": "<s>", "from": "<pid>", "fromDev": "<d>", "x": [["<rid>", "<expenseId>"]] }
{ "v": 1, "t": "have",   "from": "<pid>", "fromDev": "<d>", "x": [["<rid>", "<expenseId>"]] }
{ "v": 1, "t": "offer",  "sid": "<s>", "from": "<pid>", "fromDev": "<d>", "toDev": "<d>", "x": [["<rid>", "<expenseId>"]], "sdp": "<offer>" }
{ "v": 1, "t": "answer", "sid": "<s>", "from": "<pid>", "fromDev": "<d>", "toDev": "<d>", "x": [["<rid>", "<expenseId>"]], "sdp": "<answer>" }
```

Clients validate shape, ignore `toDev` other than their own, ignore unknown `sid`s, and drop anything else silently. Because only the API can publish to inboxes, anything in an inbox has passed the server check at the moment it was sent.

### 6.3 Flow

1. Requester: `want` (or a `want` with `to` after receiving a `have`).
2. Each recipient device: for each `[rid, eid]` in `x`, holds it iff a local record has `id === rid` and `expenseId === eid` and is not evicted. If none, stays silent. Otherwise creates an `RTCPeerConnection`, waits for ICE gathering (cap 3 s, non-trickle), sends `offer` with the held rids.
3. Requester answers the first offer only. Later offers time out on the seeder side (10 s).
4. Timeouts: 8 s for any offer, 15 s to DataChannel open, 60 s transfer. Up to 2 further `want`s, then "not available right now".

Why no tickets, epochs, or fingerprint binding (rev 2 had them): the SDP, and with it each side's DTLS fingerprint, travels only through our API, which authenticated both posters by HMAC session and checked both against the rule. A third party cannot inject into inboxes (no INSERT policy). The remaining MITM capability belongs to our API and Supabase, which are inside the trust boundary (A7).

## 7. Transfer and integrity

DataChannel: label `wsp2p/2`, ordered, reliable, `binaryType = 'arraybuffer'`; one peer connection per `sid`.

Text frames (JSON, at most 4 KB):

```json
{ "t": "get",  "sid": "<s>", "rid": "<rid>" }
{ "t": "meta", "rid": "<rid>", "bytes": 28672, "mime": "image/webp" }
{ "t": "err",  "code": "denied" }
{ "t": "done", "rid": "<rid>" }
```

Binary frames: raw 16 KB chunks. `err` codes: `denied`, `busy`. Never `not_found`.

Seeder serves `get` only if: `sid` is this connection's session; `[rid, eid]` is in the `x` of the latest server-delivered `answer` for this `sid`; the local record matches `id === rid && expenseId === eid`; per-peer limits allow. Backpressure: pause above 256 KB `bufferedAmount`, resume at `bufferedAmountLowThreshold` 64 KB. Close after all requested rids, after 60 s idle, or 120 s after open.

Requester keeps bytes only if, against its own synced pointer for `rid` on `eid`:

- `meta.mime` equals pointer `mimeType` and is in `ALLOWED_RECEIPT_MIME_TYPES`;
- `meta.bytes` at most `MAX_RECEIPT_BYTES` (5 MiB) and at most `pointer.sizeKb * 1024 + 1024`; abort as soon as received bytes exceed `meta.bytes`;
- `sha256Hex('data:' + mime + ';base64,' + base64(bytes)) === pointer.sha256` (same digest as today's pointer; `crypto.subtle.digest` over the UTF-8 data URL if the pure-JS hash is slow on low-end Android).

Then write `{ id: rid, expenseId: eid, origin: 'peer', lastAccessedAt }`. Otherwise discard and try another seeder.

Seeder limits (A6): 2 concurrent uploads; 10 uploads per remote `pid` per 10 min; 50 MB uploaded per device per day (user setting).

## 8. Co-seeding and prefetch

- Scope is the transaction: a device serves `rid` only as `[rid, eid]` with `eid` its own record's `expenseId`, and only when the server put that pair in `x`.
- Authored blobs (`origin: 'authored'`) are served while foregrounded; never auto-evicted.
- Fetched blobs (`origin: 'peer'`) are served the same way; 50 MB LRU budget by `lastAccessedAt`.
- Push at attach: after the new pointer is synced, the uploader sends `have`. Online recipients with prefetch on reply with a targeted `want` (`to` = uploader). Uploader serves 2 at a time; the rest retry with backoff and may be served by whoever finished first (they send `have` too).
- Prefetch on sync: after each pull, for pointers on readable expenses missing locally, created in the last 30 days, at most 1 MB, setting on, budget allows: batched `want` (20 rids). Cellular cannot be detected on every platform (open question 4).
- Connection lifetime: subscribe to the own inbox while foregrounded and P2P enabled (one channel). On `pause` / `visibilitychange: hidden`: unsubscribe, close peer connections. Resubscribe and re-run prefetch on resume.

## 9. Eviction and revocation

Honest-client hygiene (a modified client can ignore it; sections 5 to 7 do not depend on it):

| Trigger | Detected by | Action |
| --- | --- | --- |
| Lost access to expense E (removed from group, removed from roster, E moved to a scope I am not in, group deleted, E deleted) | `POST /api/p2p/access` on app open and after each sync; delta sync tombstones if the concurrent sync work emits them | Delete `origin: 'peer'` blobs with `expenseId = E`; stop serving authored blobs of E (keep them, it is the user's own photo, open question 8) |
| Receipt detached from E | delta sync | Delete the peer copy, stop serving |
| Logout | local | Delete all `origin: 'peer'` blobs, drop the inbox token |

`POST /api/p2p/access` takes `{ "expenseIds": [...] }` (at most 200, ids the device holds blobs for) and returns `{ "allowed": [...] }`, the subset the caller can read now. It reveals nothing beyond the caller's own access; "no access" and "does not exist" look the same.

Revocation windows after an access-losing change commits (A3, A10, A11):

| Channel | Window |
| --- | --- |
| New signaling (want, have, offer, answer) to or from the person | None: the next message is checked against live rows and dropped |
| Session already answered before the change | At most 15 s to open plus 120 s connection cap, only for `[rid, eid]` pairs authorized at the last routed message |
| Receipts added to E after the change | Never reachable |
| Copies already on the device | Not revocable (non-goal); honest clients delete at next `/api/p2p/access` |
| Inbox token | Unaffected; it reads only the person's own inbox, which receives nothing about E any more |

A12 is closed because the predicate has no creator shortcut.

## 10. NAT, TURN, mobile realities

- STUN `stun:stun.cloudflare.com:3478`. Direct paths fail on some carrier-grade NAT; the share for our users is unknown and is measured in phase 0 and phase C from `getStats()` selected candidate pair type, with no ids logged.
- TURN: `GET /api/p2p/ice` returns Cloudflare TURN credentials (TTL 900 s) to authenticated non-demo users, 20 per user per hour. Keys `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN` are server-only. A9 is bounded by TTL, rate limit, attribution, and the revoke API.
- Optional privacy mode: `iceTransportPolicy: 'relay'` hides IPs from co-members.
- iOS WKWebView apps are suspended shortly after backgrounding; Android WebView is throttled and killed unpredictably. Treat backgrounded as offline.
- Realistic UX: fetching works when someone holding the receipt has the app open at the same time as the viewer. Common during the trip or dinner when receipts are added and push-at-attach fills co-members' caches; weak weeks later. UI copy: "Stored on Arjun's phone. Available when Arjun or someone who has it opens the app."

## 11. Schema, RLS, and API changes (described, not applied)

Migration `0004_p2p_receipt_access.sql`:

1. `can_read_expense(p_pid TEXT, p_expense_id TEXT) RETURNS BOOLEAN` as in section 3, or reuse the single read predicate the concurrent sync work introduces. `SECURITY DEFINER`, `STABLE`, `SET search_path = ''`.
2. `p2p_targets(p_pid TEXT, p_rids TEXT[]) RETURNS TABLE (recipient TEXT, rid TEXT, expense_id TEXT)` and `p2p_shared_rids(p_a TEXT, p_b TEXT, p_rids TEXT[]) RETURNS TABLE (rid TEXT, expense_id TEXT)` and `p2p_accessible_expenses(p_pid TEXT, p_expense_ids TEXT[]) RETURNS SETOF TEXT`. All `SECURITY DEFINER`, `SET search_path = ''`, runtime `current_user IN ('service_role','postgres')` check like `pull_changes`, EXECUTE revoked from `PUBLIC, anon, authenticated`, array length capped in SQL (20, 20, 200). Recipient resolution: group branch returns `user_id`, or the profile id whose `lower(email)` equals `lower(invited_email)`; non-group branch returns the roster `id` if a profile has that id, or the profile matching `invitedEmail`. Existing indexes cover it: `receipt_attachments` PK, `expenses` PK, `idx_group_members_active_user`, `idx_group_members_active_email`, `idx_profiles_lower_email`.
3. Trigger `BEFORE UPDATE ON receipt_attachments`: raise if `expense_id` or `sha256_hex` changes. Requires the concurrent per-entity ownership check so a foreign row cannot be upserted over in the first place.
4. `realtime.messages` policy `ws_p2p_inbox_read` (section 5.1). No INSERT policy for `p2p:` topics. Audit existing `realtime.messages` policies in the project. Recommend disabling "Allow public access" in hosted Realtime settings; confidentiality does not depend on it because private broadcasts never reach public subscribers.
5. Nothing else stored: no holders registry, no epochs table, no inbox table (unless option a1 is chosen).

Project configuration: import the ES256 signing key (section 5.1); local dev needs the same key accepted by the CLI stack (spike).

API (`src/server/`, all HMAC-authenticated, non-demo, existing CORS/CSRF/origin checks):

| Endpoint | Purpose |
| --- | --- |
| `POST /api/p2p/rx-token` | Mint inbox token |
| `POST /api/p2p/signal` | want, have, offer, answer (section 6) |
| `POST /api/p2p/access` | Which of these expenses can I still read |
| `GET /api/p2p/ice` | TURN credentials |

Server env: `P2P_RT_SIGNING_JWK`, `P2P_RT_KID`, `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN`; add to `assertProductionSecretsConfigured`.

Client:

- Dexie version bump: `localReceiptBlobs` add `origin: 'authored' | 'peer'`, `lastAccessedAt`; index `[expenseId+id]`. Serving and rendering look up by `(expenseId, id)` only; `groupId` is display-only.
- New receipt ids: `rcp_` + 22-char base64url from `crypto.getRandomValues`, so ids stop revealing expense id and time. Server PK-conflict errors must be generic.
- `src/domain/p2p/` pure modules (transfer state machine, `shouldServe`, message validation); `src/sync-engine/p2p-signaling.ts` (inbox subscription, `/api/p2p/signal` calls).

## 12. Free-tier budget

Messages per fetch, one online device per person: `want` to m recipients costs m sent plus m received; each of s offers costs 2; one answer costs 2. Total 2m + 2s + 2. Example m = 4, s = 2: 14 messages, so 2,000,000 messages/month covers about 142,000 fetches. Push at attach in a group of n, all online and prefetching from the uploader: `have`, targeted `want`, `offer`, `answer` each cost 2(n - 1), total 8(n - 1); n = 5 gives 32 per receipt, about 62,500 fully replicated receipts per month.

| Resource | Free limit | Our use | Source |
| --- | --- | --- | --- |
| Realtime concurrent connections | 200 | 1 per foregrounded P2P client. Binding limit. Pro: 500 included, $10 per 1,000 extra | <https://supabase.com/docs/guides/realtime/limits> , <https://supabase.com/docs/guides/realtime/pricing> |
| Realtime messages | 2,000,000/month | Formula above | <https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages> |
| Messages/s, joins/s | 100 each | One join per app foreground | <https://supabase.com/docs/guides/realtime/limits> |
| Channels per connection | 100 | 1 | same |
| Broadcast payload | 256 KB | SDP is a few KB; capped at 12 KB | same |
| Postgres | Free project | 1 RPC per signal, 1 per access check; no new tables | n/a |
| API (Pyrite) | Unknown to this plan | 1 + s + 1 HTTP requests per fetch | open question 7 |
| TURN | 1,000 GB/month, then $0.05/GB | Relayed fetches only | <https://developers.cloudflare.com/realtime/turn/> , <https://developers.cloudflare.com/realtime/pricing/> |

Reference for the options not chosen: Durable Objects <https://developers.cloudflare.com/durable-objects/platform/pricing/> , <https://developers.cloudflare.com/durable-objects/platform/limits/> , <https://developers.cloudflare.com/durable-objects/best-practices/websockets/> ; Workers <https://developers.cloudflare.com/workers/platform/limits/> ; JWT keys <https://supabase.com/docs/guides/auth/signing-keys> , <https://supabase.com/docs/guides/auth/jwts> ; third-party auth <https://supabase.com/docs/guides/auth/third-party/overview> , <https://supabase.com/docs/guides/auth/third-party/custom-oidc> , <https://supabase.com/docs/guides/platform/manage-your-usage/monthly-active-users-third-party> ; Realtime authorization and broadcast <https://supabase.com/docs/guides/realtime/authorization> , <https://supabase.com/docs/guides/realtime/broadcast> ; R2 <https://developers.cloudflare.com/r2/pricing/> , <https://developers.cloudflare.com/r2/buckets/object-lifecycles/> ; Supabase Storage <https://supabase.com/docs/guides/storage/pricing> , <https://supabase.com/docs/guides/platform/manage-your-usage/egress> .

## 13. Fundamentally different designs for mobile availability

The core weakness of any pure P2P design: a receipt is reachable only while some holder's app is in the foreground at the same time as the viewer. Four designs, same access rule (section 3) for all:

| | D1. P2P, fetch on demand (sections 5 to 9) | D2. Store-and-forward to authorized devices at attach time | D3. End-to-end encrypted short-TTL relay blob | D4. Hybrid: D1 + D2 always, D3 opt-in |
| --- | --- | --- | --- | --- |
| What "we never store receipts" means | Literally true: no bytes, no ciphertext on any server | Literally true | False as stated. True as "we store only ciphertext we cannot read, deleted after N days" | Literally true unless the group opts in |
| Availability | Needs a holder and the viewer online together | Every person online at attach time gets a copy; later viewers still need a simultaneous holder, but there are more holders | Asynchronous: uploader online once; any current member can view within TTL | Best of both where opted in |
| Privacy | Server sees metadata and SDP | Same as D1 | Server sees ciphertext size, timing, uploader. Readable only if the server substitutes a device public key (active attack; no key transparency). Variant with the content key synced in the pointer is rejected: the server would hold key and ciphertext | Per group choice |
| Revocation | Server stops routing immediately | Same | Server stops issuing download URLs immediately; anyone who already fetched key and ciphertext keeps them (same as D1) | Same |
| Cost at small scale | $0 (section 12) | $0, more P2P bytes on the uploader's data plan, n - 1 copies | R2 free: 10 GB-month, 1M Class A, 10M Class B, free egress. Example arithmetic: 200 KB receipts with a 30-day TTL fit about 50,000 resident objects in 10 GB. Supabase Storage free: 1 GB (about 5,000 such objects) and 5 GB uncached egress | D1/D2 cost plus D3 for opted-in groups |
| Complexity | Baseline | Small increment over D1 (`have` + targeted `want`) | Large: device key registry (ECDH P-256 public key per device), AES-256-GCM per receipt, wrap content key per authorized device, re-wrap for new members and devices when any key holder is online, presigned upload/download (R2 needs SigV4 signing or a Worker binding), explicit deletes because lifecycle expiry is in days | D1 + D2 + D3 |
| UX | "Not available right now" is common after the trip | Good during the trip, weak for late joiners and late viewers | Good; after TTL falls back to D1 | Good where opted in |

Verdict and phasing:

- Phase A to C (recommended now): D4 without D3, that is D1 plus D2. It is the only option that keeps the literal promise, costs $0, and is the smallest build.
- Measure on-device (no ids): share of fetch attempts that end with zero offers, and time to first offer. Present the numbers to the user.
- Phase D (only if the user accepts the reworded promise): D3 as an opt-in per group or per expense ("Keep an encrypted copy for 30 days; we cannot read it"), used only when D1 gets no offer. Supabase Storage is the simplest start (already in the stack, signed URLs from the API); R2 when 1 GB is not enough. Migration 0003's `chk_receipt_local_only` and Storage cleanup would be revisited; that is a product decision, not a technical one.
- Not proposed: push notifications to wake seeders. iOS does not keep WebRTC alive from a push, and it adds FCM/APNs infrastructure (open question 5).

## 14. Phased test-first tasks

Each phase: failing tests first, then code; all five AGENTS.md gates pass at the end of each phase. Auth/topology change: user sign-off before phase A2 (AGENTS.md section 1).

Phase 0, spike (throwaway branch, nothing merged; results appended here):

- Imported ES256 key on hosted and local Supabase: minted token without `sub` subscribes to its own private inbox, is refused for another inbox, cannot publish, survives `setAuth` refresh, is disconnected at expiry. Option (ii) key state from 5.1 stays accepted. A custom Postgres role instead of `authenticated` works or not.
- REST broadcast with `private=true` reaches a private subscriber, does not reach a public one, and does not persist in `realtime.messages`.
- WebRTC DataChannel on Android WebView, iOS WKWebView, desktop Chromium/Firefox/Safari, Tauri; candidate pair types on at least two Indian mobile carriers and one office network.
- Pyrite request timeout and instance count (decides whether a1 is viable as fallback).

Phase A1, access predicate (SQL tests via `make migrate-verify`): group member allowed; removed member denied; removed creator denied; deleted group denied; deleted expense denied; detached receipt (row exists, not in JSONB) denied; non-group roster match by id and by email allowed; removed from roster denied; creator not in roster denied; expense moved group to non-group: old members denied, roster allowed; non-group to group and group A to group B likewise; rid injected into another expense's JSONB denied; `expense_id`/`sha256_hex` update raises; functions not executable by `anon`/`authenticated`; array caps enforced.

Phase A2, API: identical 202 for authorized, unauthorized, and nonexistent rids (status and body), publishing happens after response; demo 403; rate limits 429; size limits 413; server-computed `x` only, client rids never echoed; untargeted `want` never reaches anyone without access; `rx-token` claims and TTL; `/api/p2p/access` returns only readable ids. Realtime REST mocked.

Phase A3, Realtime integration (local Supabase): inbox read policy; no client publish; token refresh.

Phase A4, transfer core, pure (`src/domain/p2p/transfer.ts`, in-memory duplex): happy path; hash mismatch discarded; oversize `meta`; bytes beyond `meta`; mime mismatch; `get` for a pair not in `x` denied; `err` never reveals existence.

Phase A5, seeder decision, pure: `shouldServe(get, session, record)` refuses other expense with same id, same hash in another expense, stale `groupId`, evicted record.

Phase A6, signaling client (`src/sync-engine/p2p-signaling.ts` over an in-memory hub): validation drops malformed input; `toDev`/`sid` filtering; timeouts and failover.

Phase B, storage and eviction: Dexie bump, `origin`, LRU, `/api/p2p/access` eviction per trigger row in section 9.

Phase C, UI and e2e (Playwright, two and three contexts, local Supabase): group fetch from uploader; fetch from co-seeder after uploader closes; non-group participant fetch; removed group member gets no inbox message and no bytes; removed roster participant likewise; expense moved group to non-group (ex-member denied, roster participant allowed); deleted expense denied; non-member's `want` produces no inbox message anywhere; then push-at-attach, prefetch setting, TURN, candidate-type and zero-offer telemetry.

Phase D, conditional: encrypted relay (section 13), only after the user decides.

## 15. Open questions (user decisions)

1. Approve the server-minted, receive-only Realtime token (option c) and the one-time signing key import, choosing key state (i) or (ii)? Is this Supabase project shared with other apps, and do any of their policies admit any `authenticated` JWT without checking `auth.uid()`? If either answer is a problem, fall back to API long-poll (a1).
2. Non-group creator: should the creator keep access after removing themselves from the roster? This plan says no (the field is client-written, A12). Whatever is chosen must match the ledger read predicate.
3. Enforce "payer and split ids are roster ids" on write (spec rule 3)? Not required for P2P safety, but keeps "participants" unambiguous.
4. Prefetch and push-at-attach default: on or off; cellular allowed? No network-type plugin is installed and Safari lacks the Network Information API.
5. Push nudges via FCM/APNs to ask a holder to open the app: wanted, given new infrastructure?
6. Will the concurrent delta-sync work emit access-loss tombstones? If not, `/api/p2p/access` is the only eviction signal (sufficient, but slower).
7. Pyrite: request timeout, instance count, and pricing for idle connections (only matters for fallback a1).
8. When a person loses access, keep their own authored photo on their device (this plan) or delete it too? When an expense is soft-deleted, peer copies are deleted; a restore relies on the uploader still holding it. Acceptable?
9. Is "we never store readable receipts" an acceptable promise for an opt-in phase D?
10. Local dev parity for the imported signing key and the Realtime public-access setting.

## 16. Changes from rev 2

- Clients no longer need Supabase sessions; password sign-in stays on the server.
- Scope moved from group to transaction; non-group expenses are first-class (rev 2 deferred them to phase 9).
- Per-group epoch topics, ES256 swarm tickets, and DTLS fingerprint binding removed: the API authorizes every message, and clients can only read their own inbox.
- Pointer injection is closed by immutable `receipt_attachments.expense_id` and the JSONB attachment check, not by device-side `groupId`, which goes stale on expense moves.
- Existence oracles closed: 202 before authorization, no hashes in any message or API, random receipt ids.
- Added store-and-forward at attach time and a costed comparison with an encrypted relay.
