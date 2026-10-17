const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const db = require('./db');

loadEnv(path.join(__dirname, '..', '.env'));

const root = path.join(__dirname, '..');
const port = Number(process.env.PORT) || 4173;
const tmdbKey = process.env.TMDB_API_KEY || '';

const eventNames = new Set([
  'app_opened',
  'list_created',
  'list_opened',
  'list_edited',
  'share_link_copied',
  'list_joined',
  'tmdb_search',
  'video_added',
  'video_edited',
  'video_deleted',
  'details_opened',
  'video_marked_watched',
  'video_marked_unwatched',
  'watched_filter_changed',
  'sort_changed',
  'watched_flags_reset',
  'watch_link_opened',
  'vote_cast',
]);

const propertyAllow = {
  app_opened: ['has_list'],
  tmdb_search: ['result_count'],
  video_added: ['source'],
  watched_filter_changed: ['filter'],
  sort_changed: ['sort'],
  watch_link_opened: ['link_count'],
};

const staticFiles = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/styleguide', 'styleguide.html'],
  ['/styleguide.html', 'styleguide.html'],
  ['/css/app.css', 'css/app.css'],
  ['/css/editorial-theme.css', 'css/editorial-theme.css'],
  ['/css/styleguide.css', 'css/styleguide.css'],
  ['/js/app.js', 'js/app.js'],
  ['/planning/design%20guidelines.json', 'planning/design guidelines.json'],
]);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function bad(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function clean(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 6_000_000) {
        reject(bad('Upload is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(bad('Request body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}

function tokenFrom(value) {
  const token = String(value || '');
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(token)) throw bad('That list link is not valid');
  return token;
}

function saveImage(dataUrl) {
  const match = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl || '');
  if (!match) return null;
  const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 2_000_000) throw bad('Image must be under 2 MB');
  const filename = `${crypto.randomBytes(12).toString('base64url')}.${ext}`;
  fs.writeFileSync(path.join(db.uploadDir, filename), buffer);
  return `/uploads/${filename}`;
}

function posterFrom(input) {
  if (input.posterDataUrl) {
    const saved = saveImage(input.posterDataUrl);
    if (!saved) throw bad('Poster must be a PNG, JPEG, WEBP, or GIF');
    return { path: saved, replace: true };
  }
  if (input.posterUrl) return { path: input.posterUrl, replace: true };
  return { path: '', replace: false };
}

function normalizeVideo(body) {
  const title = clean(body.title, 200);
  if (!title) throw bad('Enter a title');
  const links = [];
  for (const link of (Array.isArray(body.links) ? body.links : []).slice(0, 8)) {
    const location = clean(link.location, 80);
    const url = clean(link.url, 2000);
    if (!location && !url) continue;
    if (!location || !url) throw bad('Each watch link needs a location and a URL');
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw bad('Watch links must be http or https URLs');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw bad('Watch links must be http or https URLs');
    }
    links.push({ location, url });
  }
  const posterUrl = typeof body.posterUrl === 'string' && /^https?:\/\//.test(body.posterUrl) ? body.posterUrl : '';
  const localPoster = typeof body.posterUrl === 'string' && body.posterUrl.startsWith('/uploads/') ? body.posterUrl : '';
  return {
    title,
    plot: clean(body.plot, 4000),
    parentalRating: clean(body.parentalRating, 40),
    genre: clean(body.genre, 120),
    posterUrl: posterUrl || localPoster,
    posterDataUrl: typeof body.posterDataUrl === 'string' ? body.posterDataUrl : '',
    tmdbId: Number.isInteger(body.tmdbId) ? body.tmdbId : null,
    tmdbMediaType: body.tmdbMediaType === 'tv' || body.tmdbMediaType === 'movie' ? body.tmdbMediaType : null,
    source: body.source === 'tmdb' ? 'tmdb' : 'manual',
    links,
  };
}

function normalizeName(body) {
  const name = clean(body.name, 80);
  if (!name) throw bad('Enter a list name');
  return name;
}

function deviceIdFrom(value) {
  const deviceId = String(value || '');
  if (!/^[A-Za-z0-9-]{8,80}$/.test(deviceId)) throw bad('This phone could not be identified');
  return deviceId;
}

async function tmdb(pathname) {
  if (!tmdbKey) {
    const error = new Error('Add TMDB_API_KEY to the server .env file to search');
    error.status = 503;
    throw error;
  }
  const url = new URL(`https://api.themoviedb.org/3${pathname}`);
  url.searchParams.set('api_key', tmdbKey);
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch {
    throw bad('Movie search is unavailable');
  }
  if (!response.ok) throw bad('Movie search is unavailable');
  return response.json();
}

function certification(payload, kind) {
  const results = payload.results || [];
  const preferred = results.find((entry) => entry.iso_3166_1 === 'US') || results[0];
  if (!preferred) return '';
  if (kind === 'movie') {
    const dated = preferred.release_dates || [];
    return (dated.find((entry) => entry.certification) || {}).certification || '';
  }
  return preferred.rating || '';
}

