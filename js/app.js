const app = document.getElementById('app');
const TAP_MS = 280;

const state = {
  screen: 'lists',
  lists: [],
  detail: null,
  token: '',
  filter: 'unwatched',
  sort: 'name',
  modal: null,
  draft: null,
  listDraft: null,
  searchQuery: '',
  searchResults: [],
  searchMessage: '',
  formError: '',
  loading: true,
};

let routeGen = 0;
let pendingTap = null;
let pollTimer = null;
let booted = false;

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeUrl(url) {
  if (!url) return '';
  if (url.startsWith('/uploads/')) return esc(url);
  if (url.startsWith('data:image/')) return esc(url);
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return esc(parsed.href);
  } catch {
    return '';
  }
  return '';
}

function deviceId() {
  let id = localStorage.getItem('deviceId');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('deviceId', id);
  }
  return id;
}

function knownTokens() {
  try {
    const tokens = JSON.parse(localStorage.getItem('listTokens') || '[]');
    return Array.isArray(tokens) ? tokens : [];
  } catch {
    return [];
  }
}

function saveTokens(tokens) {
  localStorage.setItem('listTokens', JSON.stringify(tokens.slice(0, 50)));
}

function rememberToken(token) {
  const tokens = knownTokens();
  if (!tokens.includes(token)) {
    tokens.unshift(token);
    saveTokens(tokens);
    return true;
  }
  return false;
}

function displayName() {
  return localStorage.getItem('displayName') || '';
}

function track(name, properties, listToken) {
  fetch('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      deviceId: deviceId(),
      listToken: listToken || '',
      properties: properties || {},
    }),
  }).catch(() => {});
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function toast(message) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 2400);
}

