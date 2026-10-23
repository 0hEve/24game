import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import postgres from 'postgres';
import { combineNodes, equalsTarget, findHint, formatValue, generatePuzzle, leaf, maxTarget, solutionSteps, validatePuzzle } from '../src/engine.js';
import { minimumRatedCards, actionPenalty, challengeParameters, completionAdjustment, puzzleFingerprint } from './rating.js';

config({ path: '.env.local', quiet: true });
const COOKIE = 'club24_session';
const YEAR = 365 * 24 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(['register', 'start', 'move', 'undo', 'hint', 'solution', 'restart', 'abandon']);
const RESERVED = new Set(['admin', 'administrator', 'moderator', 'support', 'system', 'club24', '24club', 'leaderboard', 'anonymous', 'null', 'undefined']);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const slots = nodes => nodes.map((node, index) => ({ ...node, slot: index, key: index + 1 }));
const initialBoard = cards => slots(cards.map(leaf));
const solutionView = tree => ({ expr: tree.expr, expression: tree.expr, steps: solutionSteps(tree), tree });

export function publicRun(run) {
  if (!run) return null;
  const result = {
    id: run.id, cards: run.cards, target: run.target, settings: run.settings,
    startedAt: new Date(run.started_at).toISOString(), finishedAt: run.finished_at ? new Date(run.finished_at).toISOString() : null,
    board: run.board, moves: run.moves, canUndo: run.snapshots.length > 0, snapshotCount: run.snapshots.length,
    undoCount: run.undo_count, hintCount: run.hint_count, restartCount: run.restart_count,
    revision: run.revision, penaltyPaid: run.penalty_paid,
    difficulty: run.difficulty, parSeconds: Number(run.par_seconds), ratingVersion: run.rating_version,
    ranked: run.ranked, status: run.status, revealed: run.revealed,
    delta: run.delta, ratingBefore: run.rating_before, ratingAfter: run.rating_after,
  };
  if (run.revealed) result.solution = solutionView(run.witness);
  else if (run.status === 'completed') result.solution = solutionView(run.board[0]);
  return result;
}

