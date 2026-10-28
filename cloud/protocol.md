# AI Watch cloud protocol v1

One self-hosted workspace has one desktop publisher and up to 32 mobile installations. All API requests use HTTPS with an `Authorization: Bearer …` header. Desktop and enrollment/admin credentials are separate; they are provisioned on the server and never embedded in an application build. Each phone exchanges the enrollment credential for its own random device credential, and retains only that device credential in secure storage. The server stores a bounded latest snapshot, mobile registrations, command receipts and a retry outbox. A deployment must retain its data volume across restarts.

## Pairing and administration

`POST /v1/pair` uses the enrollment/admin credential and body `{id:installation UUID,name,platform:"android"|"ios"}`. It returns `{token,deviceId}` once; the server persists only a hash of the token. Re-pairing an installation rotates its token and closes its previous stream. All state, events, commands and push-registration endpoints require a paired device credential. The enrollment credential cannot approve a request directly. Each command records `actorDeviceId` for audit. Rate limits are applied per paired installation and per enrollment client, with separate infrastructure bounds.

`DELETE /v1/pair` self-revokes the authenticated phone, including its stream and push registration. Admin-only `GET /v1/admin/devices` lists paired installations, `DELETE /v1/admin/devices/:id` revokes one, and `POST /v1/admin/reset-desktop` with `{}` clears the publisher binding and current requests while preserving paired phones. Reset fails pending operations rather than transferring them to a different desktop. Use the administration CLI documented in the service README; it connects through HTTPS.

## Desktop sync

`POST /v1/sync` every five seconds:

```text
{
  v: 1,
  d: desktop UUID,
  s: process/session UUID,
  n: monotonically increasing sequence number,
  t: Unix time in milliseconds,
  h: SHA-256 hex of JSON.stringify(snapshot),
  snapshot?: Snapshot,
  results?: [{id: command UUID, status: "succeeded" | "failed", error?: stable error code}]
}
```

The first packet and any content change carry a full allowlisted snapshot. Unchanged packets carry the hash only. JSON payloads above 1 KiB are gzip compressed. The body limit is 256 KiB, including decompression. Transport overhead (HTTP headers, TLS) is additional. A server reply is `{ok:true, needSnapshot:boolean, commands:Command[]}`. `needSnapshot` forces a full snapshot on the next tick. A new desktop session requires a snapshot and invalidates pending commands from the previous session.

```text
Snapshot = {
  p: [{i: provider ID, c: connection, a: activity, n: active task count,
       w?: "input" | "approval" | "both",
       q: [{m: model, p: period, r: remaining percent or null, s?: true, z?: reset ISO date}]}],
  requests: [{id: opaque request ID, provider, kind: "input" | "approval", title, detail,
              expiresAt: Unix milliseconds,
              questions?: [{id, header, question, options:[{label,description}], isOther?:boolean}],
              fullContent?: {command?:string,cwd?:string,reason?:string,grantRoot?:string,
                             questions?:[{id,header,question,options:[{label,description}]}]}}],
  sample: boolean,
  stale?: true,
  limited?: true
}
```

Provider IDs are `claude`, `codex`, `antigravity`, `deepseek`, `zcode`, `kimi`, `qwen`, `workbuddy`. Connection values are `ready`, `offline`, `unavailable`, `error`, `auth-required`; activities are `running`, `waiting`, `idle`, `unknown`, `offline`. Unknown remaining quota is `null`; `s:true` means stale. Currency balances and credits without a known percentage are not treated as quota percentages. Ordinary task titles, transcripts, local account identities, account credentials and images are excluded from status projection. Request metadata remains fixed: titles are localizable keys `codex.input`, `codex.commandApproval`, `codex.fileApproval`; detail is `input`, `fileChange`, `command` or a program name from a fixed vocabulary. Question IDs are hashes, headers are `question.N`, question text is the key `review.questionOnDesktop`, and option labels are `option.N` with empty descriptions. Only the desktop maps numbered answers back to original labels.

The desktop's separate full-context setting is off by default and requires mobile actions to be allowed first. Allowing mobile actions alone does not enable full-context sharing. When explicitly enabled, a request may include `fullContent` with the supported original command, paths, reason, question and option wording. The authenticated state and SSE endpoints expose this context to paired phones; the service does not redact secrets that happen to occur inside the explicitly shared text. This content is not included in normal push messages, system live surfaces, the inbox, command audit or request-history records. With the setting off, mobile users review the original context on the desktop.