function parseHash() {
  const parts = (location.hash || '#/lists').replace(/^#/, '').split('/').filter(Boolean);
  if (!parts.length || (parts[0] === 'lists' && parts.length === 1)) return { name: 'lists' };
  if (parts[0] === 'lists' && parts[1] === 'new') return { name: 'list-form', mode: 'create' };
  if (parts[0] === 'l' && parts[1]) {
    const token = decodeURIComponent(parts[1]);
    if (parts[2] === 'edit') return { name: 'list-form', mode: 'edit', token };
    if (parts[2] === 'add') return { name: 'video-form', mode: 'add', token };
    if (parts[2] === 'v' && parts[3] && parts[4] === 'edit') {
      return { name: 'video-form', mode: 'edit', token, videoId: decodeURIComponent(parts[3]) };
    }
    if (!parts[2]) return { name: 'watch', token };
  }
  return { name: 'lists' };
}

function applyDetail(detail) {
  state.detail = detail;
  state.detailJson = JSON.stringify(detail);
}

function currentVideo(id) {
  return state.detail && state.detail.videos.find((video) => video.id === id);
}

function sortedVideos() {
  const videos = (state.detail && state.detail.videos) || [];
  const filtered = videos.filter((video) => (state.filter === 'watched' ? video.watched : !video.watched));
  return filtered.sort((a, b) => {
    if (state.sort === 'watch_location') {
      const aLocation = (a.links[0] && a.links[0].location || '').toLocaleLowerCase();
      const bLocation = (b.links[0] && b.links[0].location || '').toLocaleLowerCase();
      if (!aLocation && bLocation) return 1;
      if (aLocation && !bLocation) return -1;
      const byLocation = aLocation.localeCompare(bLocation);
      if (byLocation) return byLocation;
    }
    return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  });
}

function emptyDraft(token) {
  return {
    mode: 'add',
    token,
    videoId: '',
    visible: false,
    title: '',
    plot: '',
    parentalRating: '',
    genre: '',
    posterUrl: '',
    posterDataUrl: '',
    tmdbId: null,
    tmdbMediaType: null,
    source: 'manual',
    links: [{ location: '', url: '' }],
  };
}

function videoToDraft(video, token) {
  return {
    mode: 'edit',
    token,
    videoId: video.id,
    visible: true,
    title: video.title,
    plot: video.plot,
    parentalRating: video.parentalRating,
    genre: video.genre,
    posterUrl: video.posterUrl,
    posterDataUrl: '',
    tmdbId: video.tmdbId,
    tmdbMediaType: video.tmdbMediaType,
    source: video.source,
    links: video.links.length ? video.links.map((link) => ({ location: link.location, url: link.url })) : [{ location: '', url: '' }],
  };
}

function readVideoDraft() {
  const form = document.getElementById('video-form');
  if (!form || !state.draft) return;
  state.draft.title = form.elements.title.value;
  state.draft.plot = form.elements.plot.value;
  state.draft.parentalRating = form.elements.parentalRating.value;
  state.draft.genre = form.elements.genre.value;
  state.draft.links = [...form.querySelectorAll('.link-row')].map((row) => ({
    location: row.querySelector('[name="location"]').value,
    url: row.querySelector('[name="url"]').value,
  }));
}

function readListDraft() {
  const form = document.getElementById('list-form');
  if (!form || !state.listDraft) return;
  state.listDraft.name = form.elements.name.value;
}

function shareUrl(token) {
  return `${location.origin}${location.pathname}#/l/${encodeURIComponent(token)}`;
}

function coverMarkup(url, name, className) {
  const letter = esc((name || '?').slice(0, 1).toUpperCase());
  if (!url) return `<div class="${className} cover-fallback" aria-hidden="true">${letter}</div>`;
  return `<img class="${className}" alt="" src="${safeUrl(url)}" data-fallback="${letter}">`;
}

function posterMarkup(url, title, className) {
  const letter = esc((title || '?').slice(0, 1).toUpperCase());
  if (!url) return `<div class="${className} poster-fallback" aria-hidden="true">${letter}</div>`;
  return `<img class="${className}" alt="${esc(title)}" src="${safeUrl(url)}" data-fallback="${letter}">`;
}

function renderLists() {
  const cards = state.lists.map((list) => `
    <div class="list-card" role="button" tabindex="0" data-tap="list" data-token="${esc(list.shareToken)}">
      ${coverMarkup(list.coverUrl, list.name, 'cover')}
      <div class="list-copy"><h2 class="list-name">${esc(list.name)}</h2></div>
    </div>
  `).join('');
  app.innerHTML = `
    <main class="screen narrow">
      <header class="topbar">
        <h1>Watchlists</h1>
        <button type="button" class="primary" data-action="go" data-href="#/lists/new">New list</button>
      </header>
      <p class="hint">Tap a list to open it. Double-tap a list to edit its name and cover.</p>
      <div class="list-stack">
        ${cards || '<p class="empty">Create a list for the movies, shows, and videos you want to watch.</p>'}
      </div>
    </main>
  `;
}

function renderListForm() {
  const draft = state.listDraft;
  const preview = draft.coverDataUrl || draft.coverUrl;
  app.innerHTML = `
    <main class="screen narrow">
      <header class="topbar">
        <button type="button" class="text-button" data-action="go" data-href="${draft.mode === 'edit' ? `#/l/${encodeURIComponent(draft.token)}` : '#/lists'}">Back</button>
        <h1>${draft.mode === 'edit' ? 'Edit list' : 'New list'}</h1>
      </header>
      ${state.formError ? `<p class="alert" role="alert">${esc(state.formError)}</p>` : ''}
      <form id="list-form" class="stack">
        <label class="field"><span>List name</span><input name="name" maxlength="80" required value="${esc(draft.name)}"></label>
        <div class="field">
          <span>Cover art</span>
          ${preview ? `<img class="cover-preview" alt="" src="${safeUrl(preview)}">` : ''}
          <label class="file-btn">Choose image<input id="cover-file" name="cover" type="file" accept="image/*"></label>
        </div>
        <button class="primary" type="submit">Save</button>
      </form>
    </main>
  `;
}

function renderWatch() {
  const detail = state.detail;
  const videos = sortedVideos();
  const leader = detail.leader;
  const names = leader && leader.names.length ? ` · ${leader.names.join(', ')}` : '';
  const banner = leader
    ? `Watch next: ${esc(leader.title)} · ${leader.count} ${leader.count === 1 ? 'vote' : 'votes'}${esc(names)}`
    : 'No votes yet. Open a video and vote for what to watch next.';
  const cards = videos.map((video) => `
    <article class="video-card" data-tap="video" data-id="${esc(video.id)}" role="button" tabindex="0">
      ${posterMarkup(video.posterUrl, video.title, 'poster')}
      <h2 class="video-title">${esc(video.title)}</h2>
    </article>
  `).join('');
  const empty = state.filter === 'watched'
    ? 'No videos marked watched yet.'
    : 'No unwatched videos. Add one with the plus button.';
  app.innerHTML = `
    <main class="screen">
      <header class="topbar">
        <button type="button" class="text-button" data-action="go" data-href="#/lists">Lists</button>
        <h1>${esc(detail.list.name)}</h1>
        <button type="button" class="text-button" data-action="open-share">Share</button>
      </header>
      <p class="vote-banner">${banner}</p>
      <div class="toolbar">
        <div class="segment" role="group" aria-label="Filter">
          <button type="button" data-action="filter" data-filter="unwatched" aria-pressed="${state.filter === 'unwatched'}">Unwatched</button>
          <button type="button" data-action="filter" data-filter="watched" aria-pressed="${state.filter === 'watched'}">Watched</button>
        </div>
        <label class="sort"><span>Sort</span>
          <select id="sort">
            <option value="name" ${state.sort === 'name' ? 'selected' : ''}>Name</option>
            <option value="watch_location" ${state.sort === 'watch_location' ? 'selected' : ''}>Watch location</option>
          </select>
        </label>
        <button type="button" class="text-button" data-action="ask-reset">Reset watched</button>
      </div>
      <p class="hint">Tap a video for details. Double-tap to watch.</p>
      <div class="video-grid">
        ${cards || `<p class="empty">${empty}</p>`}
      </div>
    </main>
    <button type="button" class="fab" data-action="go" data-href="#/l/${encodeURIComponent(state.token)}/add" aria-label="Add video">+</button>
    ${renderModal()}
  `;
}

function renderVideoForm() {
  const draft = state.draft;
  const preview = draft.posterDataUrl || draft.posterUrl;
  const fields = draft.visible ? `
    <form id="video-form" class="stack">
      <label class="field"><span>Title</span><input name="title" maxlength="200" required value="${esc(draft.title)}"></label>
      <label class="field"><span>Description</span><textarea name="plot" maxlength="4000">${esc(draft.plot)}</textarea></label>
      <label class="field"><span>Parental guidance rating</span><input name="parentalRating" maxlength="40" placeholder="PG-13" value="${esc(draft.parentalRating)}"></label>
      <label class="field"><span>Genre</span><input name="genre" maxlength="120" placeholder="Comedy" value="${esc(draft.genre)}"></label>
      <div class="field">
        <span>Poster</span>
        ${preview ? posterMarkup(preview, draft.title || 'Poster', 'preview') : ''}
        <label class="file-btn">Upload poster<input id="poster-file" type="file" accept="image/*"></label>
      </div>
      <div class="field">
        <span>Watch links</span>
        ${draft.links.map((link, index) => `
          <div class="link-row">
            <label class="field"><span>Location</span><input name="location" maxlength="80" placeholder="YouTube" value="${esc(link.location)}"></label>
            <label class="field"><span>URL</span><input name="url" maxlength="2000" placeholder="https://" value="${esc(link.url)}"></label>
            <button type="button" class="text-button" data-action="remove-link" data-index="${index}">Remove</button>
          </div>
        `).join('')}
        <button type="button" class="text-button" data-action="add-link">Add another link</button>
      </div>
      ${state.formError ? `<p class="alert" role="alert">${esc(state.formError)}</p>` : ''}
      <div class="button-row">
        <button class="primary" type="submit">Save</button>
        ${draft.mode === 'edit' ? '<button type="button" class="danger" data-action="ask-delete">Delete</button>' : ''}
      </div>
    </form>
  ` : '<p class="hint">Search TMDB, or enter a video that is not in the catalog. YouTube videos use Enter In Video and a YouTube link.</p>';
  app.innerHTML = `
    <main class="screen narrow">
      <header class="topbar">
        <button type="button" class="text-button" data-action="go" data-href="#/l/${encodeURIComponent(draft.token)}">Back</button>
        <h1>${draft.mode === 'edit' ? 'Edit video' : 'Add video'}</h1>
      </header>
      <div class="button-row">
        <button type="button" class="primary" data-action="open-search">Search TMDB</button>
        ${draft.visible ? '' : '<button type="button" class="text-button" data-action="enter-manual">Enter In Video</button>'}
      </div>
      ${fields}
    </main>
    ${renderModal()}
  `;
}

function renderModal() {
  if (!state.modal) return '';
  if (state.modal.type === 'confirm') {
    return sheet(`
      <h2>${esc(state.modal.title)}</h2>
      <p>${esc(state.modal.body)}</p>
      <div class="sheet-actions">
        <button type="button" class="text-button" data-action="close-modal">Cancel</button>
        <button type="button" class="primary" data-action="${esc(state.modal.confirmAction)}">${esc(state.modal.confirmLabel)}</button>
      </div>
    `);
  }
  if (state.modal.type === 'share') {
    return sheet(`
      <h2>Share this list</h2>
      <p class="hint">Anyone with this link can add videos, mark them watched, and vote.</p>
      <label class="field"><span>Private link</span><input id="share-link" readonly value="${esc(shareUrl(state.token))}"></label>
      <label class="field"><span>Your name on this phone</span><input id="display-name" maxlength="40" value="${esc(displayName())}" placeholder="Optional"></label>
      <div class="sheet-actions">
        <button type="button" class="primary" data-action="copy-share">Copy link</button>
        <button type="button" class="text-button" data-action="close-modal">Close</button>
      </div>
    `);
  }
  if (state.modal.type === 'search') {
    const results = state.searchResults.map((result) => `
      <button type="button" class="search-result" data-action="pick-tmdb" data-id="${esc(result.id)}" data-media="${esc(result.mediaType)}">
        ${result.posterUrl ? `<img alt="" src="${safeUrl(result.posterUrl)}">` : '<div class="search-fallback"></div>'}
        <span><strong>${esc(result.title)}</strong><br>${esc(result.year)} · ${esc(result.mediaType === 'tv' ? 'TV' : 'Movie')}</span>
      </button>
    `).join('');
    return sheet(`
      <h2>Search TMDB</h2>
      <form id="search-form" class="stack">
        <label class="field"><span>Title</span><input name="q" value="${esc(state.searchQuery)}" maxlength="120" autocomplete="off"></label>
        <button class="primary" type="submit">Search</button>
      </form>
      ${state.searchMessage ? `<p class="hint">${esc(state.searchMessage)}</p>` : ''}
      ${results}
      <p class="credit">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
      <button type="button" class="text-button" data-action="close-modal">Close</button>
    `);
  }
  if (state.modal.type === 'links') {
    const video = currentVideo(state.modal.videoId);
    if (!video) return '';
    const choices = video.links.map((link) => `
      <button type="button" class="choice" data-action="open-link" data-url="${safeUrl(link.url)}" data-count="many">${esc(link.location)}</button>
    `).join('');
    return sheet(`
      <h2>${esc(video.title)}</h2>
      <p class="hint">Choose where to watch.</p>
      ${choices}
      <div class="sheet-actions"><button type="button" class="text-button" data-action="close-modal">Close</button></div>
    `);
  }
  if (state.modal.type === 'details') {
    const video = currentVideo(state.modal.videoId);
    if (!video) return '';
    const mine = (state.detail.votes || []).some((vote) => vote.deviceId === deviceId() && vote.videoId === video.id);
    return sheet(`
      ${video.posterUrl ? `<img class="sheet-poster" alt="" src="${safeUrl(video.posterUrl)}">` : ''}
      <h2>${esc(video.title)}</h2>
      <p>${esc(video.plot || 'No description yet.')}</p>
      <p class="rating">${esc(video.parentalRating || 'No rating')}</p>
      <div class="sheet-actions">
        <button type="button" class="primary" data-action="go" data-href="#/l/${encodeURIComponent(state.token)}/v/${encodeURIComponent(video.id)}/edit">Edit</button>
        <button type="button" class="text-button" data-action="toggle-watched" data-id="${esc(video.id)}" data-watched="${video.watched ? '1' : '0'}">${video.watched ? 'Mark unwatched' : 'Mark watched'}</button>
        ${video.watched ? '' : `<button type="button" class="text-button" data-action="vote" data-id="${esc(video.id)}" aria-pressed="${mine}">${mine ? 'Your vote for next' : 'Vote to watch next'}</button>`}
        <button type="button" class="text-button" data-action="close-modal">Close</button>
      </div>
    `);
  }
  return '';
}

function sheet(content) {
  return `<div class="backdrop" data-action="close-modal"><div class="sheet" role="dialog" aria-modal="true" data-action="noop">${content}</div></div>`;
}

function renderMissing(message) {
  app.innerHTML = `
    <main class="screen narrow">
      <header class="topbar"><h1>Watchlists</h1></header>
      <p class="empty">${esc(message)}</p>
      <button type="button" class="primary" data-action="go" data-href="#/lists">Back to lists</button>
    </main>
  `;
}

function render() {
  const scroll = window.scrollY;
  if (state.loading) {
    app.innerHTML = '<p class="loading">Loading watchlists…</p>';
    return;
  }
  if (state.screen === 'lists') renderLists();
  else if (state.screen === 'list-form' && state.listDraft) renderListForm();
  else if (state.screen === 'watch' && state.detail) renderWatch();
  else if (state.screen === 'video-form' && state.draft) renderVideoForm();
  else renderMissing('That list is not available.');
  bindFallbacks();
  window.scrollTo(0, scroll);
}

function bindFallbacks() {
  app.querySelectorAll('img[data-fallback]').forEach((img) => {
    img.addEventListener('error', () => {
      const fallback = document.createElement('div');
      fallback.className = `${img.className} ${img.classList.contains('poster') || img.classList.contains('preview') ? 'poster-fallback' : 'cover-fallback'}`;
      fallback.setAttribute('aria-hidden', 'true');
      fallback.textContent = img.dataset.fallback || '?';
      img.replaceWith(fallback);
    });
  });
}

function clearTap() {
  if (pendingTap) clearTimeout(pendingTap.timer);
  pendingTap = null;
}

function setPoll(enabled) {
  clearInterval(pollTimer);
  pollTimer = null;
  if (enabled) pollTimer = setInterval(silentRefresh, 8000);
}

async function silentRefresh() {
  if (state.screen !== 'watch' || state.modal || document.visibilityState === 'hidden') return;
  try {
    const detail = await api(`/api/s/${encodeURIComponent(state.token)}`);
    const next = JSON.stringify(detail);
    if (next === state.detailJson) return;
    applyDetail(detail);
    render();
  } catch {
    return;
  }
}

async function route() {
  const gen = ++routeGen;
  clearTap();
  const next = parseHash();
  state.formError = '';
  state.loading = true;
  if (next.name !== 'watch') {
    state.modal = null;
    setPoll(false);
  }
  render();
  try {
    if (next.name === 'lists') {
      await loadLists();
      if (gen !== routeGen) return;
      state.screen = 'lists';
      state.token = '';
      state.draft = null;
      state.listDraft = null;
    } else if (next.name === 'list-form') {
      if (next.mode === 'edit') {
        const detail = await api(`/api/s/${encodeURIComponent(next.token)}`);
        if (gen !== routeGen) return;
        state.detail = detail;
        state.listDraft = {
          mode: 'edit',
          token: next.token,
          name: detail.list.name,
          coverUrl: detail.list.coverUrl,
          coverDataUrl: '',
        };
      } else if (!state.listDraft || state.listDraft.mode !== 'create') {
        state.listDraft = { mode: 'create', token: '', name: '', coverUrl: '', coverDataUrl: '' };
      }
      state.screen = 'list-form';
    } else if (next.name === 'watch' || next.name === 'video-form') {
      const joined = rememberToken(next.token);
      if (joined) track('list_joined', {}, next.token);
      if (state.token !== next.token) {
        state.filter = 'unwatched';
        state.sort = 'name';
      }
      state.token = next.token;
      applyDetail(await api(`/api/s/${encodeURIComponent(next.token)}`));
      if (gen !== routeGen) return;
      if (next.name === 'watch') {
        state.screen = 'watch';
        state.draft = null;
        track('list_opened', {}, next.token);
        setPoll(true);
      } else {
        const sameDraft = state.draft
          && state.draft.mode === next.mode
          && state.draft.token === next.token
          && state.draft.videoId === (next.videoId || '');
        if (!sameDraft) {
          if (next.mode === 'edit') {
            const video = currentVideo(next.videoId);
            if (!video) throw new Error('Video not found');
            state.draft = videoToDraft(video, next.token);
          } else {
            state.draft = emptyDraft(next.token);
          }
        }
        state.screen = 'video-form';
        setPoll(false);
      }
    }
    state.loading = false;
    render();
  } catch (error) {
    if (gen !== routeGen) return;
    state.loading = false;
    renderMissing(error.message);
  }
}

async function loadLists() {
  let tokens = knownTokens();
  if (!localStorage.getItem('samplesAdopted')) {
    const samples = await api('/api/samples');
    tokens = [...new Set([...(samples.tokens || []), ...tokens])];
    saveTokens(tokens);
    localStorage.setItem('samplesAdopted', '1');
  }
  const payload = tokens.length
    ? await api(`/api/collections?tokens=${encodeURIComponent(tokens.join(','))}`)
    : { lists: [] };
  state.lists = payload.lists;
  saveTokens(payload.lists.map((list) => list.shareToken));
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      resolve('');
      return;
    }
    if (!file.type.startsWith('image/')) {
      reject(new Error('Choose an image file'));
      return;
    }
    if (file.size > 2_000_000) {
      reject(new Error('Image must be under 2 MB'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read that image'));
    reader.readAsDataURL(file);
  });
}

function draftPayload() {
  return {
    title: state.draft.title,
    plot: state.draft.plot,
    parentalRating: state.draft.parentalRating,
    genre: state.draft.genre,
    posterUrl: state.draft.posterUrl,
    posterDataUrl: state.draft.posterDataUrl,
    tmdbId: state.draft.tmdbId,
    tmdbMediaType: state.draft.tmdbMediaType,
    source: state.draft.source,
    links: state.draft.links,
  };
}

async function saveList(event) {
  event.preventDefault();
  readListDraft();
  const button = event.target.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const body = { name: state.listDraft.name, coverDataUrl: state.listDraft.coverDataUrl };
    if (state.listDraft.mode === 'create') {
      const created = await api('/api/lists', { method: 'POST', body: JSON.stringify(body) });
      rememberToken(created.list.shareToken);
      track('list_created', {}, created.list.shareToken);
      location.hash = `#/l/${encodeURIComponent(created.list.shareToken)}`;
    } else {
      await api(`/api/s/${encodeURIComponent(state.listDraft.token)}`, { method: 'PATCH', body: JSON.stringify(body) });
      track('list_edited', {}, state.listDraft.token);
      location.hash = `#/l/${encodeURIComponent(state.listDraft.token)}`;
    }
  } catch (error) {
    button.disabled = false;
    state.formError = error.message;
    render();
  }
}