function tokenFrom(req) {
  const raw = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return raw && /^[a-f0-9]{64}$/.test(raw) ? raw : null;
}
function cookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${YEAR}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}
function checkOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'ORIGIN', 'Cross-site requests are not allowed.');
  const origin = req.headers.origin;
  if (origin) {
    let parsed;
    try { parsed = new URL(origin); } catch { fail(403, 'ORIGIN', 'Invalid request origin.'); }
    const protocol = process.env.NODE_ENV === 'production' ? 'https:' : (req.socket?.encrypted ? 'https:' : 'http:');
    if (parsed.host !== req.headers.host || parsed.protocol !== protocol) fail(403, 'ORIGIN', 'Cross-site requests are not allowed.');
  }
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) fail(415, 'CONTENT_TYPE', 'Send application/json.');
}
async function body(req) {
  if (req.body !== undefined) {
    const serialized = typeof req.body === 'string' || Buffer.isBuffer(req.body) ? String(req.body) : JSON.stringify(req.body);
    if (Buffer.byteLength(serialized) > 65536) fail(413, 'BODY_SIZE', 'Request body is too large.');
    try { return JSON.parse(serialized); } catch { fail(400, 'JSON', 'Invalid JSON.'); }
  }
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 65536) fail(413, 'BODY_SIZE', 'Request body is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString()); } catch { fail(400, 'JSON', 'Invalid JSON.'); }
}
function settingsFrom(input = {}) {
  const count = input.count ?? 4, limit = input.maxTarget ?? maxTarget(count);
  if (!Number.isInteger(count) || count < 2 || count > 9) fail(400, 'SETTINGS', 'Choose between 2 and 9 cards.');
  if (!Number.isInteger(limit) || limit < 1 || limit > maxTarget(count)) fail(400, 'SETTINGS', 'The target limit is outside the permitted range.');
  if (input.hard !== undefined && typeof input.hard !== 'boolean') fail(400, 'SETTINGS', 'Hard mode must be true or false.');
  for (const key of ['keepCards', 'keepTarget']) if (input[key] !== undefined && typeof input[key] !== 'boolean') fail(400, 'SETTINGS', 'Keep settings must be true or false.');
  return { count, maxTarget: limit, hard: Boolean(input.hard), keepCards: Boolean(input.keepCards), keepTarget: Boolean(input.keepTarget) };
}
async function identity(sql, token, now) {
  if (!token) return null;
  const rows = await sql`SELECT player_id FROM club24.sessions WHERE token_hash = ${hash(token)} AND expires_at > ${now}`;
  return rows[0]?.player_id || null;
}
async function leaderboard(sql) {
  const rows = await sql`SELECT id, name, rating, games, peak_rating FROM club24.players ORDER BY rating DESC, created_at, id LIMIT 100`;
  return rows.map((row, i) => ({ id: row.id, name: row.name, rating: row.rating, games: row.games, peakRating: row.peak_rating, rank: i + 1 }));
}
async function envelope(sql, playerId) {
  let player = null, activeRun = null;
  if (playerId) {
    const [row] = await sql`SELECT p.*, (SELECT count(*) + 1 FROM club24.players q WHERE q.rating > p.rating OR (q.rating = p.rating AND (q.created_at, q.id) < (p.created_at, p.id))) AS rank FROM club24.players p WHERE p.id = ${playerId}`;
    if (row) {
      player = { id: row.id, name: row.name, rating: row.rating, games: row.games, peakRating: row.peak_rating, fastStreak: row.fast_streak, rank: Number(row.rank) };
      const [active] = await sql`SELECT * FROM club24.runs WHERE player_id = ${playerId} AND status = 'active'`;
      activeRun = publicRun(active);
    }
  }
  return { player, activeRun, leaderboard: await leaderboard(sql) };
}
async function saveRun(sql, run) {
  await sql`UPDATE club24.runs SET board = ${sql.json(run.board)}, snapshots = ${sql.json(run.snapshots)}, moves = ${sql.json(run.moves)},
    hint_count = ${run.hint_count}, undo_count = ${run.undo_count}, restart_count = ${run.restart_count}, revealed = ${run.revealed},
    revision = ${run.revision}, penalty_paid = ${run.penalty_paid}, harsh_penalty_paid = ${run.harsh_penalty_paid}, ranked = ${run.ranked},
    status = ${run.status}, finished_at = ${run.finished_at}, rating_after = ${run.rating_after}, delta = ${run.delta}
    WHERE id = ${run.id}`;
}
async function appendAdjustment(sql, player, run, now, eventKey, desired, reason, metadata = {}) {
  const before = player.rating, after = Math.max(0, before + Math.round(desired));
  const delta = after - before;
  await sql`INSERT INTO club24.rating_history (player_id, run_id, event_key, rating_before, rating_after, delta, reason, created_at)
    VALUES (${player.id}, ${run.id}, ${eventKey}, ${before}, ${after}, ${delta}, ${reason}, ${now})`;
  await sql`UPDATE club24.players SET rating = ${after}, peak_rating = greatest(peak_rating, ${after}), fast_streak = ${player.fast_streak} WHERE id = ${player.id}`;
  player.rating = after; run.delta = (run.delta || 0) + delta; run.rating_after = after;
  if (delta < 0) run.penalty_paid += -delta;
  run.latestAdjustment = { delta, ratingBefore: before, ratingAfter: after, reason, ranked: true, fastStreak: player.fast_streak, streakMultiplier: 1, ...metadata };
  return delta;
}
async function applyPenalty(sql, player, run, now, action, eventKey) {
  player.fast_streak = 0;
  if (!run.ranked) {
    await sql`UPDATE club24.players SET fast_streak = 0 WHERE id = ${player.id}`;
    return 0;
  }
  const penalty = actionPenalty({ action, rating: player.rating, penaltyPaid: run.penalty_paid, harshPenaltyPaid: run.harsh_penalty_paid, hints: run.hint_count });
  const delta = await appendAdjustment(sql, player, run, now, eventKey, -penalty, action);
  if (action !== 'hint') run.harsh_penalty_paid += -delta;
  return delta;
}
async function settle(sql, player, run, now, abandoned = false, eventKey = `${run.id}:completion`) {
  if (run.status !== 'active') return;
  if (run.ranked) {
    if (abandoned) await applyPenalty(sql, player, run, now, 'abandon', eventKey);
    else {
      const change = completionAdjustment({ rating: player.rating, cardCount: run.cards.length, difficulty: run.difficulty, parSeconds: Number(run.par_seconds),
        elapsedSeconds: Math.max(0, (now - new Date(run.started_at)) / 1000), undos: run.undo_count,
        assisted: run.revealed || run.hint_count > 0 || run.restart_count > 0, streak: player.fast_streak });
      player.fast_streak = change.fastStreak;
      await appendAdjustment(sql, player, run, now, eventKey, change.delta, 'completed', { streakMultiplier: change.streakMultiplier });
    }
    await sql`UPDATE club24.players SET games = games + 1 WHERE id = ${player.id}`;
  }
  run.status = abandoned ? 'abandoned' : 'completed'; run.finished_at = now;
  run.delta ??= 0; run.rating_after ??= player.rating;
  await saveRun(sql, run);
}
async function rateLimit(sql, bucket, now, windowMs, maximum) {
  const window = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const [row] = await sql`INSERT INTO club24.request_limits (bucket, window_start) VALUES (${bucket}, ${window})
    ON CONFLICT (bucket, window_start) DO UPDATE SET attempts = club24.request_limits.attempts + 1 RETURNING attempts`;
  if (row.attempts > maximum) fail(429, 'RATE_LIMIT', 'Too many requests. Try again shortly.');
}

