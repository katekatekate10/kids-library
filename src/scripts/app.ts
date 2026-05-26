/**
 * Kids' Library — ported from the legacy localStorage SPA to a Pages
 * Functions backend. Render functions are largely unchanged; data
 * mutations now flow through /api/* instead of localStorage saves.
 *
 * Conventions:
 *   - `state` is a local mirror of server state, initialized via /api/state.
 *   - Mutations are OPTIMISTIC: update `state` first for snappy UI,
 *     then fire the API call. On failure we toast + re-fetch state so
 *     the local view re-converges. (Family scale, low contention —
 *     last-write-wins is fine.)
 *   - LASTSCANCHOICE: kept in localStorage because it's a per-device
 *     stickiness, not data we want shared across the family.
 */

// Required so TypeScript treats this file as a module — without it,
// the `declare global` block below is rejected (and every window.*
// assignment is flagged unknown).
export {};

/* ============================ TYPES ============================ */

interface Kid { id: string; name: string; age?: number | null; interests?: string | null; notes?: string | null }
interface ShelfStint { placedAt: string | null; removedAt: string; outcome: 'keep' | 'hit' | 'ignored'; readsAtRemoval: Record<string, number> }
interface Book {
  isbn: string;
  title?: string | null;
  authors?: string[];
  subjects?: string[];
  publishYear?: string | null;
  cover?: string | null;
  source: 'owned' | 'library';
  location: 'accessible' | 'backstock';
  addedDate: string;
  placedOnShelfAt?: string | null;
  lastShelfStint?: ShelfStint | null;
  readsByKid: Record<string, number>;
}
interface Review {
  id: string;
  kidId: string;
  bookIsbn: string;
  rating: number;
  liked?: string | null;
  disliked?: string | null;
  notes?: string | null;
  dateRead?: string | null;
}
interface AppState { version: number; kids: Kid[]; books: Book[]; reviews: Review[] }

declare global {
  interface Window {
    editKid: (id: string) => void;
    saveKid: (id: string) => void;
    deleteKid: (id: string) => void;
    openBook: (isbn: string) => void;
    editBookMeta: (isbn: string) => void;
    saveBookMeta: (isbn: string) => void;
    refineFromCover: (isbn: string) => void;
    applyRefine: (isbn: string) => void;
    bumpRead: (isbn: string, kidId: string) => void;
    unbumpRead: (isbn: string, kidId: string) => void;
    toggleLocation: (isbn: string) => void;
    convertToLibrary: (isbn: string) => void;
    convertToOwned: (isbn: string) => void;
    deleteBook: (isbn: string) => void;
    deleteReview: (id: string) => void;
    newReview: (isbn: string, kidId: string) => void;
    saveReview: (isbn: string, kidId: string) => void;
    setRotateDecision: (isbn: string, dec: 'keep' | 'hit' | 'ignored') => void;
    buildPromptForKid: (kidId: string) => void;
    buildPromptForAll: () => void;
    closeModal: () => void;
    _pendingRating?: () => number;
    _scanDiag?: ReturnType<typeof setInterval>;
    ZXingBrowser?: any;
    BarcodeDetector?: any;
  }
}

/* ============================ STATE ============================ */

const SCAN_CHOICE_KEY = 'kids_library_last_scan_choice';
let state: AppState = { version: 4, kids: [], books: [], reviews: [] };
let filterKid: string = 'all';
let filterStatus: 'all' | 'read' | 'unread' | 'untitled' = 'all';
let filterLoc: 'all' | 'accessible' | 'backstock' | 'library' = 'all';
let libSearch = '';
let rotationDecisions: Record<string, 'keep' | 'hit' | 'ignored'> = {};
let manualMode: 'isbn' | 'photo' | 'text' = 'isbn';
let pendingPhotoBlob: Blob | null = null;
let pendingPhotoDataUrl: string | null = null;

function getLastScanChoice(): string { return localStorage.getItem(SCAN_CHOICE_KEY) || 'owned-backstock' }
function setLastScanChoice(c: string) { localStorage.setItem(SCAN_CHOICE_KEY, c) }

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
function totalReads(bk: Book): number {
  return Object.values(bk.readsByKid || {}).reduce((s, n) => s + n, 0);
}
function parseScanChoice(choice: string): { source: Book['source']; location: Book['location'] } {
  if (choice === 'library') return { source: 'library', location: 'accessible' };
  const [source, location] = choice.split('-');
  return { source: (source || 'owned') as Book['source'], location: (location || 'backstock') as Book['location'] };
}

/* ============================ API ============================ */

async function api<T = unknown>(method: string, path: string, body?: unknown, opts: { raw?: boolean; contentType?: string } = {}): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    if (opts.raw && body instanceof Blob) {
      init.body = body;
      (init.headers as Record<string, string>)['content-type'] = opts.contentType || body.type || 'application/octet-stream';
    } else {
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  const r = await fetch(path, init);
  if (!r.ok) {
    let msg = `${method} ${path} failed: ${r.status}`;
    try { const j = await r.json() as { error?: string }; if (j?.error) msg += ` — ${j.error}`; } catch {}
    throw new Error(msg);
  }
  return r.status === 204 ? (undefined as T) : (await r.json()) as T;
}

async function refreshState(): Promise<void> {
  state = await api<AppState>('GET', '/api/state');
}

/* ============================ TABS ============================ */