Only the following full-context fields are accepted for each request kind. String limits count UTF-16 code units, matching JavaScript `string.length`; empty strings are valid. Tabs, LF and CR are supported for multiline text; other C0 controls, DEL and C1 controls are rejected.

| Request | Allowed full-context fields |
| --- | --- |
| `input` / `codex.input` | `questions`: same count and order as metadata questions; each has the same hashed `id`, `header` (256), `question` (4096), and `options` |
| `approval` / `codex.commandApproval` | optional `command` (4096), `cwd` (1024), `reason` (4096) |
| `approval` / `codex.fileApproval` | optional `cwd` (1024), `grantRoot` (1024), `reason` (4096) |

Each full question requires exactly `id`, `header`, `question` and `options`. Each option requires exactly `label` (256) and `description` (1024), and its position maps to the matching metadata `option.N`; there are no extra option IDs. Option counts must match the corresponding metadata question. Unknown fields, cross-kind fields, wrong types, mismatched IDs, reordered questions or mismatched option counts fail validation. Full context never changes the answer protocol: submit numbered `option.N` values and hashed question IDs even when original option text is displayed.

The entire request, including full context, is removed at terminal status or expiry, with a maximum ten-minute lifetime from first receipt. Switching off full context sends a replacement metadata-only snapshot; accepting that upload immediately removes the previous full context from the live state and persisted state file. A disconnected desktop cannot clear the server until a new upload arrives, so expiry still bounds retention. Startup expiry runs before the server returns state. User-entered answer text is forwarded transiently and deleted at terminal status or expiry (at most 120 seconds). Deduplication and audit records retain only IDs, timestamps, status and content digests, never the original request wording. These deletion guarantees apply to the service's current state file, not external backups or filesystem snapshots.

`stale:true` means the underlying desktop sample is missing or more than 30 seconds old. The desktop then omits actionable requests and marks quota entries stale; the server suppresses alerts and rejects new operations. Transport `online` and source freshness are distinct.

`limited:true` means some requests were omitted to keep complete request objects, including optional full context, within a combined 64 KiB desktop projection budget and 32-item limit, or because supported full text could not be safely represented. Individual requests are never truncated to fit. The 256 KiB HTTP limit still applies before and after decompression. The mobile app directs the user to the desktop for the full list.

## Mobile state and actions

`GET /v1/state` and authenticated `GET /v1/events` return the same state shape. SSE messages have `event: state` and a JSON `data:` line. SSE includes initial state and heartbeat comments; clients reconnect and use five-second REST fallback while disconnected. Mobile foreground streams stop when backgrounded. The server declares the desktop offline after 20 seconds without sync.

```text
State = {online:boolean, receivedAt:Unix milliseconds|null, deviceId:string|null,
         snapshot:Snapshot|null,
         attention:{inputCount:number,approvalCount:number,provider:provider ID|"multiple"|"none",
                    updatedAt:Unix seconds,expiresAt:Unix seconds},
         alerts:[{id:event UUID,type:"input"|"approval"|"low-quota",provider,
                  requestId?:opaque request ID,createdAt:Unix milliseconds,active:boolean}],
         commands:[{id,requestId,actorDeviceId,kind:"answer"|"approve"|"deny",createdAt:Unix milliseconds,
                    completedAt?:Unix milliseconds,
                    status:"queued"|"delivered"|"succeeded"|"failed"|"expired",error?}]}
```

`POST /v1/commands` accepts `{id:UUID, requestId, kind:"answer"|"approve"|"deny", answer?:string, answers?:{questionId:{answers:[string]}}}`. For a structured question, submit every opaque question ID in `answers`; a numbered selection is the corresponding `option.N` string. Free text is allowed only for questions with no predefined options or with `isOther:true`. The `answer` shorthand is supported only when the desktop request contains one question. Request-level `choices` and command-level `choice` are not supported by the current action protocol. The same command ID and content from the same installation are idempotent; conflicting reuse returns 409. Only one command may be submitted per request. The server validates request existence, type and expiry, and rejects actions while offline or on sample or stale data. Commands expire within 120 seconds, no later than the request. The desktop independently revalidates the request and permits only supported local operations. It records intent before execution and does not replay an operation after an uncertain result or restart.