function serveStatic(res, filePath) {
  if (!fs.existsSync(filePath)) {
    send(res, 404, { error: 'Not found' });
    return;
  }
  const data = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': types[path.extname(filePath)] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
  });
  res.end(data);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (req.method === 'GET' && staticFiles.has(pathname)) {
    serveStatic(res, path.join(root, staticFiles.get(pathname)));
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/uploads/')) {
    const filename = path.basename(pathname);
    serveStatic(res, path.join(db.uploadDir, filename));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/samples') {
    send(res, 200, { tokens: db.sampleTokens() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/collections') {
    const tokens = (url.searchParams.get('tokens') || '').split(',').map((token) => token.trim()).filter(Boolean);
    send(res, 200, { lists: db.summaries(tokens) });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/lists') {
    const body = await readBody(req);
    const name = normalizeName(body);
    const coverPath = body.coverDataUrl ? saveImage(body.coverDataUrl) : '';
    if (body.coverDataUrl && !coverPath) throw bad('Cover art must be a PNG, JPEG, WEBP, or GIF');
    send(res, 201, db.createList({ name, coverPath }));
    return;
  }

  const share = pathname.match(/^\/api\/s\/([^/]+)(.*)$/);
  if (share) {
    const token = tokenFrom(decodeURIComponent(share[1]));
    const rest = share[2] || '';
    if (req.method === 'GET' && rest === '') {
      const list = db.getByToken(token);
      if (!list) {
        send(res, 404, { error: 'List not found' });
        return;
      }
      send(res, 200, list);
      return;
    }
    if (req.method === 'PATCH' && rest === '') {
      const body = await readBody(req);
      const name = normalizeName(body);
      let coverPath = '';
      let replaceCover = false;
      if (body.coverDataUrl) {
        coverPath = saveImage(body.coverDataUrl) || '';
        if (!coverPath) throw bad('Cover art must be a PNG, JPEG, WEBP, or GIF');
        replaceCover = true;
      }
      send(res, 200, db.updateList(token, { name, coverPath, replaceCover }));
      return;
    }
    if (req.method === 'POST' && rest === '/videos') {
      const input = normalizeVideo(await readBody(req));
      const poster = posterFrom(input);
      send(res, 201, db.addVideo(token, input, poster.path));
      return;
    }
    if (req.method === 'POST' && rest === '/reset-watched') {
      send(res, 200, db.resetWatched(token));
      return;
    }
    if (req.method === 'POST' && rest === '/votes') {
      const body = await readBody(req);
      send(res, 200, db.castVote(token, {
        videoId: clean(body.videoId, 40),
        deviceId: deviceIdFrom(body.deviceId),
        displayName: clean(body.displayName, 40),
      }));
      return;
    }
    const videoRoute = rest.match(/^\/videos\/([^/]+)$/);
    if (videoRoute) {
      const videoId = decodeURIComponent(videoRoute[1]);
      if (req.method === 'PATCH') {
        const input = normalizeVideo(await readBody(req));
        const poster = posterFrom(input);
        send(res, 200, db.updateVideo(token, videoId, input, poster.path, poster.replace));
        return;
      }
      if (req.method === 'DELETE') {
        send(res, 200, db.deleteVideo(token, videoId));
        return;
      }
    }
    const watchedRoute = rest.match(/^\/videos\/([^/]+)\/watched$/);
    if (watchedRoute && req.method === 'POST') {
      const body = await readBody(req);
      send(res, 200, db.setWatched(token, decodeURIComponent(watchedRoute[1]), Boolean(body.watched)));
      return;
    }
  }

  if (req.method === 'GET' && pathname === '/api/tmdb/search') {
    const query = clean(url.searchParams.get('q'), 120);
    if (query.length < 2) throw bad('Enter at least 2 characters');
    const payload = await tmdb(`/search/multi?query=${encodeURIComponent(query)}&include_adult=false`);
    const results = (payload.results || [])
      .filter((item) => item.media_type === 'movie' || item.media_type === 'tv')
      .slice(0, 12)
      .map((item) => ({
        id: item.id,
        mediaType: item.media_type,
        title: item.title || item.name || '',
        year: String(item.release_date || item.first_air_date || '').slice(0, 4),
        overview: item.overview || '',
        posterUrl: item.poster_path ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : '',
      }));
    send(res, 200, { results });
    return;
  }

  const detailRoute = pathname.match(/^\/api\/tmdb\/(movie|tv)\/(\d+)$/);
  if (req.method === 'GET' && detailRoute) {
    const mediaType = detailRoute[1];
    const id = detailRoute[2];
    const [detail, ratingPayload] = await Promise.all([
      tmdb(`/${mediaType}/${id}`),
      tmdb(mediaType === 'movie' ? `/movie/${id}/release_dates` : `/tv/${id}/content_ratings`),
    ]);
    send(res, 200, {
      tmdbId: detail.id,
      mediaType,
      title: detail.title || detail.name || '',
      plot: detail.overview || '',
      genre: (detail.genres || []).map((genre) => genre.name).join(', '),
      parentalRating: certification(ratingPayload, mediaType),
      posterUrl: detail.poster_path ? `https://image.tmdb.org/t/p/w500${detail.poster_path}` : '',
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/events') {
    const body = await readBody(req);
    if (!eventNames.has(body.name)) {
      send(res, 204, {});
      return;
    }
    const allowed = propertyAllow[body.name] || [];
    const properties = {};
    for (const key of allowed) {
      if (body.properties && Object.prototype.hasOwnProperty.call(body.properties, key)) {
        properties[key] = body.properties[key];
      }
    }
    db.recordEvent({
      name: body.name,
      deviceId: clean(body.deviceId, 80),
      listToken: body.listToken ? clean(body.listToken, 80) : '',
      properties,
    });
    send(res, 204, {});
    return;
  }

  send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (res.headersSent) return;
    const status = error.status || 500;
    if (status === 500) console.error(error);
    send(res, status, { error: status === 500 ? 'Something went wrong' : error.message });
  });
});

server.listen(port, () => {
  console.log(`Watchlists running at http://localhost:${port}`);
});
