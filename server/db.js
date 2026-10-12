const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'data');
const uploadDir = path.join(root, 'uploads');

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'watchlist.db'));
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY,
    share_token TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    cover_path TEXT,
    is_sample INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    plot TEXT,
    parental_rating TEXT,
    genre TEXT,
    poster_path TEXT,
    watched INTEGER NOT NULL DEFAULT 0,
    tmdb_id INTEGER,
    tmdb_media_type TEXT,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS watch_links (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    location_label TEXT NOT NULL,
    url TEXT NOT NULL,
    sort_order INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS votes (
    list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    display_name TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (list_id, device_id)
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    device_id TEXT,
    list_id TEXT,
    properties TEXT,
    created_at TEXT NOT NULL
  );
`);

function newId() {
  return crypto.randomBytes(12).toString('base64url');
}

function now() {
  return new Date().toISOString();
}

function unlinkUpload(urlPath) {
  if (!urlPath || !urlPath.startsWith('/uploads/')) return;
  const full = path.join(uploadDir, path.basename(urlPath));
  if (full.startsWith(uploadDir) && fs.existsSync(full)) fs.unlinkSync(full);
}

function mustList(token) {
  const list = db.prepare('SELECT * FROM lists WHERE share_token = ?').get(token);
  if (!list) {
    const error = new Error('List not found');
    error.status = 404;
    throw error;
  }
  return list;
}

function insertLinks(videoId, links) {
  const statement = db.prepare(
    'INSERT INTO watch_links (id, video_id, location_label, url, sort_order) VALUES (?, ?, ?, ?, ?)'
  );
  links.forEach((link, index) => {
    statement.run(newId(), videoId, link.location, link.url, index);
  });
}

function writeSvg(filename, { title, subtitle, bg, wide }) {
  const width = wide ? 800 : 400;
  const height = wide ? 480 : 600;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="${bg}"/>
  <text x="50%" y="47%" fill="#f6f1e7" font-size="${wide ? 54 : 40}" font-family="Georgia, serif" text-anchor="middle">${title}</text>
  <text x="50%" y="60%" fill="#f6f1e7" font-size="20" font-family="Georgia, serif" text-anchor="middle" opacity="0.75">${subtitle}</text>
</svg>`;
  fs.writeFileSync(path.join(uploadDir, filename), svg);
  return `/uploads/${filename}`;
}

function seed() {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM lists').get().n;
  if (existing > 0) return;

  const fridayCover = writeSvg('sample-friday-cover.svg', {
    title: 'Friday',
    subtitle: 'Movies and shows',
    bg: '#6e3b2e',
    wide: true,
  });
  const queueCover = writeSvg('sample-queue-cover.svg', {
    title: 'Queue',
    subtitle: 'Short videos',
    bg: '#2f4a45',
    wide: true,
  });
  const budapestPoster = writeSvg('sample-budapest.svg', {
    title: 'Budapest',
    subtitle: 'Movie',
    bg: '#8a4b3a',
  });
  const spiritedPoster = writeSvg('sample-spirited.svg', {
    title: 'Spirited',
    subtitle: 'Movie',
    bg: '#3d5c4a',
  });
  const earthPoster = writeSvg('sample-earth.svg', {
    title: 'Earth',
    subtitle: 'Series',
    bg: '#2d4d6e',
  });
  const pastaPoster = writeSvg('sample-pasta.svg', {
    title: 'Pasta',
    subtitle: 'YouTube',
    bg: '#8a6232',
  });

  const created = now();
  const fridayId = newId();
  const queueId = newId();
  const insertList = db.prepare(
    'INSERT INTO lists (id, share_token, name, cover_path, is_sample, created_at) VALUES (?, ?, ?, ?, 1, ?)'
  );
  insertList.run(fridayId, newId(), 'Friday night', fridayCover, created);
  insertList.run(queueId, newId(), 'Learn something', queueCover, created);

  const insertVideo = db.prepare(`
    INSERT INTO videos (
      id, list_id, title, plot, parental_rating, genre, poster_path, watched,
      tmdb_id, tmdb_media_type, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'manual', ?)
  `);

  const budapestId = newId();
  const spiritedId = newId();
  const earthId = newId();
  const pastaId = newId();

  insertVideo.run(
    budapestId,
    fridayId,
    'The Grand Budapest Hotel',
    'A hotel concierge is framed for murder, and his lobby boy helps him chase a fortune across Europe.',
    'PG-13',
    'Comedy',
    budapestPoster,
    0,
    created
  );
  insertVideo.run(
    spiritedId,
    fridayId,
    'Spirited Away',
    'A girl trapped in a spirit bathhouse has to work there until she can get her parents back.',
    'PG',
    'Animation',
    spiritedPoster,
    0,
    created
  );
  insertVideo.run(
    earthId,
    fridayId,
    'Planet Earth',
    'Nature footage of places most people will never stand in person.',
    'TV-G',
    'Documentary',
    earthPoster,
    1,
    created
  );
  insertVideo.run(
    pastaId,
    queueId,
    'Pasta dough, start to finish',
    'A short lesson on mixing, kneading, and resting dough for noodles.',
    'NR',
    'Cooking',
    pastaPoster,
    0,
    created
  );

  insertLinks(budapestId, [{ location: 'TMDB', url: 'https://www.themoviedb.org/movie/120467' }]);
  insertLinks(spiritedId, [{ location: 'YouTube', url: 'https://www.youtube.com/results?search_query=spirited+away+trailer' }]);
  insertLinks(earthId, [
    { location: 'TMDB', url: 'https://www.themoviedb.org/tv/1063' },
    { location: 'YouTube', url: 'https://www.youtube.com/results?search_query=planet+earth+trailer' },
  ]);
  insertLinks(pastaId, [{ location: 'YouTube', url: 'https://www.youtube.com/results?search_query=homemade+pasta+dough' }]);
}

