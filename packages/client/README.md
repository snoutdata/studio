# @snoutdata/client

Part of [snoutdata/snoutdata](https://github.com/snoutdata/snoutdata), where the docs and examples live.

The JavaScript client for SnoutData Cloud. One project's data API, auth, storage, realtime,
Snout Functions and push notifications, from its URL and one key. No dependencies; runs in every browser and
in Node 22+.

```js
import { snout } from '@snoutdata/client'

const db = snout('https://<ref>.api.snoutdata.com', '<your app key>')

const { data, error } = await db.table('todos').read('id, note').eq('done', false)
await db.identity.passwordSignIn({ email, password })
await db.files.space('documents').put('invoices/7.pdf', file)
db.live.topic('room:42').listen('signal', { event: 'cursor' }, (m) => draw(m.payload)).join()
await db.fn.call('hello', { body: { name: 'Ada' } })
await db.push.register({ transport: 'apns', token: deviceToken })
```

Every call resolves to `{ data, error }` rather than throwing, so a refusal from the database is a
value you can show. Queries are built by chaining (`table('todos').read().eq().order()`), and with
the types `snoutdata gen types typescript` writes, every row is typed from your own schema.

The client speaks the project's own paths (`/v1/data`, `/v1/identity`, `/v1/files`, `/v1/live`,
`/v1/fn`) and sends the key as `Snout-Key`. For a server not yet updated to those names, pass
`{ vocabulary: 'old' }`: the same calls then speak the layout 0.3.x spoke.

**Upgrading from 0.3.x.** Every 0.3.x name still works in 0.4.x as a deprecated alias of its new
one (the same function), and is removed in 0.5.0: `createClient` is `snout`; `from`, `select`,
`insert`, `update`, `upsert`, `delete` and `rpc` are `table`, `read`, `add`, `change`, `put`,
`remove` and `procedure`; `auth` is `identity` (`signInWithPassword` is `passwordSignIn`,
`getUser` is `currentPerson`, `onAuthStateChange` is `onSessionChange`, `admin` is `operator`,
...); `storage.from(b)` is `files.space(s)` (`upload`, `download`, `createSignedUrl`,
`getPublicUrl` are `put`, `get`, `signedLink`, `publicLink`); `channel(n)` is `live.topic(n)`
(`on`, `subscribe`, `send`, `track` are `listen`, `join`, `signal`, `announce`, with `changes`,
`signal` and `roster` for `postgres_changes`, `broadcast` and `presence`); `functions.invoke` is
`fn.call`. A person and a session carry `person`, `profile_data` and `server_data` beside
`user`, `user_metadata` and `app_metadata`.

No bundler? The published files are plain ES modules, so a page can import them from a CDN, pinned
to an exact version:

```html
<script type="module">
  import { snout } from 'https://cdn.jsdelivr.net/npm/@snoutdata/client@0.4.1/dist/index.js'
</script>
```

`db.push` is ours, with nothing to match: notifications to iPhone, Android and the web
(`register`, `subscribeWeb`, `send`, topics, receipts). See
[Push notifications](https://docs.snoutdata.com/stack/push).

## Developing

```bash
npm install
npm test          # builds, then runs the unit tests (fake fetch, fake Phoenix socket)
```

Beyond the unit tests, a release that changes behaviour is run against a live SnoutData Cloud
project before it is published.

## Licence

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE). Version 0.1.0 was published under MIT
and stays MIT for anyone who has it; later versions are Apache-2.0.