document.querySelectorAll<HTMLButtonElement>('nav.tabs button').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab!));
});
function switchTab(name: string) {
  document.querySelectorAll<HTMLButtonElement>('nav.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll<HTMLElement>('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
  if (name !== 'add') stopScanner();
  if (name === 'library') renderLibrary();
  if (name === 'kids') renderKids();
  if (name === 'rotate') renderRotate();
  if (name === 'recommend') renderRecommend();
}
document.getElementById('tab-library')!.classList.add('active');

/* ============================ TOAST ============================ */

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string) {
  const t = document.getElementById('toast')!;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ============================ MODAL ============================ */

let _suppressBackdropClose = false;
function openModal(html: string) {
  document.getElementById('modalContent')!.innerHTML = html;
  document.getElementById('modal')!.classList.add('active');
}
function closeModal() { document.getElementById('modal')!.classList.remove('active'); }
window.closeModal = closeModal;
document.getElementById('modal')!.addEventListener('click', (e: Event) => {
  if ((e.target as HTMLElement).id === 'modal' && !_suppressBackdropClose) closeModal();
});

function confirmDestructive(opts: { title: string; message: string; requireText: string; dangerLabel: string }): Promise<boolean> {
  _suppressBackdropClose = true;
  return new Promise(resolve => {
    let resolved = false;
    const done = (val: boolean) => {
      if (resolved) return;
      resolved = true;
      _suppressBackdropClose = false;
      closeModal();
      resolve(val);
    };
    openModal(`
      <button class="close" id="cdClose">×</button>
      <h2>${escapeHtml(opts.title)}</h2>
      ${opts.message}
      <label style="margin-top:14px;">Type <code style="background:#ece2d2; padding:2px 6px; border-radius:4px; font-family: ui-monospace, monospace;">${escapeHtml(opts.requireText)}</code> to confirm</label>
      <input type="text" id="cdInput" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
      <div class="row" style="margin-top:14px;">
        <button class="ghost" id="cdCancel">Cancel</button>
        <button class="danger" id="cdGo" disabled>${escapeHtml(opts.dangerLabel)}</button>
      </div>
    `);
    const input = document.getElementById('cdInput') as HTMLInputElement;
    const go = document.getElementById('cdGo') as HTMLButtonElement;
    input.addEventListener('input', () => { go.disabled = input.value.trim() !== opts.requireText; });
    go.onclick = () => done(true);
    document.getElementById('cdCancel')!.onclick = () => done(false);
    document.getElementById('cdClose')!.onclick = () => done(false);
    setTimeout(() => input.focus(), 100);
  });
}

/* ============================ KIDS ============================ */

function renderKids() {
  const wrap = document.getElementById('kidsList')!;
  if (!state.kids.length) {
    wrap.innerHTML = `<div class="empty"><div class="big-ico">🧒</div><p>No kids added yet.</p></div>`;
    return;
  }
  wrap.innerHTML = state.kids.map(k => `
    <div class="kid-row">
      <div class="kid-avatar">${escapeHtml((k.name || '?').slice(0, 1).toUpperCase())}</div>
      <div class="kid-info">
        <div class="kid-name">${escapeHtml(k.name)} <span class="kid-meta">· age ${escapeHtml(String(k.age || '?'))}</span></div>
        <div class="kid-meta">${escapeHtml(k.interests || 'No interests noted')}</div>
      </div>
      <button class="ghost small" onclick="editKid('${k.id}')">Edit</button>
    </div>
  `).join('');
}

window.editKid = function (id: string) {
  const k = id ? state.kids.find(x => x.id === id) : null;
  const v = k ?? { id: '', name: '', age: null as number | null, interests: '', notes: '' };
  openModal(`
    <button class="close" onclick="closeModal()">×</button>
    <h2>${id ? 'Edit kid' : 'Add a kid'}</h2>
    <label>Name</label>
    <input type="text" id="kName" value="${escapeAttr(v.name)}" />
    <label>Age</label>
    <input type="number" id="kAge" min="0" max="18" value="${escapeAttr(v.age ?? '')}" />
    <label>Interests</label>
    <input type="text" id="kInterests" value="${escapeAttr(v.interests ?? '')}" placeholder="dinosaurs, space, funny stories, dragons" />
    <label>Other notes</label>
    <textarea id="kNotes" placeholder="Reads chapter books fluently. Doesn't like scary stuff.">${escapeHtml(v.notes ?? '')}</textarea>
    <div class="row" style="margin-top: 14px;">
      <button class="primary" onclick="saveKid('${v.id}')">Save</button>
      ${id ? `<button class="danger" onclick="deleteKid('${v.id}')">Delete</button>` : ''}
    </div>
  `);
};

window.saveKid = async function (id: string) {
  const name = (document.getElementById('kName') as HTMLInputElement).value.trim();
  const ageVal = (document.getElementById('kAge') as HTMLInputElement).value;
  const age = ageVal ? parseInt(ageVal, 10) : null;
  const interests = (document.getElementById('kInterests') as HTMLInputElement).value.trim();
  const notes = (document.getElementById('kNotes') as HTMLTextAreaElement).value.trim();
  if (!name) { toast('Please enter a name'); return; }
  try {
    if (id) {
      const updated = await api<Kid>('PATCH', `/api/kids/${id}`, { name, age, interests, notes });
      const k = state.kids.find(x => x.id === id);
      if (k) Object.assign(k, updated);
    } else {
      const created = await api<Kid>('POST', '/api/kids', { name, age, interests, notes });
      state.kids.push(created);
    }
    closeModal(); renderKids(); toast('Saved');
  } catch (e) { toast((e as Error).message); }
};

window.deleteKid = async function (id: string) {
  if (!confirm('Delete this kid and all their reviews?')) return;
  try {
    await api('DELETE', `/api/kids/${id}`);
    state.kids = state.kids.filter(k => k.id !== id);
    state.reviews = state.reviews.filter(r => r.kidId !== id);
    closeModal(); renderKids(); toast('Deleted');
  } catch (e) { toast((e as Error).message); }
};

document.getElementById('btnAddKid')!.addEventListener('click', () => window.editKid(''));

/* ============================ LIBRARY ============================ */

function renderLibrary() {
  const searchEl = document.getElementById('libSearch') as HTMLInputElement | null;
  if (searchEl) {
    if (searchEl.value !== libSearch) searchEl.value = libSearch;
    searchEl.oninput = () => { libSearch = searchEl.value; renderLibrary(); };
  }
  const scanBtn = document.getElementById('btnLibScan');
  if (scanBtn) {
    scanBtn.onclick = () => {
      switchTab('add');
      setTimeout(() => startScanner(), 100);
      toast('Scan to find a book');
    };
  }

  const kidRow = document.getElementById('kidFilterRow')!;
  kidRow.innerHTML = `<button class="pill" data-filter="all" aria-selected="${filterKid === 'all'}">All books</button>` +
    state.kids.map(k => `<button class="pill" data-filter="${k.id}" aria-selected="${filterKid === k.id}">${escapeHtml(k.name)}</button>`).join('');
  kidRow.querySelectorAll<HTMLButtonElement>('button').forEach(b => {
    b.addEventListener('click', () => { filterKid = b.dataset.filter!; renderLibrary(); });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-status]').forEach(b => {
    b.setAttribute('aria-selected', String(b.dataset.status === filterStatus));
    b.onclick = () => { filterStatus = b.dataset.status as typeof filterStatus; renderLibrary(); };
  });
  document.querySelectorAll<HTMLButtonElement>('[data-loc]').forEach(b => {
    b.setAttribute('aria-selected', String(b.dataset.loc === filterLoc));
    b.onclick = () => { filterLoc = b.dataset.loc as typeof filterLoc; renderLibrary(); };
  });

  const grid = document.getElementById('bookGrid')!;
  const empty = document.getElementById('libEmpty')!;
  let books = state.books.slice().sort((a, b) => (b.addedDate || '').localeCompare(a.addedDate || ''));

  if (filterLoc === 'library') books = books.filter(b => b.source === 'library');
  else if (filterLoc === 'accessible') books = books.filter(b => b.source !== 'library' && b.location === 'accessible');
  else if (filterLoc === 'backstock') books = books.filter(b => b.source !== 'library' && b.location === 'backstock');

  if (libSearch.trim()) {
    const q = libSearch.trim().toLowerCase();
    books = books.filter(bk => {
      const title = (bk.title || '').toLowerCase();
      const authors = (bk.authors || []).join(' ').toLowerCase();
      return title.includes(q) || authors.includes(q);
    });
  }

  if (filterStatus === 'untitled') {
    books = books.filter(bk => !bk.title || !bk.title.trim());
  } else if (filterStatus !== 'all' && filterKid !== 'all') {
    books = books.filter(bk => {
      const hasReview = state.reviews.some(r => r.kidId === filterKid && r.bookIsbn === bk.isbn);
      return filterStatus === 'read' ? hasReview : !hasReview;
    });
  } else if (filterStatus !== 'all') {
    books = books.filter(bk => {
      const hasReview = state.reviews.some(r => r.bookIsbn === bk.isbn);
      return filterStatus === 'read' ? hasReview : !hasReview;
    });
  }

  if (!books.length) {
    grid.innerHTML = '';
    (empty as HTMLElement).style.display = 'block';
    return;
  }
  (empty as HTMLElement).style.display = 'none';
  grid.innerHTML = books.map(bk => {
    const reviewsForBook = state.reviews.filter(r => r.bookIsbn === bk.isbn);
    const avg = reviewsForBook.length ? (reviewsForBook.reduce((s, r) => s + (r.rating || 0), 0) / reviewsForBook.length).toFixed(1) : null;
    const coverStyle = bk.cover ? `background-image: url('${escapeAttr(bk.cover)}');` : '';
    const isLibrary = bk.source === 'library';
    const onShelf = bk.location === 'accessible';
    const cornerClass = isLibrary ? 'library' : (onShelf ? 'shelf' : 'backstock');
    const cornerText = isLibrary ? 'LIB' : (onShelf ? 'SHELF' : 'STOCK');
    const dim = !isLibrary && !onShelf;
    const reads = totalReads(bk);
    return `
      <div class="book ${dim ? 'backstock' : ''}" onclick="openBook('${bk.isbn}')">
        <span class="corner-badge ${cornerClass}">${cornerText}</span>
        <div class="cover" style="${coverStyle}">${bk.cover ? '' : escapeHtml(bk.title || '(no title)')}</div>
        <div class="meta">
          <div class="title">${bk.title ? escapeHtml(bk.title) : '<i style="color:var(--muted);">(no title yet)</i>'}</div>
          <div class="author">${escapeHtml((bk.authors || []).join(', '))}</div>
          <div class="badges">
            ${avg ? `<span class="badge">★ ${avg}</span>` : ''}
            ${reads > 0 ? `<span class="badge reads">📖×${reads}</span>` : ''}
            ${reviewsForBook.length ? `<span class="badge teal">${reviewsForBook.length} rev</span>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

window.openBook = function (isbn: string) {
  const bk = state.books.find(b => b.isbn === isbn);
  if (!bk) return;
  const reviews = state.reviews.filter(r => r.bookIsbn === isbn);
  const reviewsHtml = reviews.length ? reviews.map(r => {
    const kid = state.kids.find(k => k.id === r.kidId);
    return `
      <div class="review">
        <div class="head">
          <div class="who">${escapeHtml(kid ? kid.name : 'Unknown')} <span class="stars-small">${'★'.repeat(r.rating || 0)}${'☆'.repeat(5 - (r.rating || 0))}</span></div>
          <div class="when">${r.dateRead || ''}</div>
        </div>
        ${r.liked ? `<div class="notes"><b>Liked:</b> ${escapeHtml(r.liked)}</div>` : ''}
        ${r.disliked ? `<div class="notes"><b>Didn't like:</b> ${escapeHtml(r.disliked)}</div>` : ''}
        ${r.notes ? `<div class="notes">${escapeHtml(r.notes)}</div>` : ''}
        <button class="ghost small" style="margin-top:6px;" onclick="deleteReview('${r.id}')">Delete review</button>
      </div>
    `;
  }).join('') : '<p class="muted">No reviews yet.</p>';

  const kidsOptions = state.kids.length
    ? state.kids.map(k => `<button class="pill" onclick="newReview('${isbn}','${k.id}')">+ ${escapeHtml(k.name)}</button>`).join('')
    : '<p class="muted">Add a kid first (Kids tab) so you can review books.</p>';

  const isLibrary = bk.source === 'library';
  const onShelf = bk.location === 'accessible';
  const locationBadge = isLibrary
    ? '<span class="badge library">📕 Library book</span>'
    : `<span class="badge ${onShelf ? 'shelf' : 'backstock'}">${onShelf ? '📚 On shelf' : '📦 Backstock'}</span>`;
  const otherLocLabel = onShelf ? 'Move to backstock' : 'Move to shelf';

  openModal(`
    <button class="close" onclick="closeModal()">×</button>
    <div style="display:flex; gap:14px; align-items:flex-start;">
      <div class="cover" style="width: 90px; height: 135px; aspect-ratio: auto; flex: 0 0 90px; background-size: cover; ${bk.cover ? `background-image:url('${escapeAttr(bk.cover)}');` : 'background:#ece2d2;'} border-radius: 8px;"></div>
      <div style="flex:1; min-width:0;">
        <h2 style="margin:0;">${bk.title ? escapeHtml(bk.title) : '<i style="color:var(--muted);">(no title yet)</i>'}</h2>
        <div class="muted" style="margin-top:2px;">${escapeHtml((bk.authors || []).join(', '))}${bk.publishYear ? ' · ' + escapeHtml(bk.publishYear) : ''}</div>
        ${!bk.title || !((bk.authors || []).length) ? `<button class="ghost small" style="margin-top:6px;" onclick="editBookMeta('${isbn}')">+ Add title &amp; author</button>` : `<button class="ghost small" style="margin-top:6px;" onclick="editBookMeta('${isbn}')">Edit title / author</button>`}
        ${bk.cover && (!bk.title || !((bk.authors || []).length)) ? `<button class="ghost small" style="margin-top:6px; margin-left:6px;" onclick="refineFromCover('${isbn}')">✨ Refine from cover</button>` : ''}
        <div class="pill-row" style="margin-top:6px;">
          ${locationBadge}
          <span class="badge reads">📖 ${totalReads(bk)} reads total</span>
        </div>
        ${bk.subjects && bk.subjects.length ? `<div class="pill-row" style="margin-top:6px;">${bk.subjects.slice(0, 4).map(s => `<span class="badge teal">${escapeHtml(s)}</span>`).join('')}</div>` : ''}
        ${bk.isbn ? `<div class="muted" style="margin-top:6px; font-size:11px;">ISBN ${escapeHtml(bk.isbn)}</div>` : ''}
      </div>
    </div>

    <div class="row" style="margin-top:14px;">
      ${isLibrary
        ? `<button class="ghost small" onclick="convertToOwned('${isbn}')">Convert to owned</button>`
        : `<button class="ghost small" onclick="toggleLocation('${isbn}')">${otherLocLabel}</button>`}
      ${!isLibrary ? `<button class="ghost small" onclick="convertToLibrary('${isbn}')">Mark as library book</button>` : ''}
    </div>

    <h3 style="margin-top:18px;">Times read</h3>
    ${state.kids.length ? state.kids.map(k => {
      const n = (bk.readsByKid || {})[k.id] || 0;
      return `<div class="kid-row">
        <div class="kid-avatar">${escapeHtml((k.name || '?').slice(0, 1).toUpperCase())}</div>
        <div class="kid-info">
          <div class="kid-name">${escapeHtml(k.name)}</div>
          <div class="kid-meta">📖 ${n} read${n === 1 ? '' : 's'}</div>
        </div>
        ${n > 0 ? `<button class="ghost small" onclick="unbumpRead('${isbn}','${k.id}')">−1</button>` : ''}
        <button class="secondary small" onclick="bumpRead('${isbn}','${k.id}')">+1 read</button>
      </div>`;
    }).join('') : '<p class="muted">Add kids in the Kids tab to log per-kid reads.</p>'}

    <h3 style="margin-top:18px;">Add a review</h3>
    <div class="pill-row">${kidsOptions}</div>
    <h3 style="margin-top:18px;">Reviews</h3>
    ${reviewsHtml}
    <div style="margin-top:14px;">
      <button class="danger small" onclick="deleteBook('${isbn}')">Remove book from library</button>
    </div>
  `);
};

window.editBookMeta = function (isbn: string) {
  const bk = state.books.find(b => b.isbn === isbn);
  if (!bk) return;
  openModal(`
    <button class="close" onclick="closeModal()">×</button>
    <h2>Edit title &amp; author</h2>
    ${bk.cover ? `<div class="cover" style="width:90px; height:135px; aspect-ratio:auto; background:url('${escapeAttr(bk.cover)}') center/cover; border-radius:8px; margin-bottom:10px;"></div>` : ''}
    <label>Title</label>
    <input type="text" id="ebmTitle" value="${escapeAttr(bk.title || '')}" />
    <label>Author</label>
    <input type="text" id="ebmAuthor" value="${escapeAttr((bk.authors || []).join(', '))}" />
    <div class="row" style="margin-top:14px;">
      <button class="primary" onclick="saveBookMeta('${isbn}')">Save</button>
      <button class="ghost" onclick="openBook('${isbn}')">Back</button>
    </div>
  `);
  setTimeout(() => (document.getElementById('ebmTitle') as HTMLInputElement).focus(), 100);
};

window.saveBookMeta = async function (isbn: string) {
  const bk = state.books.find(b => b.isbn === isbn);
  if (!bk) return;
  const title = (document.getElementById('ebmTitle') as HTMLInputElement).value.trim();
  const authorStr = (document.getElementById('ebmAuthor') as HTMLInputElement).value.trim();
  const authors = authorStr ? authorStr.split(',').map(s => s.trim()).filter(Boolean) : [];
  try {
    const updated = await api<Book>('PATCH', `/api/books/${encodeURIComponent(isbn)}`, { title, authors });
    Object.assign(bk, updated);
    window.openBook(isbn); renderLibrary(); toast('Saved');
  } catch (e) { toast((e as Error).message); }
};

interface RefineResponse {
  extracted: { title: string | null; author: string | null; illustrator: string | null; confidence: 'high' | 'medium' | 'low' } | null;
  isbnCandidates: Array<{ isbn: string; title: string; author: string; cover?: string }>;
  model: string;
}

let _refineState: { isbn: string; result: RefineResponse } | null = null;

window.refineFromCover = async function (isbn: string) {
  const bk = state.books.find(b => b.isbn === isbn);
  if (!bk) return;
  openModal(`
    <button class="close" onclick="closeModal()">×</button>
    <h2>✨ Refining from cover…</h2>
    <p class="muted">Asking Claude to read the cover photo. Usually 2-5 seconds.</p>
    <div class="cover" style="width:90px; height:135px; aspect-ratio:auto; ${bk.cover ? `background:url('${escapeAttr(bk.cover)}') center/cover;` : 'background:#ece2d2;'} border-radius:8px; margin: 10px 0;"></div>
  `);

  let result: RefineResponse;
  try {
    result = await api<RefineResponse>('POST', `/api/books/${encodeURIComponent(isbn)}/refine`);
  } catch (e) {
    toast('Refine failed: ' + (e as Error).message);
    closeModal();
    return;
  }
  _refineState = { isbn, result };

  if (!result.extracted) {
    openModal(`
      <button class="close" onclick="closeModal()">×</button>
      <h2>Couldn't read the cover</h2>
      <p class="muted">The model couldn't extract a title or author from this photo. Edit manually below.</p>
      <div class="row" style="margin-top:14px;">
        <button class="ghost" onclick="editBookMeta('${isbn}')">Edit manually</button>
        <button class="primary" onclick="closeModal()">Close</button>
      </div>
    `);
    return;
  }

  const ex = result.extracted;
  const confBadge = ex.confidence === 'high' ? 'shelf' : (ex.confidence === 'medium' ? 'teal' : 'backstock');
  const candidatesHtml = result.isbnCandidates.length
    ? result.isbnCandidates.map((c, i) => `
        <label style="display:flex; gap:10px; align-items:center; padding:8px; border:1px solid var(--border); border-radius:8px; margin-top:6px; cursor:pointer;">
          <input type="radio" name="isbnPick" value="${escapeAttr(c.isbn)}" ${i === 0 ? 'checked' : ''} />
          <div class="cover" style="width:36px; height:54px; aspect-ratio:auto; flex:0 0 36px; ${c.cover ? `background:url('${escapeAttr(c.cover)}') center/cover;` : 'background:#ece2d2;'} border-radius:4px;"></div>
          <div style="flex:1; min-width:0;">
            <div style="font-weight:600; font-size:14px;">${escapeHtml(c.title)}</div>
            <div class="muted" style="font-size:12px;">${escapeHtml(c.author)}</div>
            <div class="muted" style="font-size:11px; font-family: ui-monospace, monospace;">${escapeHtml(c.isbn)}</div>
          </div>
        </label>`).join('')
      + `<label style="display:flex; gap:10px; align-items:center; padding:8px; border:1px solid var(--border); border-radius:8px; margin-top:6px; cursor:pointer;">
          <input type="radio" name="isbnPick" value="" />
          <div style="flex:1;">
            <div style="font-weight:600;">Keep current ID (${escapeHtml(isbn)})</div>
            <div class="muted" style="font-size:12px;">Save title/author only; don't replace the placeholder ISBN.</div>
          </div>
        </label>`
    : `<p class="muted">No ISBN matches found in openlibrary. Title and author will still be saved.</p>`;

  openModal(`
    <button class="close" onclick="closeModal()">×</button>
    <h2>✨ Refine suggestions</h2>
    <span class="badge ${confBadge}">${escapeHtml(ex.confidence)} confidence</span>
    <span class="muted" style="font-size:11px; margin-left:6px;">via ${escapeHtml(result.model)}</span>

    <label style="margin-top:14px;">Title</label>
    <input type="text" id="refineTitle" value="${escapeAttr(ex.title ?? '')}" />
    <label>Author</label>
    <input type="text" id="refineAuthor" value="${escapeAttr(ex.author ?? '')}" />
    ${ex.illustrator ? `<p class="muted" style="margin-top:6px;">Illustrator detected: ${escapeHtml(ex.illustrator)} (add to author field manually if you want)</p>` : ''}

    <h3 style="margin-top:14px;">ISBN candidates</h3>
    ${candidatesHtml}

    <div class="row" style="margin-top:14px;">
      <button class="primary" onclick="applyRefine('${isbn}')">Accept</button>
      <button class="ghost" onclick="closeModal()">Cancel</button>
    </div>
  `);
};

window.applyRefine = async function (isbn: string) {
  if (!_refineState || _refineState.isbn !== isbn) {
    toast('Refine state lost — try again');
    closeModal();
    return;
  }
  const title = (document.getElementById('refineTitle') as HTMLInputElement).value.trim();
  const authorStr = (document.getElementById('refineAuthor') as HTMLInputElement).value.trim();
  const authors = authorStr ? authorStr.split(',').map(s => s.trim()).filter(Boolean) : [];
  const pickedIsbn = (document.querySelector<HTMLInputElement>('input[name="isbnPick"]:checked')?.value ?? '').trim();

  try {
    await api('PATCH', `/api/books/${encodeURIComponent(isbn)}`, { title, authors });
    let finalIsbn = isbn;
    if (pickedIsbn && pickedIsbn !== isbn) {
      const rekeyRes = await api<{ newIsbn: string }>('POST', `/api/books/${encodeURIComponent(isbn)}/rekey`, { newIsbn: pickedIsbn });
      finalIsbn = rekeyRes.newIsbn;
    }
    await refreshState();
    renderLibrary();
    toast(pickedIsbn && pickedIsbn !== isbn ? `Refined + linked to ${finalIsbn}` : 'Refined');
    closeModal();
    setTimeout(() => window.openBook(finalIsbn), 100);
  } catch (e) {
    toast('Apply failed: ' + (e as Error).message);
  } finally {
    _refineState = null;
  }
};

window.bumpRead = async function (isbn: string, kidId: string) {
  const bk = state.books.find(b => b.isbn === isbn);
  const kid = state.kids.find(k => k.id === kidId);
  if (!bk || !kid) return;
  try {
    const res = await api<{ count: number }>('POST', `/api/books/${encodeURIComponent(isbn)}/reads`, { kidId, delta: 1 });
    bk.readsByKid = { ...(bk.readsByKid || {}), [kidId]: res.count };
    window.openBook(isbn); renderLibrary();
    toast(`📖 ${kid.name}: ${res.count} reads`);
  } catch (e) { toast((e as Error).message); }
};

window.unbumpRead = async function (isbn: string, kidId: string) {
  const bk = state.books.find(b => b.isbn === isbn);
  if (!bk) return;
  if (((bk.readsByKid || {})[kidId] || 0) <= 0) return;
  try {
    const res = await api<{ count: number }>('POST', `/api/books/${encodeURIComponent(isbn)}/reads`, { kidId, delta: -1 });
    bk.readsByKid = { ...(bk.readsByKid || {}) };
    if (res.count === 0) delete bk.readsByKid[kidId]; else bk.readsByKid[kidId] = res.count;
    window.openBook(isbn); renderLibrary();
  } catch (e) { toast((e as Error).message); }
};

window.toggleLocation = async function (isbn: string) {
  const bk = state.books.find(b => b.isbn === isbn);
  if (!bk) return;
  const newLoc: Book['location'] = bk.location === 'accessible' ? 'backstock' : 'accessible';
  try {
    const updated = await api<Book>('PATCH', `/api/books/${encodeURIComponent(isbn)}`, { location: newLoc });
    Object.assign(bk, updated);
    window.openBook(isbn); renderLibrary();
    toast(newLoc === 'accessible' ? '📚 Moved to shelf' : '📦 Moved to backstock');
  } catch (e) { toast((e as Error).message); }
};

window.convertToLibrary = async function (isbn: string) {
  const bk = state.books.find(b => b.isbn === isbn);
  if (!bk) return;
  try {
    const updated = await api<Book>('PATCH', `/api/books/${encodeURIComponent(isbn)}`, { source: 'library', location: 'accessible' });
    Object.assign(bk, updated);
    window.openBook(isbn); renderLibrary();
    toast('📕 Marked as library book');
  } catch (e) { toast((e as Error).message); }
};

window.convertToOwned = async function (isbn: string) {
  const bk = state.books.find(b => b.isbn === isbn);
  if (!bk) return;
  try {
    const updated = await api<Book>('PATCH', `/api/books/${encodeURIComponent(isbn)}`, { source: 'owned' });
    Object.assign(bk, updated);
    window.openBook(isbn); renderLibrary();
    toast('Converted to owned');
  } catch (e) { toast((e as Error).message); }
};

window.deleteBook = async function (isbn: string) {
  if (!confirm('Remove this book and all its reviews?')) return;
  try {
    await api('DELETE', `/api/books/${encodeURIComponent(isbn)}`);
    state.books = state.books.filter(b => b.isbn !== isbn);
    state.reviews = state.reviews.filter(r => r.bookIsbn !== isbn);
    closeModal(); renderLibrary(); toast('Removed');
  } catch (e) { toast((e as Error).message); }
};

window.deleteReview = async function (id: string) {
  try {
    await api('DELETE', `/api/reviews/${id}`);
    state.reviews = state.reviews.filter(r => r.id !== id);
    toast('Review deleted'); closeModal(); renderLibrary();
  } catch (e) { toast((e as Error).message); }
};

window.newReview = function (isbn: string, kidId: string) {
  const bk = state.books.find(b => b.isbn === isbn)!;
  const kid = state.kids.find(k => k.id === kidId)!;
  const today = new Date().toISOString().slice(0, 10);
  openModal(`
    <button class="close" onclick="closeModal()">×</button>
    <h2>${escapeHtml(kid.name)}'s review</h2>
    <div class="muted">${escapeHtml(bk.title || '(no title)')}</div>
    <label>Rating</label>
    <div class="stars" id="starPicker">${[1, 2, 3, 4, 5].map(i => `<span class="s" data-v="${i}">★</span>`).join('')}</div>
    <label>What they liked</label>
    <textarea id="rLiked" placeholder="e.g. silly illustrations, the part where..."></textarea>
    <label>What they didn't like</label>
    <textarea id="rDisliked" placeholder="e.g. too scary, too long"></textarea>
    <label>Other notes</label>
    <textarea id="rNotes" placeholder="Any context about the read"></textarea>
    <label>Date read</label>
    <input type="date" id="rDate" value="${today}" />
    <div class="row" style="margin-top:14px;">
      <button class="primary" onclick="saveReview('${isbn}','${kidId}')">Save review</button>
    </div>
  `);
  let rating = 0;
  document.querySelectorAll<HTMLSpanElement>('#starPicker .s').forEach(s => {
    s.addEventListener('click', () => {
      rating = parseInt(s.dataset.v!, 10);
      document.querySelectorAll<HTMLSpanElement>('#starPicker .s').forEach(x => x.classList.toggle('on', parseInt(x.dataset.v!, 10) <= rating));
    });
  });
  window._pendingRating = () => rating;
};

window.saveReview = async function (isbn: string, kidId: string) {
  const rating = window._pendingRating ? window._pendingRating() : 0;
  if (!rating) { toast('Pick a rating first'); return; }
  const body = {
    kidId, bookIsbn: isbn, rating,
    liked: (document.getElementById('rLiked') as HTMLTextAreaElement).value.trim(),
    disliked: (document.getElementById('rDisliked') as HTMLTextAreaElement).value.trim(),
    notes: (document.getElementById('rNotes') as HTMLTextAreaElement).value.trim(),
    dateRead: (document.getElementById('rDate') as HTMLInputElement).value,
  };
  try {
    const created = await api<Review>('POST', '/api/reviews', body);
    state.reviews.push(created);
    closeModal(); renderLibrary(); toast('Review saved');
  } catch (e) { toast((e as Error).message); }
};

/* ============================ ADD TAB ============================ */

document.querySelectorAll<HTMLButtonElement>('#manualModePicker [data-mode]').forEach(b => {
  b.addEventListener('click', () => {
    manualMode = b.dataset.mode as typeof manualMode;
    document.querySelectorAll<HTMLButtonElement>('#manualModePicker [data-mode]').forEach(x => x.setAttribute('aria-selected', String(x.dataset.mode === manualMode)));
    document.querySelectorAll<HTMLElement>('.manual-section').forEach(s => s.classList.toggle('active', s.id === 'manual-' + manualMode));
  });
});

/* ============================ SCANNING ============================ */

let videoStream: MediaStream | null = null;
let detector: any = null;
let scanLoop: ReturnType<typeof setInterval> | null = null;
let zxingReader: any = null;

async function startScanner() {
  document.getElementById('scanFallback')!.innerHTML = '';
  if (window.BarcodeDetector) {
    try {
      detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a'] });
      videoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
      const video = document.getElementById('video') as HTMLVideoElement;
      video.srcObject = videoStream;
      document.getElementById('scanWrap')!.classList.add('active');
      (document.getElementById('btnStartScan') as HTMLElement).style.display = 'none';
      (document.getElementById('btnStopScan') as HTMLElement).style.display = 'inline-flex';
      scanLoop = setInterval(async () => {
        try {
          const codes = await detector.detect(video);
          if (codes.length) { const isbn = codes[0].rawValue as string; stopScanner(); lookupAndAdd(isbn); }
        } catch {}
      }, 350);
      return;
    } catch (e: any) {
      document.getElementById('scanFallback')!.innerHTML =
        "Couldn't access the camera (" + escapeHtml(e.message || 'permission denied') + "). Use manual entry below.";
      return;
    }
  }
  if (window.ZXingBrowser) {
    try {
      const BF = window.ZXingBrowser.BarcodeFormat;
      const hints = new Map();
      hints.set(2, [BF.EAN_13, BF.UPC_A, BF.EAN_8, BF.UPC_E]);
      hints.set(3, true);
      zxingReader = new window.ZXingBrowser.BrowserMultiFormatReader(hints);
      document.getElementById('scanWrap')!.classList.add('active');
      (document.getElementById('btnStartScan') as HTMLElement).style.display = 'none';
      (document.getElementById('btnStopScan') as HTMLElement).style.display = 'inline-flex';
      const constraints = {
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      };
      let frames = 0;
      window._scanDiag = setInterval(() => {
        const hint = document.querySelector<HTMLElement>('.scan-hint');
        if (hint) hint.textContent = `Scanning… ${frames} frames processed`;
      }, 300);
      const controls = await zxingReader.decodeFromConstraints(constraints, 'video', (result: any) => {
        frames++;
        if (result) {
          if (window._scanDiag) clearInterval(window._scanDiag);
          const isbn = result.getText();
          stopScanner();
          lookupAndAdd(isbn);
        }
      });
      zxingReader._controls = controls;
      return;
    } catch (e: any) {
      document.getElementById('scanFallback')!.innerHTML =
        "Couldn't start scanner (" + escapeHtml(e.message || 'error') + "). Use manual entry below.";
      return;
    }
  }
  document.getElementById('scanFallback')!.innerHTML =
    "Your browser can't scan barcodes. Type the ISBN by hand below.";
}

function stopScanner() {
  if (scanLoop) { clearInterval(scanLoop); scanLoop = null; }
  if (window._scanDiag) { clearInterval(window._scanDiag); window._scanDiag = undefined; }
  if (videoStream) { videoStream.getTracks().forEach(t => t.stop()); videoStream = null; }
  if (zxingReader) {
    try { zxingReader._controls && zxingReader._controls.stop(); } catch {}
    try { zxingReader.reset && zxingReader.reset(); } catch {}
    zxingReader = null;
  }
  document.getElementById('scanWrap')!.classList.remove('active');
  (document.getElementById('btnStartScan') as HTMLElement).style.display = 'inline-flex';
  (document.getElementById('btnStopScan') as HTMLElement).style.display = 'none';
}

document.getElementById('btnStartScan')!.addEventListener('click', startScanner);
document.getElementById('btnStopScan')!.addEventListener('click', stopScanner);
document.getElementById('btnLookup')!.addEventListener('click', () => {
  const isbn = (document.getElementById('manualIsbn') as HTMLInputElement).value.replace(/[^\dXx]/g, '');
  if (!isbn) { toast('Enter an ISBN'); return; }
  lookupAndAdd(isbn);
});

interface LookupResult {
  isbn: string;
  title?: string;
  authors?: string[];
  subjects?: string[];
  publishYear?: string | null;
  cover?: string | null;
  source?: string;
}

async function lookupAndAdd(rawIsbn: string) {
  const isbn = rawIsbn.replace(/[^\dXx]/g, '');
  if (state.books.some(b => b.isbn === isbn)) {
    toast('Already in your library — opening it');
    window.openBook(isbn);
    return;
  }
  const lookupResult = document.getElementById('lookupResult')!;
  lookupResult.innerHTML = `<div class="card"><p class="muted">Looking up ISBN ${escapeHtml(isbn)}…</p></div>`;
  lookupResult.scrollIntoView({ behavior: 'smooth', block: 'start' });

  let book: LookupResult | null = null;
  try {
    book = await api<LookupResult>('GET', `/api/lookup/${encodeURIComponent(isbn)}`);
  } catch {
    book = null;
  }
  if (!book) {
    lookupResult.innerHTML = `
      <div class="card">
        <h3>Couldn't find ISBN ${escapeHtml(isbn)}</h3>
        <p class="muted">Try a manual entry mode below — by ISBN (with a corrected number), by cover photo, or by title &amp; author.</p>
        <button class="ghost" onclick="document.getElementById('lookupResult').innerHTML=''">Dismiss</button>
      </div>`;
    lookupResult.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  showPreview(book, isbn);
}

function showPreview(book: LookupResult, scannedIsbn: string) {
  const lookupResult = document.getElementById('lookupResult')!;
  const lastChoice = getLastScanChoice();
  lookupResult.innerHTML = `
    <div class="card">
      <h3>Add this book?</h3>
      <div class="muted" style="font-size:12px; margin-bottom:8px;">
        Scanned ISBN: <b style="font-family: ui-monospace, monospace;">${escapeHtml(scannedIsbn)}</b>
        — verify this matches the number under the barcode on the back of your book.
      </div>
      <div style="display:flex; gap:14px;">
        <div class="cover" style="width:90px; height:135px; aspect-ratio:auto; flex:0 0 90px; ${book.cover ? `background:url('${escapeAttr(book.cover)}') center/cover;` : 'background:#ece2d2;'} border-radius:8px;"></div>
        <div style="flex:1; min-width:0;">
          <div style="font-weight:600;">${escapeHtml(book.title || '')}</div>
          <div class="muted">${escapeHtml((book.authors || []).join(', '))}</div>
          ${book.publishYear ? `<div class="muted" style="font-size:12px;">${escapeHtml(book.publishYear)}</div>` : ''}
          ${book.subjects && book.subjects.length ? `<div class="pill-row" style="margin-top:6px;">${book.subjects.slice(0, 3).map(s => `<span class="badge teal">${escapeHtml(s)}</span>`).join('')}</div>` : ''}
        </div>
      </div>
      <label style="margin-top:10px;">Where does this go?</label>
      <select id="addLocation">
        <option value="owned-backstock" ${lastChoice === 'owned-backstock' ? 'selected' : ''}>📦 Backstock (owned)</option>
        <option value="owned-accessible" ${lastChoice === 'owned-accessible' ? 'selected' : ''}>📚 On accessible shelf (owned)</option>
        <option value="library" ${lastChoice === 'library' ? 'selected' : ''}>📕 Library book</option>
      </select>
      <div class="row" style="margin-top:10px;">
        <button class="primary" id="btnConfirmAdd">Add to library</button>
        <button class="ghost" id="btnWrongBook">Wrong book?</button>
        <button class="ghost" id="btnCancelAdd">Cancel</button>
      </div>
      <div id="wrongBookForm" style="display:none; margin-top:10px;">
        <h3 style="margin-top:0;">Option 1: Look up by a different ISBN</h3>
        <div class="row">
          <input type="text" inputmode="numeric" id="correctIsbn" value="${escapeAttr(scannedIsbn)}" />
          <button class="secondary" id="btnRetryLookup">Look up</button>
        </div>
        <p class="muted" style="font-size:12px; margin-top:6px;">ISBN-13 is the 13-digit number that starts with 978 or 979.</p>

        <h3 style="margin-top:14px;">Option 2: Just fix the title &amp; author</h3>
        <p class="muted" style="font-size:12px;">Keeps the scanned ISBN, replaces just the title and author.</p>
        <label>Title</label>
        <input type="text" id="overrideTitle" value="${escapeAttr(book.title || '')}" />
        <label>Author</label>
        <input type="text" id="overrideAuthor" value="${escapeAttr((book.authors || []).join(', '))}" />
        <div class="row" style="margin-top:8px;">
          <button class="primary" id="btnSaveOverride">Save with these</button>
        </div>
      </div>
    </div>`;
  lookupResult.scrollIntoView({ behavior: 'smooth', block: 'start' });

  (document.getElementById('btnConfirmAdd') as HTMLButtonElement).onclick = async () => {
    const choice = (document.getElementById('addLocation') as unknown as HTMLSelectElement).value;
    const { source, location } = parseScanChoice(choice);
    try {
      const created = await api<Book>('POST', '/api/books', {
        isbn: scannedIsbn,
        title: book.title,
        authors: book.authors,
        subjects: book.subjects,
        publishYear: book.publishYear,
        cover: book.cover,
        source, location,
      });
      state.books.push(created);
      setLastScanChoice(choice);
      lookupResult.innerHTML = '';
      renderRecentScans();
      toast(`Added: ${created.title ?? scannedIsbn}`);
      (document.getElementById('manualIsbn') as HTMLInputElement).value = '';
    } catch (e) { toast((e as Error).message); }
  };
  (document.getElementById('btnCancelAdd') as HTMLButtonElement).onclick = () => { lookupResult.innerHTML = ''; };
  (document.getElementById('btnWrongBook') as HTMLButtonElement).onclick = () => {
    (document.getElementById('wrongBookForm') as HTMLElement).style.display = 'block';
  };
  (document.getElementById('btnRetryLookup') as HTMLButtonElement).onclick = () => {
    const newIsbn = (document.getElementById('correctIsbn') as HTMLInputElement).value.replace(/[^\dXx]/g, '');
    if (!newIsbn || newIsbn === scannedIsbn) { toast('Enter a different ISBN'); return; }
    lookupResult.innerHTML = '';
    lookupAndAdd(newIsbn);
  };
  (document.getElementById('btnSaveOverride') as HTMLButtonElement).onclick = async () => {
    const newTitle = (document.getElementById('overrideTitle') as HTMLInputElement).value.trim();
    const newAuthor = (document.getElementById('overrideAuthor') as HTMLInputElement).value.trim();
    if (!newTitle) { toast('Title is required'); return; }
    const choice = (document.getElementById('addLocation') as unknown as HTMLSelectElement).value;
    const { source, location } = parseScanChoice(choice);
    try {
      const created = await api<Book>('POST', '/api/books', {
        isbn: scannedIsbn,
        title: newTitle,
        authors: newAuthor ? newAuthor.split(',').map(s => s.trim()).filter(Boolean) : [],
        source, location,
      });
      state.books.push(created);
      setLastScanChoice(choice);
      lookupResult.innerHTML = '';
      renderRecentScans();
      toast(`Added (overridden): ${newTitle}`);
    } catch (e) { toast((e as Error).message); }
  };
}

/* ============================ PHOTO ============================ */

document.getElementById('coverPhotoInput')!.addEventListener('change', async (e: Event) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const { blob, dataUrl } = await fileToCompressed(file, 400, 600, 0.75);
  pendingPhotoBlob = blob;
  pendingPhotoDataUrl = dataUrl;
  const preview = document.getElementById('coverPhotoPreview') as HTMLElement;
  preview.style.display = 'block';
  preview.style.backgroundImage = `url('${dataUrl}')`;
});

function fileToCompressed(file: File, maxW: number, maxH: number, quality: number): Promise<{ blob: Blob; dataUrl: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      const ratio = Math.min(maxW / w, maxH / h, 1);
      w = Math.round(w * ratio);
      h = Math.round(h * ratio);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => {
        if (!blob) return reject(new Error('canvas toBlob failed'));
        resolve({ blob, dataUrl: canvas.toDataURL('image/jpeg', quality) });
      }, 'image/jpeg', quality);
    };
    img.onerror = reject;
    const fr = new FileReader();
    fr.onload = () => { img.src = fr.result as string; };
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

document.getElementById('btnSavePhotoBook')!.addEventListener('click', async () => {
  const title = (document.getElementById('photoTitle') as HTMLInputElement).value.trim();
  const author = (document.getElementById('photoAuthor') as HTMLInputElement).value.trim();
  if (!pendingPhotoBlob && !title) { toast('Take a photo or type a title'); return; }
  // Photo-only quick-save: uses sticky default location
  if (!title && !author && pendingPhotoBlob) {
    const choice = getLastScanChoice();
    const { source, location } = parseScanChoice(choice);
    const isbn = 'manual-' + uid();
    try {
      await api<Book>('POST', '/api/books', { isbn, title: '', authors: [], source, location });
      // Upload cover separately
      await api('POST', `/api/books/${encodeURIComponent(isbn)}/cover`, pendingPhotoBlob, { raw: true, contentType: 'image/jpeg' });
      // Refresh just this book's representation by re-fetching state (cheap enough)
      await refreshState();
      renderRecentScans();
      toast(`📸 Photo saved (${source === 'library' ? 'library' : location})`);
    } catch (e) { toast((e as Error).message); }
  } else {
    // Title or author provided — go through the normal location-choice preview.
    saveManualBook({ title: title || '', author, blob: pendingPhotoBlob });
  }
  (document.getElementById('photoTitle') as HTMLInputElement).value = '';
  (document.getElementById('photoAuthor') as HTMLInputElement).value = '';
  (document.getElementById('coverPhotoInput') as HTMLInputElement).value = '';
  (document.getElementById('coverPhotoPreview') as HTMLElement).style.display = 'none';
  pendingPhotoBlob = null;
  pendingPhotoDataUrl = null;
});

document.getElementById('btnSaveTextBook')!.addEventListener('click', () => {
  const title = (document.getElementById('textTitle') as HTMLInputElement).value.trim();
  const author = (document.getElementById('textAuthor') as HTMLInputElement).value.trim();
  if (!title) { toast('Title required'); return; }
  saveManualBook({ title, author, blob: null });
  (document.getElementById('textTitle') as HTMLInputElement).value = '';
  (document.getElementById('textAuthor') as HTMLInputElement).value = '';
});

function saveManualBook({ title, author, blob }: { title: string; author: string; blob: Blob | null }) {
  const lastChoice = getLastScanChoice();
  const lookupResult = document.getElementById('lookupResult')!;
  const coverPreview = blob && pendingPhotoDataUrl
    ? `background:url('${escapeAttr(pendingPhotoDataUrl)}') center/cover;`
    : 'background:#ece2d2;';
  lookupResult.innerHTML = `
    <div class="card">
      <h3>Add this book?</h3>
      <div style="display:flex; gap:14px;">
        <div class="cover" style="width:90px; height:135px; aspect-ratio:auto; flex:0 0 90px; ${coverPreview} border-radius:8px;"></div>
        <div style="flex:1; min-width:0;">
          <div style="font-weight:600;">${escapeHtml(title)}</div>
          <div class="muted">${escapeHtml(author || '(no author)')}</div>
        </div>
      </div>
      <label style="margin-top:10px;">Where does this go?</label>
      <select id="manualLocation">
        <option value="owned-backstock" ${lastChoice === 'owned-backstock' ? 'selected' : ''}>📦 Backstock (owned)</option>
        <option value="owned-accessible" ${lastChoice === 'owned-accessible' ? 'selected' : ''}>📚 On accessible shelf (owned)</option>
        <option value="library" ${lastChoice === 'library' ? 'selected' : ''}>📕 Library book</option>
      </select>
      <div class="row" style="margin-top:10px;">
        <button class="primary" id="btnManualConfirm">Add to library</button>
        <button class="ghost" id="btnManualCancel">Cancel</button>
      </div>
    </div>`;
  lookupResult.scrollIntoView({ behavior: 'smooth', block: 'start' });

  (document.getElementById('btnManualConfirm') as HTMLButtonElement).onclick = async () => {
    const choice = (document.getElementById('manualLocation') as unknown as HTMLSelectElement).value;
    const { source, location } = parseScanChoice(choice);
    const isbn = 'manual-' + uid();
    try {
      const created = await api<Book>('POST', '/api/books', {
        isbn,
        title,
        authors: author ? author.split(',').map(s => s.trim()).filter(Boolean) : [],
        source, location,
      });
      if (blob) {
        await api('POST', `/api/books/${encodeURIComponent(isbn)}/cover`, blob, { raw: true, contentType: 'image/jpeg' });
      }
      state.books.push(created);
      setLastScanChoice(choice);
      lookupResult.innerHTML = '';
      await refreshState(); // pull updated cover URL
      renderRecentScans();
      toast(`Added: ${title}`);
    } catch (e) { toast((e as Error).message); }
  };
  (document.getElementById('btnManualCancel') as HTMLButtonElement).onclick = () => { lookupResult.innerHTML = ''; };
}

function renderRecentScans() {
  const recent = state.books.slice().sort((a, b) => (b.addedDate || '').localeCompare(a.addedDate || '')).slice(0, 5);
  if (!recent.length) { (document.getElementById('recentScansCard') as HTMLElement).style.display = 'none'; return; }
  (document.getElementById('recentScansCard') as HTMLElement).style.display = 'block';
  document.getElementById('recentScans')!.innerHTML = recent.map(b => {
    const isLib = b.source === 'library';
    const tag = isLib ? 'lib' : (b.location === 'accessible' ? 'shelf' : 'stock');
    const tagClass = isLib ? 'library' : (b.location === 'accessible' ? 'shelf' : 'backstock');
    return `
      <div class="kid-row" onclick="openBook('${b.isbn}')" style="cursor:pointer;">
        <div class="cover" style="width:36px; height:54px; aspect-ratio:auto; flex:0 0 36px; ${b.cover ? `background:url('${escapeAttr(b.cover)}') center/cover;` : 'background:#ece2d2;'} border-radius:4px;"></div>
        <div class="kid-info">
          <div class="kid-name" style="font-size:14px;">${escapeHtml(b.title || '(no title)')} <span class="badge ${tagClass}" style="margin-left:4px;">${tag}</span></div>
          <div class="kid-meta">${escapeHtml((b.authors || []).join(', '))}</div>
        </div>
      </div>`;
  }).join('');
}

/* ============================ ROTATE ============================ */

function renderRotate() {
  const wrap = document.getElementById('rotateList')!;
  const empty = document.getElementById('rotateEmpty')!;
  const actions = document.getElementById('rotateActions')!;
  const out = document.getElementById('rotatePromptOut')!;
  out.innerHTML = '';

  const accessible = state.books.filter(b => b.source !== 'library' && b.location === 'accessible')
    .sort((a, b) => (a.placedOnShelfAt || '').localeCompare(b.placedOnShelfAt || ''));
  if (!accessible.length) {
    wrap.innerHTML = '';
    (empty as HTMLElement).style.display = 'block';
    (actions as HTMLElement).style.display = 'none';
    return;
  }
  (empty as HTMLElement).style.display = 'none';
  (actions as HTMLElement).style.display = 'flex';

  wrap.innerHTML = accessible.map(bk => {
    const reviewsForBook = state.reviews.filter(r => r.bookIsbn === bk.isbn);
    const avg = reviewsForBook.length ? (reviewsForBook.reduce((s, r) => s + (r.rating || 0), 0) / reviewsForBook.length).toFixed(1) : null;
    const dec = rotationDecisions[bk.isbn] || 'keep';
    return `
      <div class="rotate-item">
        <div class="mini-cover" style="${bk.cover ? `background-image:url('${escapeAttr(bk.cover)}');` : ''}"></div>
        <div class="info">
          <div class="t">${escapeHtml(bk.title || '(no title)')}</div>
          <div class="a">${escapeHtml((bk.authors || []).join(', '))}</div>
          <div class="pill-row" style="margin-top:4px;">
            ${state.kids.map(k => {
              const n = (bk.readsByKid || {})[k.id] || 0;
              return `<span class="badge reads">${escapeHtml(k.name)} ${n}</span>`;
            }).join('')}
            ${avg ? `<span class="badge">★ ${avg}</span>` : ''}
            ${bk.placedOnShelfAt ? `<span class="badge teal">since ${bk.placedOnShelfAt.slice(0, 10)}</span>` : ''}
          </div>
          <div class="decision-row">
            <button class="${dec === 'keep' ? 'sel-keep' : ''}" onclick="setRotateDecision('${bk.isbn}','keep')">Keep</button>
            <button class="${dec === 'hit' ? 'sel-hit' : ''}" onclick="setRotateDecision('${bk.isbn}','hit')">Rotate (hit)</button>
            <button class="${dec === 'ignored' ? 'sel-ignored' : ''}" onclick="setRotateDecision('${bk.isbn}','ignored')">Rotate (ignored)</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

window.setRotateDecision = function (isbn: string, dec: 'keep' | 'hit' | 'ignored') {
  rotationDecisions[isbn] = dec;
  renderRotate();
};

document.getElementById('btnRotateApply')!.addEventListener('click', async () => {
  const out = Object.entries(rotationDecisions).filter(([_, d]) => d === 'hit' || d === 'ignored');
  if (!out.length) { toast('No books flagged to rotate out'); return; }
  if (!confirm(`Move ${out.length} book${out.length > 1 ? 's' : ''} to backstock?`)) return;
  try {
    await api('POST', '/api/books/rotate', {
      decisions: out.map(([isbn, outcome]) => ({ isbn, outcome })),
    });
    rotationDecisions = {};
    await refreshState();
    renderRotate();
    toast(`Moved ${out.length} to backstock`);
  } catch (e) { toast((e as Error).message); }
});

document.getElementById('btnRotateBuildPrompt')!.addEventListener('click', () => {
  const text = buildRotationPrompt();
  document.getElementById('rotatePromptOut')!.innerHTML = `
    <div class="card" style="margin-top:10px;">
      <h3>Rotation prompt</h3>
      <p class="muted">Paste this into the Claude chat. I'll use it to suggest which backstock books to bring forward.</p>
      <pre class="export">${escapeHtml(text)}</pre>
      <div class="row" style="margin-top:8px;">
        <button class="primary" id="btnCopyRot">📋 Copy to clipboard</button>
      </div>
    </div>`;
  (document.getElementById('btnCopyRot') as HTMLButtonElement).onclick = async () => {
    try { await navigator.clipboard.writeText(text); toast('Copied — paste into chat'); }
    catch { toast('Select the text and copy manually'); }
  };
});

function fmtReads(reads?: Record<string, number>): string {
  if (!reads) return 'no recorded reads';
  const parts = Object.entries(reads).filter(([_, n]) => n > 0).map(([kid, n]) => {
    const k = state.kids.find(x => x.id === kid);
    return `${k ? k.name : 'unknown'} ${n}`;
  });
  return parts.length ? parts.join(', ') : 'no recorded reads';
}

function buildRotationPrompt(): string {
  const lines: string[] = [];
  lines.push("ROTATION PLANNING — Please suggest 6-10 books from our BACKSTOCK to bring onto the accessible shelf.");
  lines.push("Optimize for: matching our kids' interests, mixing subject variety, leaning toward books connected to previously-loved titles (same author / series / themes), and avoiding anything just rotated out as ignored. Per-kid read counts indicate WHO engaged with each book — use that to balance the next shelf for each kid.");
  lines.push("Use web search if helpful to assess fit. Output a ranked list with a 1-2 sentence reason per book and which kid it's mainly aimed at.");
  lines.push("");

  if (state.kids.length) {
    lines.push("OUR READERS:");
    state.kids.forEach(k => {
      lines.push(`  • ${k.name} (age ${k.age ?? '?'})${k.interests ? ' — interests: ' + k.interests : ''}${k.notes ? ' — notes: ' + k.notes : ''}`);
      const reviews = state.reviews.filter(r => r.kidId === k.id);
      const loved = reviews.filter(r => (r.rating || 0) >= 4);
      const meh = reviews.filter(r => (r.rating || 0) <= 2);
      if (loved.length) {
        lines.push("    Loved:");
        loved.forEach(r => {
          const bk = state.books.find(b => b.isbn === r.bookIsbn);
          if (bk) lines.push(`      - ${bk.title} — ${(bk.authors || []).join(', ')} (${r.rating}★)${r.liked ? ' — ' + r.liked : ''}`);
        });
      }
      if (meh.length) {
        lines.push("    Did not enjoy:");
        meh.forEach(r => {
          const bk = state.books.find(b => b.isbn === r.bookIsbn);
          if (bk) lines.push(`      - ${bk.title} — ${(bk.authors || []).join(', ')} (${r.rating}★)${r.disliked ? ' — ' + r.disliked : ''}`);
        });
      }
    });
    lines.push("");
  }

  const decided = Object.entries(rotationDecisions);
  const hits = decided.filter(([_, d]) => d === 'hit');
  const ignored = decided.filter(([_, d]) => d === 'ignored');
  const keepers = decided.filter(([_, d]) => d === 'keep');

  if (hits.length) {
    lines.push("JUST ROTATED OUT — HITS (kids engaged with these; we're retiring before they get stale):");
    hits.forEach(([isbn]) => {
      const bk = state.books.find(b => b.isbn === isbn);
      if (bk) lines.push(`  • ${bk.title} — ${(bk.authors || []).join(', ')} — reads: ${fmtReads(bk.readsByKid)}${bk.subjects && bk.subjects.length ? ' — subjects: ' + bk.subjects.slice(0, 3).join(', ') : ''}`);
    });
    lines.push("");
  }
  if (ignored.length) {
    lines.push("JUST ROTATED OUT — IGNORED (kids didn't engage; do NOT recommend similar):");
    ignored.forEach(([isbn]) => {
      const bk = state.books.find(b => b.isbn === isbn);
      if (bk) lines.push(`  • ${bk.title} — ${(bk.authors || []).join(', ')} — reads: ${fmtReads(bk.readsByKid)}${bk.subjects && bk.subjects.length ? ' — subjects: ' + bk.subjects.slice(0, 3).join(', ') : ''}`);
    });
    lines.push("");
  }
  if (keepers.length) {
    lines.push("STAYING ON THE SHELF:");
    keepers.forEach(([isbn]) => {
      const bk = state.books.find(b => b.isbn === isbn);
      if (bk) lines.push(`  • ${bk.title} — ${(bk.authors || []).join(', ')} — reads: ${fmtReads(bk.readsByKid)}`);
    });
    lines.push("");
  }

  const libraryBooks = state.books.filter(b => b.source === 'library');
  if (libraryBooks.length) {
    lines.push("CURRENTLY BORROWED FROM THE LIBRARY (not part of rotation but kids may be engaging with them):");
    libraryBooks.forEach(b => {
      lines.push(`  • ${b.title} — ${(b.authors || []).join(', ')} — reads: ${fmtReads(b.readsByKid)}`);
    });
    lines.push("");
  }

  const historic = state.books.filter(b => b.lastShelfStint && b.location === 'backstock');
  if (historic.length) {
    lines.push("PRIOR ROTATION HISTORY (in backstock, with last shelf outcome):");
    historic.slice(0, 30).forEach(b => {
      lines.push(`  • ${b.title} — ${(b.authors || []).join(', ')} — last outcome: ${b.lastShelfStint!.outcome} — reads at removal: ${fmtReads(b.lastShelfStint!.readsAtRemoval)}`);
    });
    lines.push("");
  }

  const backstock = state.books.filter(b => b.source !== 'library' && b.location === 'backstock');
  if (backstock.length) {
    lines.push(`BACKSTOCK (${backstock.length} books — candidates to bring forward):`);
    backstock.forEach(b => {
      const subj = b.subjects && b.subjects.length ? b.subjects.slice(0, 3).join(', ') : '';
      lines.push(`  • ${b.title} — ${(b.authors || []).join(', ')}${subj ? ' — ' + subj : ''}`);
    });
    lines.push("");
  } else {
    lines.push("(No books in backstock yet — add some via the Add tab.)");
  }

  return lines.join('\n');
}

/* ============================ RECOMMEND ============================ */

function renderRecommend() {
  const picker = document.getElementById('recommendKidPicker')!;
  if (!state.kids.length) {
    picker.innerHTML = '';
    document.getElementById('recommendOutput')!.innerHTML = '<p class="muted">Add a kid in the Kids tab first.</p>';
    return;
  }
  picker.innerHTML = state.kids.map(k =>
    `<button class="pill" onclick="buildPromptForKid('${k.id}')">For ${escapeHtml(k.name)}</button>`,
  ).join('') + `<button class="pill" onclick="buildPromptForAll()">For everyone</button>`;
  document.getElementById('recommendOutput')!.innerHTML = '<p class="muted">Pick a kid to build a recommendation prompt.</p>';
}

function buildPrompt(kidIds: string[]): string {
  const lines: string[] = [];
  lines.push("Please recommend kids' books to ADD to our library (we don't own these yet) for the following reader(s) based on my notes below.");
  lines.push("Use web search to find current titles, award winners, and reasonable next-reads. Avoid books already in our library. Suggest 8-12 books, grouped by reader if more than one, with a 1-2 sentence reason for each.");
  lines.push("");
  for (const kidId of kidIds) {
    const kid = state.kids.find(k => k.id === kidId);
    if (!kid) continue;
    lines.push(`READER: ${kid.name} (age ${kid.age ?? '?'})`);
    if (kid.interests) lines.push(`Interests: ${kid.interests}`);
    if (kid.notes) lines.push(`Notes: ${kid.notes}`);
    const reviews = state.reviews.filter(r => r.kidId === kidId);
    const reviewed = reviews.map(r => ({ bk: state.books.find(b => b.isbn === r.bookIsbn), r }))
      .filter((x): x is { bk: Book; r: Review } => !!x.bk);
    const loved = reviewed.filter(x => (x.r.rating || 0) >= 4);
    const meh = reviewed.filter(x => (x.r.rating || 0) <= 2);
    const middle = reviewed.filter(x => (x.r.rating || 0) === 3);
    const readsFor = (bk: Book) => (bk.readsByKid || {})[kidId] || 0;
    if (loved.length) {
      lines.push("Loved:");
      loved.forEach(x => { const n = readsFor(x.bk); lines.push(`  • ${x.bk.title} — ${(x.bk.authors || []).join(', ')} (${x.r.rating}★${n ? `, read ${n}×` : ''})${x.r.liked ? ' — liked: ' + x.r.liked : ''}`); });
    }
    if (middle.length) {
      lines.push("Okay/mixed:");
      middle.forEach(x => { const n = readsFor(x.bk); lines.push(`  • ${x.bk.title} — ${(x.bk.authors || []).join(', ')} (${x.r.rating}★${n ? `, read ${n}×` : ''})${x.r.notes ? ' — ' + x.r.notes : ''}`); });
    }
    if (meh.length) {
      lines.push("Did not enjoy:");
      meh.forEach(x => { const n = readsFor(x.bk); lines.push(`  • ${x.bk.title} — ${(x.bk.authors || []).join(', ')} (${x.r.rating}★${n ? `, read ${n}×` : ''})${x.r.disliked ? ' — disliked: ' + x.r.disliked : ''}`); });
    }
    lines.push("");
  }
  if (state.books.length) {
    lines.push("OUR FULL LIBRARY (already own or currently borrowed — do NOT re-recommend these):");
    state.books.forEach(b => {
      const tag = b.source === 'library' ? ' [library book]' : '';
      lines.push(`  • ${b.title} — ${(b.authors || []).join(', ')}${tag}`);
    });
  }
  return lines.join('\n');
}

window.buildPromptForKid = (kidId: string) => showPrompt(buildPrompt([kidId]));
window.buildPromptForAll = () => showPrompt(buildPrompt(state.kids.map(k => k.id)));

function showPrompt(text: string) {
  document.getElementById('recommendOutput')!.innerHTML = `
    <p class="muted">Copy the text below and paste it into the Claude chat.</p>
    <pre class="export" id="promptOut">${escapeHtml(text)}</pre>
    <div class="row" style="margin-top:8px;">
      <button class="primary" id="btnCopyPrompt">📋 Copy to clipboard</button>
    </div>
  `;
  (document.getElementById('btnCopyPrompt') as HTMLButtonElement).onclick = async () => {
    try { await navigator.clipboard.writeText(text); toast('Copied — paste into chat'); }
    catch { toast('Select the text and copy manually'); }
  };
}

/* ============================ EXPORT / IMPORT ============================ */

document.getElementById('btnExport')!.addEventListener('click', () => {
  const json = JSON.stringify(state, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url; a.download = `kids-library-${stamp}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast('Exported');
});

document.getElementById('btnImport')!.addEventListener('click', () => {
  (document.getElementById('importFile') as HTMLInputElement).click();
});

document.getElementById('importFile')!.addEventListener('change', async (e: Event) => {
  const inputEl = e.target as HTMLInputElement;
  const file = inputEl.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.kids || !data.books) throw new Error('Not a library file');
    const ok = await confirmDestructive({
      title: 'Import via principal-only endpoint',
      message: `
        <p>This sends the file to <code>/api/admin/import</code>, which upserts
        every kid / book / review into the family D1. Existing rows are updated
        in place by primary key. Photo data-URLs are dropped (re-upload via the
        cover photo button per book).</p>
        <p class="muted">Only emails in <code>PRINCIPAL_EMAILS</code> can run this. If you're not in that list, the request returns 503.</p>`,
      requireText: 'import to the family library',
      dangerLabel: 'Send to /api/admin/import',
    });
    if (!ok) { inputEl.value = ''; return; }
    const summary = await api<{ summary: unknown }>('POST', '/api/admin/import', data);
    await refreshState();
    renderKids(); renderLibrary();
    toast('Imported');
    console.log('Import summary:', summary);
  } catch (err) {
    toast('Import failed: ' + (err as Error).message);
  }
  inputEl.value = '';
});

document.getElementById('btnClear')!.addEventListener('click', async () => {
  toast('Use the Cloudflare dashboard to drop D1 tables — no client clear endpoint by design');
});

/* ============================ UTIL ============================ */

function escapeHtml(s: unknown): string {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
function escapeAttr(s: unknown): string { return escapeHtml(s).replace(/`/g, '&#96;'); }

/* ============================ BOOT ============================ */

(async () => {
  try {
    await refreshState();
  } catch (e) {
    toast('Failed to load library: ' + (e as Error).message);
  }
  renderLibrary();
  renderRecentScans();
})();