async function saveVideo(event) {
  event.preventDefault();
  readVideoDraft();
  const button = event.target.querySelector('[type="submit"]');
  button.disabled = true;
  const token = state.draft.token;
  try {
    if (state.draft.mode === 'add') {
      await api(`/api/s/${encodeURIComponent(token)}/videos`, {
        method: 'POST',
        body: JSON.stringify(draftPayload()),
      });
      track('video_added', { source: state.draft.source === 'tmdb' ? 'tmdb' : 'manual' }, token);
      state.filter = 'unwatched';
    } else {
      await api(`/api/s/${encodeURIComponent(token)}/videos/${encodeURIComponent(state.draft.videoId)}`, {
        method: 'PATCH',
        body: JSON.stringify(draftPayload()),
      });
      track('video_edited', {}, token);
    }
    state.draft = null;
    location.hash = `#/l/${encodeURIComponent(token)}`;
  } catch (error) {
    button.disabled = false;
    state.formError = error.message;
    render();
  }
}

async function runSearch(event) {
  event.preventDefault();
  const query = event.target.elements.q.value.trim();
  state.searchQuery = query;
  state.searchMessage = 'Searching…';
  state.searchResults = [];
  render();
  try {
    const payload = await api(`/api/tmdb/search?q=${encodeURIComponent(query)}`);
    state.searchResults = payload.results;
    state.searchMessage = payload.results.length ? '' : 'No movies or shows matched.';
    track('tmdb_search', { result_count: payload.results.length }, state.token);
  } catch (error) {
    state.searchMessage = error.message;
    track('tmdb_search', { result_count: 0 }, state.token);
  }
  render();
}

