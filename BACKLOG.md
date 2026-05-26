# kids-library backlog

Features and improvements that are wanted but not yet scheduled. Append at
the bottom; promote into a milestone when ready. One section per item;
keep the **What / Why / Sketch** structure so each entry stands alone
even if picked up months later by someone with no session context.

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