seed();

function publicVideo(row, links) {
  return {
    id: row.id,
    title: row.title,
    plot: row.plot || '',
    parentalRating: row.parental_rating || '',
    genre: row.genre || '',
    posterUrl: row.poster_path || '',
    watched: row.watched === 1,
    tmdbId: row.tmdb_id,
    tmdbMediaType: row.tmdb_media_type,
    source: row.source,
    links: links.map((link) => ({
      id: link.id,
      location: link.location_label,
      url: link.url,
    })),
  };
}

function getByToken(token) {
  const list = db.prepare('SELECT * FROM lists WHERE share_token = ?').get(token);
  if (!list) return null;
  const videos = db.prepare('SELECT * FROM videos WHERE list_id = ?').all(list.id);
  const linkRows = db.prepare(`
    SELECT watch_links.*
    FROM watch_links
    JOIN videos ON videos.id = watch_links.video_id
    WHERE videos.list_id = ?
    ORDER BY watch_links.sort_order
  `).all(list.id);
  const votes = db.prepare('SELECT * FROM votes WHERE list_id = ?').all(list.id);
  const linksByVideo = new Map();
  for (const link of linkRows) {
    const group = linksByVideo.get(link.video_id) || [];
    group.push(link);
    linksByVideo.set(link.video_id, group);
  }
  const videoJson = videos.map((video) => publicVideo(video, linksByVideo.get(video.id) || []));
  const unwatched = new Set(videoJson.filter((video) => !video.watched).map((video) => video.id));
  const titles = new Map(videoJson.map((video) => [video.id, video.title]));
  const tally = new Map();
  for (const vote of votes) {
    if (!unwatched.has(vote.video_id)) continue;
    const entry = tally.get(vote.video_id) || {
      videoId: vote.video_id,
      title: titles.get(vote.video_id),
      count: 0,
      names: [],
      updatedAt: vote.updated_at,
    };
    entry.count += 1;
    if (vote.display_name) entry.names.push(vote.display_name);
    if (vote.updated_at > entry.updatedAt) entry.updatedAt = vote.updated_at;
    tally.set(vote.video_id, entry);
  }
  const leader = [...tally.values()].sort((a, b) => b.count - a.count || b.updatedAt.localeCompare(a.updatedAt))[0] || null;
  if (leader) delete leader.updatedAt;
  return {
    list: {
      name: list.name,
      shareToken: list.share_token,
      coverUrl: list.cover_path || '',
      createdAt: list.created_at,
    },
    videos: videoJson,
    votes: votes.map((vote) => ({
      videoId: vote.video_id,
      deviceId: vote.device_id,
      displayName: vote.display_name || '',
    })),
    leader,
  };
}