`queued` means accepted by the server; `delivered` means retrieved by the desktop. Neither is an execution confirmation. `succeeded` requires the local provider's affirmative response and an observed resolution of that same request. `failed` with an unknown/interrupted outcome requires checking the desktop before any manual retry.

## Push registration and alerts

The in-app `alerts` inbox is generated even when no FCM/APNs credentials or push subscriptions exist. It retains at most 200 events for 24 hours and returns the latest 50 in chronological order. Resolution, expiry, stale source data or desktop disconnection sets `active:false`; historical events retain only generic metadata. The inbox uses stable event IDs, excludes internal deduplication keys and never contains question wording or answers. Foreground SSE and REST reconnects retrieve the same inbox; clients track read status locally. This does not wake a background or closed app without platform push delivery. Push registration does not duplicate existing inbox events.

`POST /v1/devices` accepts `{id:installation UUID, platform:"android"|"ios", token, environment?:"sandbox"|"production", transport?:"fcm"|"mipush"|"vpush", liveUpdates?:boolean, liveActivity?:{notificationId:positive integer,locallyCreated:boolean}}`. Android defaults to FCM; iOS uses APNs. OEM transport tokens are never forwarded to FCM. `opush` is reserved and returns HTTP 501 until an authenticated OPPO transport is implemented. OEM application secrets, approved scenes and templates come from server configuration, not the phone. Both registration and `DELETE /v1/devices/:id` are restricted to the authenticated installation. The DELETE endpoint removes only its push subscription and queued notifications; its paired credential remains valid for state and actions. To revoke the installation itself, use `DELETE /v1/pair` or the admin revocation endpoint. Register again after token rotation. Signing configuration determines the iOS APNs environment.

Push alerts use FCM HTTP v1 on Android and APNs HTTP/2 on iOS. Push data contains an event ID, category (`input`, `approval`, `low-quota`), provider and optional request ID. Lock-screen messages remain generic even when full-context sharing is enabled. Original question wording, command arguments and local paths are accessible only through authenticated state/SSE when explicitly shared; submitted answer bodies never appear in these responses. State changes are streamed to an open app rather than generating a push every five seconds. Low-quota alerts use a configurable percentage threshold (default 20%) and five-point recovery hysteresis. Sample, stale and unknown quota values never generate low-quota alerts. Device-specific outbox entries have bounded retries and expiry; invalid registrations are removed. Delivery depends on device permissions, platform connectivity and configured push credentials.

## System live attention

System live surfaces require explicit user opt-in. They show only the five `attention` fields above; the two timestamps use seconds, unlike the original sync and request timestamps. Normal updates coalesce with a ten-second minimum interval and a sixty-second renewal cadence. The usual lease is ninety seconds, bounded by request expiry. Offline, stale and sample data have zero valid attention. End messages may bypass the update interval; network and vendor caching still prevent a guaranteed disappearance time.

Android with `liveUpdates:true` can receive a data-only FCM message with `category:"attention"`, `phase:"update"|"end"`, and a JSON-string `contentState`. The client treats this as a refresh hint and authenticates a new state fetch before displaying it. MiPush/VPush use the approved metadata-only vendor templates described in the [service README](README.md#系统实时活动); VPush requires a reported local notification before cloud update/end. Low-quota events remain ordinary notifications.

iOS registers ActivityKit tokens independently of ordinary APNs tokens: `POST /v1/live-activity` accepts `{type:"start"|"update",token:hex,environment:"sandbox"|"production",activityId?:string}` from the authenticated iOS installation. Update requires an activity ID. `DELETE /v1/live-activity` with no body, zero-length body or `{}` disables all live subscriptions and queues an end where possible. With `{activityId}` it retires only the matching activity and suppresses automatic recreation during its continuous pending cycle. A user must explicitly re-enable or let all pending attention clear before a new cycle. Tokens are not exposed through state, SSE or admin lists. APNs uses the `.push-type.liveactivity` topic suffix and `AIWatchAttentionAttributes` with only opaque `scope` attributes. Start, update and end payloads follow ActivityKit; a lost start response is not blindly retried into duplicate activities. See the [service README](README.md#系统实时活动) for signatures, permissions, lifecycle and verification limits.
