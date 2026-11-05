# Arkiv friction log

What we hit building Unforged's registry on Arkiv. Migrated from SDK 0.8.1 on Tiramisu to SDK 1.0.1 on Rabdi. Everything below comes from the SDK 1.0.1 source and Arkiv's skills and docs, unless marked otherwise. **Not yet confirmed by a live run.**

## The network change

Tiramisu (chain 7738577) was replaced by Rabdi (chain 7794095) and the Hub only issues Rabdi access keys. As reported to our team, SDK 0.8.1 writes are rejected on Rabdi; we did not measure that ourselves. `npm view` showed 1.0.1 as `latest` while our spec still pinned `>=0.8.1 <0.9`, so a whole milestone was written against the old API before the migration.

## What changed from 0.8 to 1.0

| Area | SDK 0.8.1 on Tiramisu | SDK 1.0.1 on Rabdi | What we did |
|---|---|---|---|
| Connecting | `chain: tiramisu` | `chain: rabdi({ accessKey })`; a missing key throws, `""` means the public RPC | CLI reads `ARKIV_ACCESS_KEY`; the extension reads keyless |
| Entity shape | Opaque payload, `contentType`, loose attributes | Schemas: `defineSchema` with typed columns, no opaque body | One schema per entity kind, with new `payload` (bytes) and `content_type` (str) columns |
| Create call | `createEntity({ payload, contentType, attributes, expires, flags })` | `createEntity(schema, values, { expiration, flags }, txParams?)` | Rewritten |
| Filtering | Any attribute | Only columns declared `.indexed()` | Indexed every column worth querying up front, because readonly entities can't gain an index later |
| Pagination | 200 per page, `hasNextPage()` / `next()` | 100 per page, no cursor, keyset or offset | Keyset on `$key`, with a page budget |
| Rows | `key`, `attributes`, `payload` | Flat `$key`, `$creationFlags`, columns as `{ type, value }`; bytes are hex | Rewritten and hex-decoded |
| Lifetime | `ExpirationTime.fromDays(365)` | Maximum 7,884,000 blocks, about 182 days; longer is rejected before sending | `ExpirationTime.max()` instead of our specified 365 days |
| Gas | SDK default | Default estimation measured reverting out of gas; explicit nonce, gas and gasPrice recommended | Estimate unsigned, then `gas = max(1,000,000, 2 x estimate)` |

## Sharp edges

- **The access key is in the URL path.** viem quotes that URL in its errors, so an ordinary error log leaks the key. We strip URLs and the key from everything the CLI prints.
- **Keyless rate limit has no published number.** Docs and SDK only say "heavily rate limited". Our extension must read keyless, so we can't size its sync against a known limit. We retry HTTP 429 with exponential backoff and treat exhaustion as a failed sync.
- **Schema reads and keyset paging conflict.** `from(schema)` skips mismatching rows by default, and a fully skipped page has no key to continue from, so Arkiv recommends `onMismatch: "throw"` for keyset walks. That would let one malformed entity from a builder fail that builder's whole read. We write through schemas but read without `from(schema)`, and validate each row ourselves.
- **Keyless clients warn on the console.** `rabdi({ accessKey: "" })` logs a one-time warning. Harmless, but it shows up in the extension's console for correct, intended use.
- **Agent skills track only the current network.** Installing them while on Tiramisu gave guidance for a different chain and SDK, with no pointer to the older API.