function summaries(tokens) {
  const unique = [...new Set(tokens)].slice(0, 50);
  if (!unique.length) return [];
  const placeholders = unique.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM lists WHERE share_token IN (${placeholders})`).all(...unique);
  const byToken = new Map(rows.map((row) => [row.share_token, row]));
  return unique.filter((token) => byToken.has(token)).map((token) => {
    const list = byToken.get(token);
    const counts = db.prepare(
      'SELECT COUNT(*) AS total, SUM(CASE WHEN watched = 0 THEN 1 ELSE 0 END) AS unwatched FROM videos WHERE list_id = ?'
    ).get(list.id);
    return {
      shareToken: list.share_token,
      name: list.name,
      coverUrl: list.cover_path || '',
      videoCount: counts.total,
      unwatchedCount: counts.unwatched || 0,
    };
  });
}

function sampleTokens() {
  return db.prepare('SELECT share_token FROM lists WHERE is_sample = 1 ORDER BY created_at').all().map((row) => row.share_token);
}

function createList({ name, coverPath, isSample = false }) {
  const shareToken = newId();
  db.prepare(
    'INSERT INTO lists (id, share_token, name, cover_path, is_sample, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(newId(), shareToken, name, coverPath || null, isSample ? 1 : 0, now());
  return getByToken(shareToken);
}

function updateList(token, { name, coverPath, replaceCover }) {
  const list = mustList(token);
  const nextCover = replaceCover ? coverPath || null : list.cover_path;
  if (replaceCover && list.cover_path && list.cover_path !== nextCover) unlinkUpload(list.cover_path);
  db.prepare('UPDATE lists SET name = ?, cover_path = ? WHERE id = ?').run(name, nextCover, list.id);
  return getByToken(token);
}

function addVideo(token, input, posterPath) {
  const list = mustList(token);
  const videoId = newId();
  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT INTO videos (
        id, list_id, title, plot, parental_rating, genre, poster_path, watched,
        tmdb_id, tmdb_media_type, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(
      videoId,
      list.id,
      input.title,
      input.plot,
      input.parentalRating,
      input.genre,
      posterPath || null,
      input.tmdbId,
      input.tmdbMediaType,
      input.source,
      now()
    );
    insertLinks(videoId, input.links);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getByToken(token);
}

function updateVideo(token, videoId, input, posterPath, replacePoster) {
  const list = mustList(token);
  const existing = db.prepare('SELECT * FROM videos WHERE id = ? AND list_id = ?').get(videoId, list.id);
  if (!existing) {
    const error = new Error('Video not found');
    error.status = 404;
    throw error;
  }
  const nextPoster = replacePoster ? posterPath || null : existing.poster_path;
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE videos
      SET title = ?, plot = ?, parental_rating = ?, genre = ?, poster_path = ?,
          tmdb_id = ?, tmdb_media_type = ?, source = ?
      WHERE id = ?
    `).run(
      input.title,
      input.plot,
      input.parentalRating,
      input.genre,
      nextPoster,
      input.tmdbId,
      input.tmdbMediaType,
      input.source,
      videoId
    );
    db.prepare('DELETE FROM watch_links WHERE video_id = ?').run(videoId);
    insertLinks(videoId, input.links);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  if (replacePoster && existing.poster_path && existing.poster_path !== nextPoster) unlinkUpload(existing.poster_path);
  return getByToken(token);
}

function deleteVideo(token, videoId) {
  const list = mustList(token);
  const existing = db.prepare('SELECT * FROM videos WHERE id = ? AND list_id = ?').get(videoId, list.id);
  if (!existing) {
    const error = new Error('Video not found');
    error.status = 404;
    throw error;
  }
  db.prepare('DELETE FROM videos WHERE id = ?').run(videoId);
  unlinkUpload(existing.poster_path);
  return getByToken(token);
}

function setWatched(token, videoId, watched) {
  const list = mustList(token);
  const existing = db.prepare('SELECT * FROM videos WHERE id = ? AND list_id = ?').get(videoId, list.id);
  if (!existing) {
    const error = new Error('Video not found');
    error.status = 404;
    throw error;
  }
  db.prepare('UPDATE videos SET watched = ? WHERE id = ?').run(watched ? 1 : 0, videoId);
  if (watched) db.prepare('DELETE FROM votes WHERE video_id = ?').run(videoId);
  return getByToken(token);
}

function resetWatched(token) {
  const list = mustList(token);
  db.prepare('UPDATE videos SET watched = 0 WHERE list_id = ?').run(list.id);
  return getByToken(token);
}

function castVote(token, { videoId, deviceId, displayName }) {
  const list = mustList(token);
  const video = db.prepare('SELECT * FROM videos WHERE id = ? AND list_id = ?').get(videoId, list.id);
  if (!video) {
    const error = new Error('Video not found');
    error.status = 404;
    throw error;
  }
  if (video.watched) {
    const error = new Error('Vote for a video that is still unwatched');
    error.status = 400;
    throw error;
  }
  db.prepare(`
    INSERT INTO votes (list_id, device_id, video_id, display_name, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(list_id, device_id) DO UPDATE SET
      video_id = excluded.video_id,
      display_name = excluded.display_name,
      updated_at = excluded.updated_at
  `).run(list.id, deviceId, videoId, displayName || null, now());
  return getByToken(token);
}

function recordEvent({ name, deviceId, listToken, properties }) {
  let listId = null;
  if (listToken) {
    const list = db.prepare('SELECT id FROM lists WHERE share_token = ?').get(listToken);
    if (list) listId = list.id;
  }
  db.prepare(
    'INSERT INTO events (name, device_id, list_id, properties, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(name, deviceId || null, listId, JSON.stringify(properties || {}), now());
}

module.exports = {
  uploadDir,
  summaries,
  sampleTokens,
  createList,
  updateList,
  getByToken,
  addVideo,
  updateVideo,
  deleteVideo,
  setWatched,
  resetWatched,
  castVote,
  recordEvent,
};