function runSingle(element) {
  if (element.dataset.tap === 'list') {
    location.hash = `#/l/${encodeURIComponent(element.dataset.token)}`;
    return;
  }
  const video = currentVideo(element.dataset.id);
  if (!video) return;
  state.modal = { type: 'details', videoId: video.id };
  track('details_opened', {}, state.token);
  render();
}

function runDouble(element) {
  if (element.dataset.tap === 'list') {
    location.hash = `#/l/${encodeURIComponent(element.dataset.token)}/edit`;
    return;
  }
  const video = currentVideo(element.dataset.id);
  if (!video) return;
  if (video.links.length === 1) {
    window.open(video.links[0].url, '_blank', 'noopener');
    track('watch_link_opened', { link_count: 'one' }, state.token);
    return;
  }
  if (video.links.length > 1) {
    state.modal = { type: 'links', videoId: video.id };
    render();
    return;
  }
  toast('Add a watch link before playing this');
}

async function handleAction(action, element) {
  if (action === 'noop') return;
  if (action === 'close-modal') {
    state.modal = null;
    state.searchMessage = '';
    render();
    return;
  }
  if (action === 'go') {
    if (state.draft) readVideoDraft();
    if (state.listDraft) readListDraft();
    location.hash = element.dataset.href;
    return;
  }
  if (action === 'filter') {
    state.filter = element.dataset.filter;
    track('watched_filter_changed', { filter: state.filter }, state.token);
    render();
    return;
  }
  if (action === 'open-share') {
    state.modal = { type: 'share' };
    render();
    return;
  }
  if (action === 'copy-share') {
    const link = document.getElementById('share-link').value;
    try {
      await navigator.clipboard.writeText(link);
      toast('Link copied');
      track('share_link_copied', {}, state.token);
    } catch {
      document.getElementById('share-link').focus();
      document.getElementById('share-link').select();
      toast('Select the link and copy it');
    }
    return;
  }
  if (action === 'ask-reset') {
    state.modal = {
      type: 'confirm',
      title: 'Reset watched?',
      body: 'Every video on this list will be marked unwatched.',
      confirmLabel: 'Reset',
      confirmAction: 'confirm-reset',
    };
    render();
    return;
  }
  if (action === 'confirm-reset') {
    applyDetail(await api(`/api/s/${encodeURIComponent(state.token)}/reset-watched`, { method: 'POST', body: '{}' }));
    state.modal = null;
    track('watched_flags_reset', {}, state.token);
    render();
    return;
  }
  if (action === 'toggle-watched') {
    const watched = element.dataset.watched !== '1';
    applyDetail(await api(`/api/s/${encodeURIComponent(state.token)}/videos/${encodeURIComponent(element.dataset.id)}/watched`, {
      method: 'POST',
      body: JSON.stringify({ watched }),
    }));
    track(watched ? 'video_marked_watched' : 'video_marked_unwatched', {}, state.token);
    render();
    return;
  }
  if (action === 'vote') {
    applyDetail(await api(`/api/s/${encodeURIComponent(state.token)}/votes`, {
      method: 'POST',
      body: JSON.stringify({
        videoId: element.dataset.id,
        deviceId: deviceId(),
        displayName: displayName(),
      }),
    }));
    track('vote_cast', {}, state.token);
    render();
    return;
  }
  if (action === 'open-link') {
    const url = element.dataset.url;
    if (!url) return;
    window.open(url, '_blank', 'noopener');
    track('watch_link_opened', { link_count: element.dataset.count === 'many' ? 'many' : 'one' }, state.token);
    state.modal = null;
    render();
    return;
  }
  if (action === 'open-search') {
    if (state.draft) readVideoDraft();
    state.modal = { type: 'search' };
    state.searchResults = [];
    state.searchMessage = '';
    render();
    return;
  }
  if (action === 'enter-manual') {
    state.draft.visible = true;
    state.draft.source = 'manual';
    render();
    return;
  }
  if (action === 'add-link') {
    readVideoDraft();
    state.draft.links.push({ location: '', url: '' });
    render();
    return;
  }
  if (action === 'remove-link') {
    readVideoDraft();
    state.draft.links.splice(Number(element.dataset.index), 1);
    if (!state.draft.links.length) state.draft.links.push({ location: '', url: '' });
    render();
    return;
  }
  if (action === 'ask-delete') {
    readVideoDraft();
    state.modal = {
      type: 'confirm',
      title: 'Delete this video?',
      body: 'It will be removed from the list.',
      confirmLabel: 'Delete',
      confirmAction: 'confirm-delete',
    };
    render();
    return;
  }
  if (action === 'confirm-delete') {
    const token = state.draft.token;
    const videoId = state.draft.videoId;
    await api(`/api/s/${encodeURIComponent(token)}/videos/${encodeURIComponent(videoId)}`, { method: 'DELETE' });
    track('video_deleted', {}, token);
    state.draft = null;
    state.modal = null;
    location.hash = `#/l/${encodeURIComponent(token)}`;
    return;
  }
  if (action === 'pick-tmdb') {
    state.searchMessage = 'Adding details…';
    render();
    try {
      const detail = await api(`/api/tmdb/${element.dataset.media}/${element.dataset.id}`);
      state.draft.visible = true;
      state.draft.source = 'tmdb';
      state.draft.title = detail.title;
      state.draft.plot = detail.plot;
      state.draft.parentalRating = detail.parentalRating;
      state.draft.genre = detail.genre;
      state.draft.posterUrl = detail.posterUrl;
      state.draft.posterDataUrl = '';
      state.draft.tmdbId = detail.tmdbId;
      state.draft.tmdbMediaType = detail.mediaType;
      state.modal = null;
      state.formError = '';
    } catch (error) {
      state.searchMessage = error.message;
    }
    render();
  }
}

