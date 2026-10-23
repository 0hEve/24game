import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { createClubHandler } from '../server/handler.js';
import { leaf, combineNodes, generatePuzzle } from '../src/engine.js';

function fixture(settings) {
  if (settings.keepCards || settings.keepTarget) return generatePuzzle({ ...settings, seed: 42 });
  const cards = Array.from({ length: settings.count }, (_, i) => i + 1);
  const solution = cards.map(leaf).reduce((a, b) => combineNodes(a, b, '+'));
  return { cards, target: cards.reduce((a, b) => a + b, 0), solution };
}
function client(handler, address = randomUUID()) {
  let cookie = '';
  const revisions = new Map();
  const call = async (action, data = {}, options = {}) => {
    const headers = { host: 'localhost:5173', 'content-type': 'application/json', origin: 'http://localhost:5173', cookie, ...options.headers };
    const method = options.method || 'POST';
    const req = { method, headers, socket: { remoteAddress: address }, url: `/api/club${method === 'GET' ? `?action=${action}${options.query || ''}` : ''}`,
      body: options.rawBody ?? { action, requestId: randomUUID(), ...(data.runId ? { expectedRevision: revisions.get(data.runId) ?? 0 } : {}), ...data } };
    const responseHeaders = {};
    const res = { setHeader: (name, value) => { responseHeaders[name] = value; }, end: value => { res.body = JSON.parse(value); } };
    await handler(req, res);
    for (const run of [res.body?.run, res.body?.activeRun]) if (run) revisions.set(run.id, run.revision);
    if (responseHeaders['Set-Cookie']) cookie = responseHeaders['Set-Cookie'].split(';')[0];
    return { status: res.statusCode, body: res.body, headers: responseHeaders };
  };
  return { call, cookie: () => cookie };
}

test('missing database has an actionable practice-safe response', async () => {
  const result = await client(createClubHandler()).call('me', {}, { method: 'GET' });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'DATABASE_UNAVAILABLE');
});

