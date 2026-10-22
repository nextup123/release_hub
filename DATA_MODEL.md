# Data model: releases, bug reports and updates

One MongoDB database (`nextup_support`) serves both applications you maintain: the
**EtherCAT config tool** (`ethercat_config_tool`) and the **main application** (`main_app`).
Every document carries `appId`, so bugs, releases and update records of the two apps never mix,
and each app numbers its bugs separately (`ECT-12`, `MAIN-7`).

```
apps ──┬── releases        what is in each version (features, fixes, notes)
       ├── bug_reports     problems reported from machines or by you
       ├── machines        every installed copy that has reported in
       └── update_events   which machine moved to which version, when, and whether it worked
attachments                screenshots of bug reports (image bytes as base64)
counters                   per-app bug numbers
```

The three kinds of data you asked for are `releases` (1), `bug_reports` (2) and
`update_events` (3, with `machines` as its summary per PC).

The same rules are enforced in three places: `src/models.js` (API input), MongoDB
`$jsonSchema` validators (`src/db.js`, so scripts and Compass can't write a different shape),
and unique indexes.

## apps

| Field | Type | Example | Notes |
|---|---|---|---|
| `_id` | string | `ethercat_config_tool` | the appId used everywhere |
| `name` | string | `EtherCAT config tool` | |
| `bugPrefix` | string | `ECT` | 2–8 capital letters, used for bug numbers |
| `description` | string | | |
| `repo.url` | string | `git@github.com:org/repo.git` | for reference; each machine has its own copy of this setting |
| `repo.tagPrefix` | string | `v` | tag `v3.5.1` = version 3.5.1. Use `ect-v` / `main-v` if both apps share one repository |
| `repo.subdir` | string | `ethercat_config_tool` | folder in the repository, empty if the app is at the top |
| `platforms` | string[] | `["linux"]` | `android`, `ios` for the mobile app later |

Both apps are created when the server first starts.

## releases (1. update release data)

One document per app and version. Unique on `{appId, version}`.

| Field | Type | Example | Notes |
|---|---|---|---|
| `appId` | string | `ethercat_config_tool` | |
| `version` | string | `3.5.1` | semantic version `MAJOR.MINOR.PATCH[-pre]` |
| `tag` | string | `v3.5.1` | the git tag the update installs |
| `commit` | string | `9f3c…` | filled by the GitHub Action |
| `channel` | `stable` \| `beta` | `stable` | |
| `status` | `draft` \| `published` \| `withdrawn` | `published` | machines only see `published`; `withdrawn` hides a bad release from the Update page |
| `title` | string | `Homing fix` | one line shown on the Update page |
| `summary` | string | | a short paragraph |
| `releasedAt` | date | | |
| `changes[]` | array | see below | grouped on the Update page by type |
| `changes[].type` | `feature` \| `improvement` \| `fix` \| `security` \| `breaking` \| `known_issue` | `fix` | shown as New, Improved, Fixed, Safety, Needs attention, Known problem |
| `changes[].area` | string | `Recipes` | page or part of the app |
| `changes[].title` | string | `Homing no longer stops on J3` | |
| `changes[].description` | string | | |
| `changes[].bugs` | string[] | `["ECT-1"]` | bug numbers this change fixes |
| `changes[].images` | string[] | | screenshot URLs |
| `upgradeNotes` | string | | what to do before or after updating (shown in amber) |
| `requiresRestart` | bool | `true` | |
| `mandatory` | bool | `false` | marks the version "Required" |
| `minVersion` | string \| null | `3.4.0` | oldest version that may update straight to this one |
| `compatibility` | object | `{"ros":"humble","drives":"SV660N"}` | free key/value |
| `artifacts[]` | `{platform,url,sha256,size}` | | for builds that are downloaded instead of built (main app, mobile app) |
| `publishedBy` | string | `github-actions` | |
| `createdAt`, `updatedAt` | date | | |

**Publishing a release marks its bugs fixed.** Every bug listed in `changes[].bugs` moves to
`released` with `fixedInVersion` set, and the vendor's machine shows "Fixed in version 3.5.1"
next to their report.

The notes are written once, in `release-notes.json` at the top of the app's repository, and
committed with the version. The GitHub Action sends them to the server when the tag is pushed.
The Update page reads them from the server, or straight from the tag when the server can't be reached.

## bug_reports (2. bug reports)

Unique on `number`, on `{appId, seq}`, and on `clientReportId`.

| Field | Type | Example | Notes |
|---|---|---|---|
| `appId` | string | `ethercat_config_tool` | which app the bug belongs to |
| `seq`, `number` | int, string | `12`, `ECT-12` | per-app counter |
| `clientReportId` | uuid | | made on the machine; a report sent twice (offline retry) is stored once |
| `appVersion` | string | `3.5.0` | version the problem happened on |
| `title` | string | `Homing stops at step 4 on J3` | "What went wrong?" |
| `description` | string | | "What happened" |
| `stepsToReproduce` | string | | "What were you doing?" |
| `expected`, `actual` | string | | optional, for your own reports |
| `category` | `crash` \| `wrong_result` \| `drive_communication` \| `screen_problem` \| `slow` \| `update` \| `other` | | |
| `severity` | `critical` \| `high` \| `medium` \| `low` | `high` | the reporter's "How bad is it?" (Stops work, Serious, Annoying, Small) |
| `priority` | same values or null | | yours, set when you triage |
| `frequency` | `always` \| `sometimes` \| `once` | | |
| `area` | string | `Recipes` | page where it happened |
| `reporter` | `{name, company, phone, email}` | | the vendor |
| `machine` | `{machineId, name, site, hostname, os}` | | which PC it came from |
| `context` | object | | added by the app if the reporter allows it: drives on the bus and their state, last 20 History entries, controller connected, screen size. Capped at 200 KB |
| `attachments[]` | `{id,name,type,size,url,createdAt}` | | screenshots sent with the report (collection `attachments`); `url` is `/api/v1/attachments/<id>` |
| `status` | `new` \| `triaged` \| `need_info` \| `in_progress` \| `fixed` \| `released` \| `closed` \| `wont_fix` \| `duplicate` | `new` | open = new, triaged, need_info, in_progress |
| `assignee` | string \| null | | |
| `labels` | string[] | | |
| `duplicateOf` | string \| null | `ECT-3` | |
| `fixedInVersion` | string \| null | `3.5.1` | set by hand or by publishing a release |
| `comments[]` | `{author, text, internal, at}` | | `internal: false` comments are meant for the reporter |
| `statusHistory[]` | `{status, by, at, note}` | | every status change |
| `submittedBy` | string | | machine name or reporter that sent it |
| `reportedAt` | date | | when the operator pressed Send (may be days before `createdAt` if offline) |
| `createdAt`, `updatedAt` | date | | |

What the vendor sees on their machine is limited to number, title, status, fixed-in version and dates.

## machines

`_id` is a UUID the app makes once and keeps in `data/machine.json`.

| Field | Type | Notes |
|---|---|---|
| `_id` | uuid | machineId |
| `appId` | string | |
| `name`, `site` | string | set on the Update page (Name of this PC, Customer or site) |
| `hostname`, `os` | string | |
| `version` | string | version running now |
| `channel` | string | |
| `lastUpdate` | `{toVersion, result, at}` | |
| `firstSeenAt`, `lastSeenAt` | date | updated by a heartbeat every minute while online |

## update_events (3. update records)

One per update or roll-back attempt on one machine. Unique on `clientEventId` (offline retries).

| Field | Type | Example | Notes |
|---|---|---|---|
| `clientEventId` | uuid | | |
| `appId`, `machineId` | string | | |
| `kind` | `update` \| `rollback` | | rollback = "Go back to …" pressed |
| `fromVersion`, `toVersion`, `tag` | string | `3.5.0`, `3.5.1`, `v3.5.1` | |
| `result` | `success` \| `failed` \| `rolled_back` \| `not_applied` | | `failed` = stopped before switching (nothing changed); `rolled_back` = new version did not start and the old one was started again |
| `failedStep` | string | `build` | download, unpack, install, build, check, switch, start |
| `error` | string | | plain-words reason |
| `log` | string | | last 80 lines of the update log (left out of list views) |
| `startedAt`, `finishedAt`, `durationSec` | | | |
| `receivedAt` | date | | |

## API (for the apps and the mobile app)

All under `/api/v1`. No key or sign-in for now (it comes later). Send `X-User-Name: <name>`
to record who made a change (status history, comments, publishing); without it the name is
`maintainer`. Installed apps ask for releases with `status=published`.

| Method and path | What |
|---|---|
| `GET /apps` | the two apps |
| `PUT /apps/:id` | add or change an app |
| `GET /apps/:appId/releases?after=3.5.0&status=` | newest first; `status=published` for installed apps |
| `GET /apps/:appId/releases/:version` | |
| `PUT /apps/:appId/releases/:version` | create or replace; publishing links bugs |
| `POST /apps/:appId/bugs` | new report (repeat-safe) |
| `POST /bugs/:number/attachments` | one screenshot: `{clientAttachmentId, name, data}` (base64 JPEG, PNG, WebP or GIF, up to 700 KB, 5 per bug). Repeat-safe. Also at `/apps/:appId/bugs/:number/attachments` |
| `GET /attachments/:id` | the image itself, with its content type (the random id is the access) |
| `GET /apps/:appId/bugs?status=open&severity=high&q=&machineId=&page=` | list with filters, 30 per page |
| `GET /bugs/:number` | full report |
| `PATCH /bugs/:number` | status, priority, assignee, labels, fixedInVersion, duplicateOf, note |
| `POST /bugs/:number/comments` | |
| `GET /apps/:appId/machines/:machineId/bugs` | a machine's own reports, short form |
| `POST /apps/:appId/machines/heartbeat` | |
| `GET /apps/:appId/machines` | |
| `POST /apps/:appId/update-events` | repeat-safe |
| `GET /apps/:appId/update-events?result=failed,rolled_back` | |
| `GET /apps/:appId/summary` | dashboard: open bugs by severity, bugs by status, latest release, machines per version, recent failed updates |
| `GET /meta` | the allowed values above, so the mobile app builds its pickers from the server |

## Using it from the main application

Have the main application send the same `POST /apps/main_app/bugs`, `/update-events` and `/machines/heartbeat` bodies. The
EtherCAT tool's `server/lib/hub.js` (offline queue included) can be copied as is with
`APP_ID` changed.
