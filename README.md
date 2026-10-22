# Release hub

A small Express + MongoDB server that keeps, for both of your applications
(EtherCAT config tool and main application):

1. **Release notes** for every version (what's new, what's fixed, notes before updating)
2. **Bug reports** sent from the machines or entered by you, numbered per app (ECT-12, MAIN-7)
3. **Update records**: which machine moved to which version, when, and whether it worked

The EtherCAT tool's Software update page and the planned React Native app both talk to it.
The data model is in [DATA_MODEL.md](DATA_MODEL.md).

## Run

```bash
npm install
cp .env.example .env        # put your MongoDB connection string in MONGO_URL
npm start                   # http://localhost:4060/api/v1/health
```

`npm start` reads `.env` from this folder. Variables already set in the environment (as on
Render) take priority over the file. The database used is `MONGO_DB` (default
`nextup_support`), whatever name is at the end of the connection string.

It needs a MongoDB 6 or 7 server (or MongoDB Atlas). On first start it creates the collections
with validators and indexes and adds the two apps. `npm run init-db` does the same without
starting the server.

There are no keys or sign-in yet: anyone who knows the address can use it. Sign-in will be
added later.

## Host it on Render

1. Create a MongoDB Atlas cluster, add a database user, and under **Network Access** allow
   `0.0.0.0/0` (Render has no fixed address on the free plan). Copy the connection string.
2. On Render create a Web Service from this folder (or New → Blueprint with `render.yaml`).
   Build command `npm ci`, start command `npm start`, and one environment variable:
   `MONGO_URL` = the Atlas connection string. Optional: `MONGO_DB` (default `nextup_support`).
3. Open `https://<your-service>.onrender.com/api/v1/health`.
   `{"ok":true,"version":"1.1.0","features":["pictures"],"db":"connected"}` means it works.
   No `version` in that answer means Render still runs a copy from before pictures: deploy this version again.
4. On each robot PC: Software update → Update settings → Report server address
   `https://<your-service>.onrender.com`. In the mobile app: the same address.

## If it does not work

The web server starts even when the database can't be reached, and `/api/v1/health` says why:

| `db` in health | Meaning | Fix |
|---|---|---|
| `not configured` | `MONGO_URL` is missing | add it in Render → Environment, redeploy |
| `not connected` + "did not answer" | Atlas is blocking Render | Atlas → Network Access → allow `0.0.0.0/0` |
| `not connected` + "user name or password" | wrong user or password in `MONGO_URL` | special characters in the password must be URL-encoded (`@` → `%40`) |
| `not connected` + "address was not found" | typo in the cluster address | copy the string again from Atlas → Connect → Drivers |
| `connecting` | first try still running | wait 15 s and reload |

It keeps retrying every 10 seconds, so after fixing Atlas no redeploy is needed. Render's log shows
the same messages, starting with `[HUB]`.

On Render's free plan the server sleeps after 15 minutes without requests and takes up to a minute
to wake. The EtherCAT tool saves reports first and keeps retrying, so nothing is lost; the mobile app
shows "Waking the server…" while it waits.

## Try it without MongoDB

```bash
PORT=4060 node test/serve-fake.js
```

runs it on an in-memory stand-in (data is lost when it stops). `npm test` runs the API tests on
the same stand-in.

## Publishing a release

In the app's repository: set the version in `package.json`, describe it in `release-notes.json`,
commit, tag and push:

```bash
git tag v3.5.1 && git push origin main v3.5.1
```

The `Release` GitHub Action builds it and sends `release-notes.json` to this server
(repository secret `HUB_URL`). Bugs named in `changes[].bugs` are marked fixed.
To send the notes by hand: `HUB_URL=… node scripts/publish-release.js`.