const url = process.env.DATABASE_TEST_URL;
test('authoritative PostgreSQL sessions, arithmetic, idempotency, and permanent ledger', { skip: !url }, async t => {
  // Never run destructive test cleanup against the user's application database.
  assert.ok(new URL(url).pathname.endsWith('_test'), 'DATABASE_TEST_URL must point to a dedicated *_test database');
  const sql = postgres(url, { max: 4, onnotice: () => {} });
  t.after(() => sql.end());
  await sql.unsafe(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  await sql`TRUNCATE club24.players, club24.sessions, club24.runs, club24.run_events, club24.rating_history, club24.request_limits RESTART IDENTITY CASCADE`;
  let time = new Date('2026-10-23T12:00:00Z');
  const handler = createClubHandler({ sql, now: () => time, makePuzzle: fixture });
  const alice = client(handler), bob = client(handler);

  await t.test('opaque identity, unique names, baseline history, and origin/body validation', async () => {
    assert.equal((await alice.call('me', {}, { method: 'GET' })).body.player, null);
    assert.equal((await alice.call('register', { name: 'admin' })).status, 400);
    assert.equal((await alice.call('register', { name: 'abc<script>' })).status, 400);
    assert.equal((await alice.call('register', { name: 'Alice' }, { headers: { origin: 'https://attacker.test' } })).status, 403);
    assert.equal((await alice.call('register', {}, { rawBody: '{bad' })).status, 400);
    assert.equal((await alice.call('register', {}, { rawBody: 'x'.repeat(65537) })).status, 413);
    const registered = await alice.call('register', { name: 'Alice' });
    assert.equal(registered.status, 200);
    assert.equal(registered.body.player.rating, 1000);
    assert.equal(registered.body.player.peakRating, 1000);
    assert.match(registered.headers['Set-Cookie'], /HttpOnly; SameSite=Lax/);
    const token = alice.cookie().split('=')[1];
    assert.match(token, /^[a-f0-9]{64}$/);
    const [session] = await sql`SELECT * FROM club24.sessions`;
    assert.equal(session.token_hash, createHash('sha256').update(token).digest('hex'));
    assert.notEqual(session.token_hash, token);
    assert.equal((await bob.call('register', { name: 'aLiCe' })).status, 409);
    assert.equal((await bob.call('register', { name: 'Bobby' })).status, 200);
    const history = await alice.call('history', {}, { method: 'GET' });
    assert.equal(history.body.history.length, 1);
    assert.equal(history.body.history[0].ratingAfter, 1000);
    assert.equal((await alice.call('me', {}, { method: 'GET' })).headers['Set-Cookie'].includes('Max-Age='), true);
  });

  let run;
  await t.test('server board is exact; mutations are owned, idempotent, and never trust claimed results', async () => {
    const startId = randomUUID();
    const first = await alice.call('start', { requestId: startId, settings: { count: 3, hard: false } });
    assert.equal(first.status, 200);
    run = first.body.run;
    assert.equal(run.ranked, true);
    assert.equal(run.status, 'active');
    assert.equal(run.board.length, 3);
    assert.equal(run.solution, undefined);
    assert.equal(run.witness, undefined);
    assert.equal(run.snapshots, undefined);
    assert.equal((await alice.call('start', { requestId: startId, settings: { count: 9 } })).body.run.id, run.id);
    assert.equal((await bob.call('hint', { runId: run.id })).status, 404);
    assert.equal((await alice.call('move', { runId: run.id, a: 0, b: 0, op: '+' })).status, 400);
    assert.equal((await alice.call('move', { runId: run.id, a: 0.5, b: 1, op: '+' })).status, 400);
    const requestId = randomUUID();
    const moved = await alice.call('move', { requestId, runId: run.id, a: 0, b: 1, op: '/', score: 100000, elapsedSeconds: 0 });
    assert.equal(moved.status, 200);
    assert.deepEqual(moved.body.run.board[0].value, { n: '1', d: '2' });
    assert.equal(moved.body.run.canUndo, true);
    const repeat = await alice.call('move', { requestId, runId: run.id, a: 0, b: 1, op: '+' });
    assert.equal(repeat.body.run.board.length, 2);
    assert.deepEqual(repeat.body.run.board[0].value, { n: '1', d: '2' });
    assert.equal((await alice.call('undo', { requestId, runId: run.id })).status, 409);
    const undone = await alice.call('undo', { runId: run.id });
    assert.equal(undone.body.run.undoCount, 1);
    assert.equal(undone.body.run.board.length, 3);
    const hintId = randomUUID();
    const hint = await alice.call('hint', { runId: run.id, requestId: hintId });
    assert.equal(hint.body.hint.status, 'move');
    assert.equal(hint.body.run.hintCount, 1);
    assert.equal(hint.body.adjustment.delta, -3);
    assert.equal(hint.body.adjustment.ratingAfter, hint.body.player.rating);
    assert.equal(hint.body.player.fastStreak, 0);
    assert.equal((await alice.call('hint', { runId: run.id, requestId: hintId })).body.run.hintCount, 1);
    const startedAt = run.startedAt;
    time = new Date(time.getTime() + 90000);
    const restarted = await alice.call('restart', { runId: run.id });
    assert.equal(restarted.body.run.startedAt, startedAt);
    assert.equal(restarted.body.run.restartCount, 1);
    assert.equal(restarted.body.run.hintCount, 1);
    const revealed = await alice.call('solution', { runId: run.id });
    assert.ok(revealed.body.solution.tree);
    assert.equal(revealed.body.run.revealed, true);
    await alice.call('move', { runId: run.id, a: 0, b: 1, op: '+' });
    const completed = await alice.call('move', { runId: run.id, a: 0, b: 1, op: '+' });
    assert.equal(completed.body.activeRun, null);
    assert.equal(completed.body.run.status, 'completed');
    assert.ok(completed.body.run.delta <= -16);
    assert.equal(completed.body.player.games, 1);
    assert.equal(completed.body.player.rating, completed.body.run.ratingAfter);
    const entries = await sql`SELECT * FROM club24.rating_history WHERE run_id = ${run.id}`;
    assert.equal(entries.length, 2);
    assert.equal(entries.reduce((total, row) => total + row.delta, 0), completed.body.run.delta);
    assert.equal((await alice.call('abandon', { runId: run.id })).status, 409);
  });

  await t.test('repeat fingerprints and owned history replays are practice, even across modes', async () => {
    const repeat = await alice.call('start', { settings: { count: 3, hard: true } });
    assert.equal(repeat.body.run.ranked, false);
    const rating = repeat.body.player.rating;
    await alice.call('move', { runId: repeat.body.run.id, a: 0, b: 1, op: '+' });
    const done = await alice.call('move', { runId: repeat.body.run.id, a: 0, b: 1, op: '+' });
    assert.equal(done.body.run.delta, 0);
    assert.equal(done.body.player.rating, rating);
    assert.equal(done.body.player.games, 1);
    const replay = await alice.call('start', { replayRunId: run.id });
    assert.equal(replay.body.run.ranked, false);
    assert.deepEqual(replay.body.run.cards, run.cards);
    assert.equal(replay.body.run.target, run.target);
    assert.equal((await bob.call('start', { replayRunId: run.id })).status, 404);
    const kept = await alice.call('start', { settings: { count: 3, maxTarget: 100, keepCards: true, keepTarget: true } });
    assert.equal(kept.body.run.ranked, false);
    assert.deepEqual(kept.body.run.cards, run.cards);
  });

  await t.test('invalid retained generation preserves active run, concurrent starts serialize, abandonment cannot be skipped', async () => {
    const before = await bob.call('start', { settings: { count: 2 } });
    const bad = await bob.call('start', { settings: { count: 2, maxTarget: 1, keepTarget: true } });
    assert.equal(bad.status, 400);
    assert.equal((await bob.call('me', {}, { method: 'GET' })).body.activeRun.id, before.body.run.id);
    assert.equal((await bob.call('me', {}, { method: 'GET' })).body.player.rating, 1000);
    const [first, second] = await Promise.all([
      bob.call('start', { settings: { count: 4 } }),
      bob.call('start', { settings: { count: 5 } }),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const [{ count }] = await sql`SELECT count(*) FROM club24.runs WHERE player_id = ${before.body.player.id} AND status = 'active'`;
    assert.equal(Number(count), 1);
    const state = await bob.call('me', {}, { method: 'GET' });
    assert.ok(state.body.player.rating < 1000);
    const abandonId = randomUUID();
    const [a, b] = await Promise.all([
      bob.call('abandon', { runId: state.body.activeRun.id, requestId: abandonId }),
      bob.call('abandon', { runId: state.body.activeRun.id, requestId: abandonId }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.body.player.rating, b.body.player.rating);
    assert.equal(a.body.activeRun, null);
    const [{ count: ledgerCount }] = await sql`SELECT count(*) FROM club24.rating_history WHERE run_id = ${state.body.activeRun.id}`;
    assert.equal(Number(ledgerCount), 1);
    const history = await bob.call('history', {}, { method: 'GET' });
    assert.equal(history.body.history.at(-1).ratingAfter, a.body.player.rating);
    assert.equal(history.body.history.at(-1).delta, a.body.run.delta);
  });

  await t.test('leaderboard is permanent, deterministic, and cookie loss cannot reclaim names', async () => {
    const stranger = client(handler);
    const board = await stranger.call('leaderboard', {}, { method: 'GET' });
    assert.equal(board.status, 200);
    assert.equal(board.body.leaderboard.length, 2);
    assert.deepEqual(board.body.leaderboard.map(row => row.rank), [1, 2]);
    assert.equal(board.body.player, null);
    assert.equal((await stranger.call('register', { name: 'ALICE' })).body.code, 'NAME_TAKEN');
    assert.equal((await stranger.call('history', {}, { method: 'GET' })).status, 401);
    const restartedHandler = createClubHandler({ sql, now: () => time, makePuzzle: fixture });
    const restored = await client(restartedHandler).call('me', {}, { method: 'GET', headers: { cookie: alice.cookie() } });
    assert.equal(restored.body.player.name, 'Alice');
  });

  await t.test('division by zero and dead-end hints never mutate or charge the round', async () => {
    const started = await alice.call('start', { settings: { count: 4 } });
    const runId = started.body.run.id;
    await alice.call('move', { runId, a: 0, b: 1, op: '+' }); // [3,3,4]
    const zero = await alice.call('move', { runId, a: 0, b: 1, op: '-' }); // [0,4]
    assert.equal(zero.body.run.board[0].value.n, '0');
    const invalid = await alice.call('move', { runId, a: 1, b: 0, op: '/' });
    assert.equal(invalid.status, 400);
    const hint = await alice.call('hint', { runId });
    assert.equal(hint.body.hint.status, 'dead-end');
    assert.equal(hint.body.run.hintCount, 0);
    assert.equal(hint.body.run.moves.length, 2);
    assert.equal(hint.body.player.rating, started.body.player.rating);
    const current = await alice.call('me', {}, { method: 'GET' });
    assert.equal(current.body.activeRun.board.length, 2);
    assert.equal(current.body.activeRun.snapshotCount, 2);
  });

  await t.test('immediate ledger charges are atomic, reveal then abandon never double-charges, and stale boards reject', async () => {
    const started = await alice.call('start', { settings: { count: 5 } });
    const id = started.body.run.id;
    const stale = await alice.call('move', { runId: id, a: 0, b: 1, op: '+', expectedRevision: 99 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'STALE_RUN');
    assert.equal((await alice.call('me', {}, { method: 'GET' })).body.activeRun.board.length, 5);
    const hinted = await alice.call('hint', { runId: id });
    assert.equal(hinted.body.player.rating, started.body.player.rating + hinted.body.adjustment.delta);
    assert.equal(hinted.body.run.revision, 1);
    const revealed = await alice.call('solution', { runId: id });
    assert.ok(revealed.body.player.rating <= hinted.body.player.rating);
    assert.equal(revealed.body.adjustment.ratingBefore, hinted.body.player.rating);
    const abandoned = await alice.call('abandon', { runId: id });
    assert.equal(abandoned.body.adjustment.delta, 0);
    assert.equal(abandoned.body.player.rating, revealed.body.player.rating);
    const entries = await sql`SELECT * FROM club24.rating_history WHERE run_id = ${id} ORDER BY id`;
    assert.deepEqual(entries.map(row => row.reason), ['hint', 'solution', 'abandon']);
    assert.equal(entries.reduce((sum, row) => sum + row.delta, 0), abandoned.body.run.delta);
    assert.equal(entries[1].rating_before, entries[0].rating_after);
    assert.equal(entries[2].rating_before, entries[1].rating_after);
    assert.equal(entries.at(-1).rating_after, abandoned.body.player.rating);
  });

  await t.test('history paginates without deleting older events and current rank remains visible outside top 100', async () => {
    const named = client(handler);
    assert.equal((await named.call('register', { name: 'Ranked-Player' })).status, 200);
    const me = (await bob.call('me', {}, { method: 'GET' })).body.player;
    await sql`INSERT INTO club24.rating_history (player_id, event_key, rating_before, rating_after, delta, reason)
      SELECT ${me.id}, 'paging:' || ${me.id} || ':' || i, ${me.rating}, ${me.rating}, 0, 'paging-test' FROM generate_series(1,501) i`;
    const page = (await bob.call('history', {}, { method: 'GET' })).body;
    assert.equal(page.history.length, 500);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextBefore, page.history[0].id);
    const older = (await bob.call('history', {}, { method: 'GET', query: `&before=${page.nextBefore}` })).body;
    assert.ok(older.history.length > 0);
    assert.equal(older.hasMore, false);
    assert.ok(Number(older.history.at(-1).id) < Number(page.history[0].id));
    assert.equal((await bob.call('history', {}, { method: 'GET', query: '&before=bad' })).status, 400);
    const rivals = Array.from({ length: 102 }, (_, i) => ({ id: randomUUID(), name: `Rival_${i}`, name_key: `rival_${i}`, rating: 2000 }));
    await sql`INSERT INTO club24.players ${sql(rivals, 'id', 'name', 'name_key', 'rating')}`;
    const outside = (await bob.call('leaderboard', {}, { method: 'GET' })).body;
    assert.equal(outside.leaderboard.length, 100);
    assert.ok(outside.player.rank > 100);
    assert.equal(outside.leaderboard.some(row => row.id === outside.player.id), false);
  });

  await t.test('v2 endpoint anchors charge immediately at 3000 and never repeat reveal loss on the next deal', async () => {
    const high = client(handler);
    const joined = await high.call('register', { name: 'HighRated' });
    const id = joined.body.player.id;
    await sql`UPDATE club24.players SET rating = 3000, peak_rating = 3000 WHERE id = ${id}`;
    await sql`INSERT INTO club24.rating_history (player_id, event_key, rating_before, rating_after, delta, reason)
      VALUES (${id}, ${`test-setup:${id}`}, 1000, 3000, 2000, 'test-setup')`;
    const started = await high.call('start', { settings: { count: 9, hard: true } });
    assert.equal(started.body.run.ratingVersion, 'v2');
    assert.equal(started.body.run.difficulty, 3050);
    const reveal = await high.call('solution', { runId: started.body.run.id });
    assert.equal(reveal.body.adjustment.delta, -250);
    assert.equal(reveal.body.player.rating, 2750);
    const next = await high.call('start', { settings: { count: 8 } });
    assert.equal(next.body.adjustment.delta, 0);
    assert.equal(next.body.player.rating, 2750);
    assert.equal(next.body.run.ranked, true);
    assert.equal(next.body.run.ratingBefore, 2750);
    assert.equal(next.body.run.penaltyPaid, 0);
    const skip = await high.call('abandon', { runId: next.body.run.id });
    assert.equal(skip.body.adjustment.delta, -218);
    assert.equal(skip.body.player.rating, 2532);
  });

  await t.test('slow clean completion earns five at 1000; fast consecutive clean solves build the server streak', async () => {
    const slow = client(handler);
    await slow.call('register', { name: 'SlowLearner' });
    const start = await slow.call('start', { settings: { count: 2 } });
    time = new Date(time.getTime() + 1800000);
    const completed = await slow.call('move', { runId: start.body.run.id, a: 0, b: 1, op: '+' });
    assert.equal(completed.body.adjustment.delta, 5);
    assert.equal(completed.body.player.rating, 1005);
    assert.equal(completed.body.player.fastStreak, 0);
    assert.equal(completed.body.player.peakRating, 1005);
    const fast = client(handler);
    await fast.call('register', { name: 'FastLearner' });
    const first = await fast.call('start', { settings: { count: 2 } });
    const firstWin = await fast.call('move', { runId: first.body.run.id, a: 0, b: 1, op: '+' });
    assert.equal(firstWin.body.player.fastStreak, 1);
    const second = await fast.call('start', { settings: { count: 3 } });
    await fast.call('move', { runId: second.body.run.id, a: 0, b: 1, op: '+' });
    const secondWin = await fast.call('move', { runId: second.body.run.id, a: 0, b: 1, op: '+' });
    assert.equal(secondWin.body.player.fastStreak, 2);
    assert.equal(secondWin.body.adjustment.streakMultiplier, 1.02);
    const practiceBreak = await fast.call('start', { settings: { count: 5, maxTarget: 100 } });
    assert.equal(practiceBreak.body.run.ranked, false);
    assert.equal(practiceBreak.body.player.fastStreak, 0);
    assert.equal(practiceBreak.body.player.rating, secondWin.body.player.rating);
    assert.equal(practiceBreak.body.adjustment, undefined);
    const wrong = await fast.call('start', { settings: { count: 4 } });
    await fast.call('move', { runId: wrong.body.run.id, a: 0, b: 1, op: '+' });
    await fast.call('move', { runId: wrong.body.run.id, a: 0, b: 1, op: '+' });
    const miss = await fast.call('move', { runId: wrong.body.run.id, a: 0, b: 1, op: '-' });
    assert.equal(miss.body.run.status, 'active');
    assert.equal(miss.body.player.fastStreak, 0);
    await fast.call('undo', { runId: wrong.body.run.id });
    const recovered = await fast.call('move', { runId: wrong.body.run.id, a: 0, b: 1, op: '+' });
    assert.equal(recovered.body.run.status, 'completed');
    assert.equal(recovered.body.player.fastStreak, 0);
    assert.ok(recovered.body.adjustment.delta > 0);
    const practice = await fast.call('start', { settings: { count: 5, maxTarget: 100 } });
    assert.equal(practice.body.run.ranked, false);
  });
});