app.addEventListener('click', (event) => {
  const actionElement = event.target.closest('[data-action]');
  if (actionElement && app.contains(actionElement)) {
    clearTap();
    if (actionElement.dataset.action !== 'noop') event.preventDefault();
    handleAction(actionElement.dataset.action, actionElement).catch((error) => toast(error.message));
    return;
  }
  const tapElement = event.target.closest('[data-tap]');
  if (!tapElement || !app.contains(tapElement)) return;
  if (pendingTap && pendingTap.element === tapElement) {
    clearTimeout(pendingTap.timer);
    pendingTap = null;
    runDouble(tapElement);
    return;
  }
  if (pendingTap) clearTimeout(pendingTap.timer);
  pendingTap = {
    element: tapElement,
    timer: setTimeout(() => {
      pendingTap = null;
      runSingle(tapElement);
    }, TAP_MS),
  };
});

app.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.modal) {
    state.modal = null;
    render();
    return;
  }
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const tapElement = event.target.closest('[data-tap]');
  if (!tapElement) return;
  event.preventDefault();
  clearTap();
  runSingle(tapElement);
});

app.addEventListener('submit', (event) => {
  if (event.target.id === 'list-form') saveList(event).catch((error) => toast(error.message));
  if (event.target.id === 'video-form') saveVideo(event).catch((error) => toast(error.message));
  if (event.target.id === 'search-form') runSearch(event).catch((error) => toast(error.message));
});

app.addEventListener('change', (event) => {
  if (event.target.id === 'sort') {
    state.sort = event.target.value;
    track('sort_changed', { sort: state.sort }, state.token);
    render();
    return;
  }
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const target = event.target.id;
  readFile(file).then((dataUrl) => {
    if (target === 'cover-file' && state.listDraft) {
      readListDraft();
      state.listDraft.coverDataUrl = dataUrl;
      render();
    }
    if (target === 'poster-file' && state.draft) {
      readVideoDraft();
      state.draft.posterDataUrl = dataUrl;
      render();
    }
  }).catch((error) => toast(error.message));
});

app.addEventListener('input', (event) => {
  if (event.target.id === 'display-name') {
    localStorage.setItem('displayName', event.target.value.slice(0, 40));
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') silentRefresh();
});

window.addEventListener('hashchange', () => {
  route();
});

if (!booted) {
  booted = true;
  track('app_opened', { has_list: knownTokens().length > 0 });
  route();
}
