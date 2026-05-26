# kids-library backlog

Features and improvements that are wanted but not yet scheduled. Append at
the bottom; promote into a milestone when ready. One section per item;
keep the **What / Why / Sketch** structure so each entry stands alone
even if picked up months later by someone with no session context.

---

## ACTION ITEM: Set ANTHROPIC_API_KEY to enable cover OCR

The "✨ Refine from cover" feature (built and deployed) needs an
Anthropic API key to actually call Claude. Until the key is set:

- The button still appears on photo-only books (discoverable).
- Clicking it shows a "Refine isn't configured yet" modal with the
  setup steps, an offer to add title/author manually, and an explicit
  reassurance that the photo is safely saved.
- Photo-only books continue to accumulate normally. Nothing is lost.

**Setup steps** (do once):

1. Get an API key at [console.anthropic.com](https://console.anthropic.com)
   → Account → API Keys → Create Key.
2. Cloudflare dashboard → Workers & Pages → `kids-library` → Settings.
3. Environment variables → switch to the **Preview** tab → Add variable.
4. **Type: Secret (encrypted)**. Plain text gets wiped by git deploys
   (we've documented this elsewhere; it bit us during initial setup).
5. Name: `ANTHROPIC_API_KEY`. Value: `sk-ant-…` key.
6. Save. Trigger a redeploy (push any change to the migration branch,
   or use the dashboard's "Retry deployment").
7. **Also do the same on the Production tab** when we promote
   migration → main, so the feature works in prod too.

After that the Refine button works end-to-end. To validate: open one
of the 17 photo-only books in the Library tab, click Refine, walk
through the suggestion modal.

Cost ceiling: ~$0.08/year at our scale (~75 cover lookups/year).
Anthropic charges per token + per image; Haiku 4.5 vision is cheap.

---

## OCR cover → title / author / ISBN backfill

**What.** Today the "Add by cover photo" flow saves a book with the
photo as the only data — title and author fields are optional and
often blank, batched for later. Build a server-side enrichment that
takes a photo-only book, runs image processing on the cover to extract
title + author, and uses the result to look up the ISBN.

End state:
1. User snaps a cover, saves with no title/author.
2. A "Refine from cover" button (or an automatic background job)
   sends the R2-stored cover to `/api/books/[isbn]/refine`.
3. Server returns suggested `{title, author, isbn?, confidence}`.
4. User accepts → book row is updated; the placeholder ISBN (legacy
   uses random IDs for cover-only books) is replaced with the real
   ISBN where confidence is high.

**Why.** Cover-only saves are a real shortcut for board books without
barcodes — but they accumulate as "Needs title" entries that need
manual cleanup later. Automating the enrichment turns the batch from
"manually retype 30 board-book titles" into "tap accept × 30."

**Sketch.**
- *OCR / vision*: Cloudflare Workers AI has a vision-language model
  binding (likely the right primitive — same account, no extra
  vendor, billed per inference). Prompt: *"Extract the book title and
  author from this cover. Return JSON: `{title, author, publisher?}`."*
  Fallback: OpenAI Vision API if Workers AI is unreliable for
  children's-book covers (lots of stylized fonts).
- *ISBN lookup*: feed extracted `title + author` to
  `/api/lookup` (existing endpoint), but extend it to accept
  `?q=title+author` in addition to `?isbn=`. openlibrary.org's
  `/search.json?title=...&author=...` returns candidate editions
  with ISBNs.
- *Replacing the placeholder ISBN*: cover-only books today get a
  random ID stored in the `isbn` PK column. Migrating that to a real
  ISBN means a row update + cascading FKs (book_reads, reviews) —
  doable but needs care. Alternative: keep a `legacy_id` column and
  add a real `isbn` when known, treating `isbn` as nullable.
- *UI*: surface confidence. "Found: *The Snowy Day* by Ezra Jack
  Keats (high confidence)" with an accept button; "Two possible
  matches" with a chooser; "Couldn't read the cover" with a manual
  fallback.
- *Infra*: new Terraform binding for Workers AI if we go that route;
  R2 read permission for the worker already exists.

Adjacent enhancement: same flow runs at write-time on photo-only
saves so the user gets a one-tap suggestion immediately, not just
during batch cleanup.

---

## Retrofit `/api/admin/import` onto the `get-identity` pattern

**What.** The next time we need an admin-style action (or the second time
the import is run and the SSO warm-up tax annoys someone), build the
`get-identity`-based `hasGroup()` helper described in
[web-hub/docs/access-control.md → Pattern 2](https://github.com/Falkizar/web-hub/blob/main/docs/access-control.md#pattern-2-get-identity-from-the-worker-frequent-per-user-logic),
then retrofit `/api/admin/import` onto it. Specifically:

1. Drop the `cloudflare_zero_trust_access_application.kids_library_admin`
   resource (and its policy) from `web-hub/infrastructure/kids-library.tf`.
   This removes the per-path Access app entirely.
2. Add a `GROUPS_CACHE` KV namespace (can reuse `ISBN_CACHE` — keys are
   scoped under `groups:`) bound to the Pages project.
3. Implement `userGroups()` + `hasGroup()` in `functions/api/_lib.ts`
   per the pattern in access-control.md.
4. In `functions/api/admin/import.ts`, replace the implicit "Access
   already verified you're a principal" trust with an explicit
   `if (!(await hasGroup(ctx, 'principals'))) return jsonError(...)`.
5. Update the import-endpoint vitest tests to mock `userGroups` / the
   `get-identity` fetch and cover the 403 path.

**Why.** Two reasons.

First, the **UX cost** — the user hit the SSO warm-up tax during the
first import (silent CORS failure when the JS `fetch()` got a 302 to
SSO; required a manual URL-bar navigation to warm the admin-app
cookie). For a once-a-year import it's tolerable. For anything more
frequent (or if another admin endpoint lands and the costs compound)
it's not.

Second, **building the helper unblocks the per-user features** queued
in the hub doc (per-user tile view, per-row financials, per-kid chore
filters). Better to design the helper for one real consumer first and
extract from there than to build it in the abstract.

**Sketch.** See the worked example in access-control.md. Estimated
~1 hour: TF drop (5 min), helper (15 min), import.ts swap (10 min),
tests (15 min), deploy + verify (15 min).

---