export function createClubHandler({ sql, now = () => new Date(), makePuzzle = generatePuzzle } = {}) {
  return async function clubHandler(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (!sql) fail(503, 'DATABASE_UNAVAILABLE', 'The club database is not configured yet. Practice is still available.');
      const method = req.method || 'GET', instant = now(), token = tokenFrom(req);
      if (!['GET', 'POST'].includes(method)) { res.setHeader('Allow', 'GET, POST'); fail(405, 'METHOD', 'Use GET or POST.'); }
      const playerId = await identity(sql, token, instant);
      let response;
      if (method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`), action = url.searchParams.get('action') || 'me';
        if (!['me', 'leaderboard', 'history'].includes(action)) fail(400, 'ACTION', 'Unknown action.');
        if (action === 'history' && !playerId) fail(401, 'SESSION', 'Choose a username to join the club.');
        response = await envelope(sql, playerId);
        if (action === 'me' && playerId) {
          await sql`UPDATE club24.sessions SET expires_at = ${new Date(instant.getTime() + YEAR * 1000)} WHERE token_hash = ${hash(token)}`;
          cookie(res, token);
        }
        if (action === 'history') {
          const before = url.searchParams.get('before');
          if (before && !/^\d{1,19}$/.test(before)) fail(400, 'CURSOR', 'Invalid history cursor.');
          const rows = before
            ? await sql`SELECT * FROM club24.rating_history WHERE player_id = ${playerId} AND id < ${before}::bigint ORDER BY id DESC LIMIT 501`
            : await sql`SELECT * FROM club24.rating_history WHERE player_id = ${playerId} ORDER BY id DESC LIMIT 501`;
          response.hasMore = rows.length > 500;
          const page = rows.slice(0, 500);
          response.nextBefore = response.hasMore ? String(page.at(-1).id) : null;
          response.history = page.reverse().map(row => ({ id: String(row.id), runId: row.run_id, ratingBefore: row.rating_before, ratingAfter: row.rating_after, rating: row.rating_after, delta: row.delta, reason: row.reason, createdAt: new Date(row.created_at).toISOString() }));
        }
      } else {
        checkOrigin(req);
        const data = await body(req);
        if (!data || typeof data !== 'object' || Array.isArray(data) || !ACTIONS.has(data.action)) fail(400, 'ACTION', 'Unknown action.');
        if (typeof data.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(data.requestId)) fail(400, 'REQUEST_ID', 'A unique requestId is required.');
        if (data.action === 'register') {
          if (playerId) response = await envelope(sql, playerId);
          else {
            const name = typeof data.name === 'string' ? data.name.trim() : '';
            if (!/^[A-Za-z0-9_-]{3,20}$/.test(name)) fail(400, 'NAME', 'Use 3–20 letters, numbers, underscores, or hyphens.');
            if (RESERVED.has(name.toLowerCase())) fail(400, 'NAME_RESERVED', 'That username is reserved.');
            const id = randomUUID(), newToken = randomBytes(32).toString('hex');
            await sql.begin(async tx => {
              const ip = process.env.VERCEL ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : req.socket?.remoteAddress || 'local';
              await rateLimit(tx, `register:${hash(ip)}`, instant, 3600000, 10);
              await tx`INSERT INTO club24.players (id, name, name_key, created_at) VALUES (${id}, ${name}, ${name.toLowerCase()}, ${instant})`;
              await tx`INSERT INTO club24.sessions (token_hash, player_id, expires_at, created_at) VALUES (${hash(newToken)}, ${id}, ${new Date(instant.getTime() + YEAR * 1000)}, ${instant})`;
              await tx`INSERT INTO club24.rating_history (player_id, event_key, rating_before, rating_after, delta, reason, created_at) VALUES (${id}, ${`join:${id}`}, 1000, 1000, 0, 'joined', ${instant})`;
              await tx`INSERT INTO club24.run_events (player_id, request_id, action, created_at) VALUES (${id}, ${data.requestId}, 'register', ${instant})`;
            });
            cookie(res, newToken);
            response = await envelope(sql, id);
          }
        } else {
          if (!playerId) fail(401, 'SESSION', 'Choose a username to join the club.');
          response = await sql.begin(async tx => {
            const [player] = await tx`SELECT * FROM club24.players WHERE id = ${playerId} FOR UPDATE`;
            const [previous] = await tx`SELECT * FROM club24.run_events WHERE player_id = ${playerId} AND request_id = ${data.requestId}`;
            if (previous) {
              if (previous.action !== data.action) fail(409, 'REQUEST_ID_REUSED', 'That requestId belongs to another action.');
              const [oldRun] = previous.run_id ? await tx`SELECT * FROM club24.runs WHERE id = ${previous.run_id}` : [];
              return { ...await envelope(tx, playerId), ...previous.result, ...(oldRun ? { run: publicRun(oldRun) } : {}) };
            }
            await rateLimit(tx, `action:${playerId}`, instant, 60000, 300);
            let run, extra = {};
            if (data.action === 'start') {
              await rateLimit(tx, `start:${playerId}`, instant, 60000, 30);
              let settings = settingsFrom(data.settings);
              const [active] = await tx`SELECT * FROM club24.runs WHERE player_id = ${playerId} AND status = 'active' FOR UPDATE`;
              let source = active, replay;
              if (data.replayRunId !== undefined) {
                if (typeof data.replayRunId !== 'string' || !UUID.test(data.replayRunId)) fail(400, 'RUN', 'A valid replayRunId is required.');
                [replay] = await tx`SELECT * FROM club24.runs WHERE id = ${data.replayRunId} AND player_id = ${playerId}`;
                if (!replay) fail(404, 'RUN', 'That saved round was not found.');
                settings = { ...replay.settings, keepCards: true, keepTarget: true };
              } else if ((settings.keepCards || settings.keepTarget) && !source) {
                [source] = await tx`SELECT * FROM club24.runs WHERE player_id = ${playerId} ORDER BY started_at DESC, id DESC LIMIT 1`;
              }
              if (!replay && (settings.keepCards || settings.keepTarget) && !source) fail(400, 'SETTINGS', 'Deal a round before retaining its cards or target.');
              if (settings.count < minimumRatedCards(player.rating)) fail(400, 'CARD_MINIMUM', `Your rating requires at least ${minimumRatedCards(player.rating)} cards. Choose that many or more.`);
              // Generate first: a failed generation preserves the current run.
              let puzzle;
              try {
                puzzle = replay ? { cards: replay.cards, target: replay.target, solution: replay.witness }
                  : makePuzzle({ ...settings, ...(source ? { cards: source.cards, target: source.target, witness: source.witness } : {}) });
                validatePuzzle(puzzle.cards, puzzle.target, puzzle.solution);
              }
              catch (error) { fail(400, 'GENERATION', error.message); }
              if (active) {
                await settle(tx, player, active, instant, true);
                extra.previousRun = publicRun(active);
                if (active.latestAdjustment) extra.adjustment = active.latestAdjustment;
              }
              const fingerprint = puzzleFingerprint(puzzle.cards, puzzle.target);
              const [seen] = await tx`SELECT id FROM club24.runs WHERE player_id = ${playerId} AND fingerprint = ${fingerprint} LIMIT 1`;
              const params = challengeParameters(settings.count, settings.hard), id = randomUUID();
              [run] = await tx`INSERT INTO club24.runs (id, player_id, cards, target, settings, witness, board, fingerprint, difficulty, par_seconds, rating_version, ranked, rating_before, started_at)
                VALUES (${id}, ${playerId}, ${tx.json(puzzle.cards)}, ${puzzle.target}, ${tx.json(settings)}, ${tx.json(puzzle.solution)}, ${tx.json(initialBoard(puzzle.cards))},
                ${fingerprint}, ${params.difficulty}, ${params.parSeconds}, ${params.version}, ${!seen && !settings.keepCards && !settings.keepTarget && !replay && settings.maxTarget === maxTarget(settings.count)}, ${player.rating}, ${instant}) RETURNING *`;
              if (!run.ranked) {
                player.fast_streak = 0;
                await tx`UPDATE club24.players SET fast_streak = 0 WHERE id = ${player.id}`;
              }
            } else {
              if (typeof data.runId !== 'string' || !UUID.test(data.runId)) fail(400, 'RUN', 'A valid runId is required.');
              [run] = await tx`SELECT * FROM club24.runs WHERE id = ${data.runId} AND player_id = ${playerId} FOR UPDATE`;
              if (!run) fail(404, 'RUN', 'That round was not found.');
              if (run.status !== 'active') fail(409, 'RUN_FINISHED', 'That round has already finished.');
              if (!Number.isInteger(data.expectedRevision) || data.expectedRevision !== run.revision) fail(409, 'STALE_RUN', 'This round changed in another tab. Refresh the current board and try again.');
              const eventKey = `${run.id}:${data.requestId}:${data.action}`;
              if (data.action === 'move') {
                if (!Number.isInteger(data.a) || !Number.isInteger(data.b) || data.a === data.b || !run.board[data.a] || !run.board[data.b] || !['+', '-', '*', '/'].includes(data.op)) fail(400, 'MOVE', 'Choose two different current cards and a valid operation.');
                let merged;
                try { merged = combineNodes(run.board[data.a], run.board[data.b], data.op); }
                catch (error) { fail(400, 'MOVE', error.message); }
                run.snapshots.push({ board: run.board, moves: run.moves });
                const destination = Math.min(data.a, data.b);
                run.board = slots(run.board.flatMap((node, i) => i === destination ? [merged] : i === data.a || i === data.b ? [] : [node]));
                run.moves = [...run.moves, { expr: merged.expr, result: formatValue(merged.value), op: data.op }];
                if (run.board.length === 1 && equalsTarget(run.board[0].value, run.target)) await settle(tx, player, run, instant);
                else if (run.board.length === 1 && run.ranked) {
                  player.fast_streak = 0;
                  await tx`UPDATE club24.players SET fast_streak = 0 WHERE id = ${player.id}`;
                }
              } else if (data.action === 'undo') {
                const snapshot = run.snapshots.pop();
                if (!snapshot) fail(409, 'UNDO', 'There is no move to undo.');
                run.board = snapshot.board; run.moves = snapshot.moves; run.undo_count++;
                player.fast_streak = 0;
                await tx`UPDATE club24.players SET fast_streak = 0 WHERE id = ${player.id}`;
              } else if (data.action === 'hint') {
                extra.hint = findHint({ nodes: run.board, target: run.target, witness: run.witness });
                if (extra.hint.status === 'move') { run.hint_count++; await applyPenalty(tx, player, run, instant, 'hint', eventKey); }
              } else if (data.action === 'solution') {
                run.revealed = true; await applyPenalty(tx, player, run, instant, 'solution', eventKey); extra.solution = solutionView(run.witness);
              } else if (data.action === 'restart') {
                const wasRanked = run.ranked;
                await applyPenalty(tx, player, run, instant, 'restart', eventKey);
                if (wasRanked) await tx`UPDATE club24.players SET games = games + 1 WHERE id = ${player.id}`;
                run.board = initialBoard(run.cards); run.moves = []; run.snapshots = []; run.restart_count++;
                run.ranked = false;
              } else if (data.action === 'abandon') await settle(tx, player, run, instant, true, eventKey);
              run.revision++;
              await saveRun(tx, run);
            }
            const adjustment = run.latestAdjustment || extra.adjustment;
            if (adjustment) extra.adjustment = adjustment;
            // Persist the event receipt as well as its effect for safe retries.
            await tx`INSERT INTO club24.run_events (player_id, run_id, request_id, action, result, created_at)
              VALUES (${playerId}, ${run.id}, ${data.requestId}, ${data.action}, ${tx.json(extra)}, ${instant})`;
            return { ...await envelope(tx, playerId), ...extra, run: publicRun(run) };
          });
        }
      }
      res.statusCode = 200; res.end(JSON.stringify(response));
    } catch (error) {
      const duplicateName = error.code === '23505' && error.constraint_name === 'players_name_key_key';
      const unavailable = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'CONNECT_TIMEOUT', 'CONNECTION_CLOSED', '42P01', '3F000'].includes(error.code);
      res.statusCode = duplicateName ? 409 : error.status || (unavailable ? 503 : 500);
      const message = duplicateName ? 'That username is already taken. Choose another.' : error.status ? error.message : unavailable ? 'The club database is temporarily unavailable. Practice is still available.' : 'The club request could not be completed. Try again.';
      if (!error.status && !duplicateName) console.error('Club API error:', error.code || error.name, error.message);
      res.end(JSON.stringify({ error: message, code: duplicateName ? 'NAME_TAKEN' : error.status ? error.code : unavailable ? 'DATABASE_UNAVAILABLE' : 'INTERNAL' }));
    }
  };
}

let defaultHandler;
export default function handler(req, res) {
  if (!defaultHandler) defaultHandler = createClubHandler({ sql: process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 3, prepare: false, idle_timeout: 20, connect_timeout: 5 }) : null });
  return defaultHandler(req, res);
}
