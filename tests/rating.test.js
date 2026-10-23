import test from 'node:test';
import assert from 'node:assert/strict';
import { actionPenalty, challengeParameters, completionAdjustment, puzzleFingerprint, severePenalty, minimumRatedCards } from '../server/rating.js';

const result = overrides => completionAdjustment({ rating: 1000, difficulty: 1000, parSeconds: 60, ...overrides });

test('v2 challenge bands preserve explicit provisional difficulty and time anchors', () => {
  assert.deepEqual(challengeParameters(2), { difficulty: 600, parSeconds: 12, version: 'v2' });
  assert.deepEqual(challengeParameters(4), { difficulty: 1000, parSeconds: 60, version: 'v2' });
  assert.deepEqual(challengeParameters(9, true), { difficulty: 3050, parSeconds: 283.5, version: 'v2' });
  assert.throws(() => challengeParameters(10));
});

test('slow unaided solves preserve a small floor, fast rewards depend on opponent difficulty', () => {
  assert.equal(result({ elapsedSeconds: 1800 }).delta, -5);
  assert.equal(result({}).delta, 45);
  assert.ok(result({ difficulty: 1400 }).delta > result({ difficulty: 600 }).delta);
  assert.equal(result({ rating: 3000, elapsedSeconds: 1800 }).delta, -25);
  assert.equal(result({ rating: 3000, cardCount: 9, difficulty: 3000 }).delta, 4);
  assert.equal(result({ rating: 3000, cardCount: 9, difficulty: 3050 }).delta, 5);
  assert.equal(result({ rating: 4000, cardCount: 9, difficulty: 3050 }).delta, 1);
});

test('hints are immediate small percentage costs; assisted completion adds zero', () => {
  assert.equal(actionPenalty({ action: 'hint', rating: 1000 }), 3);
  assert.equal(actionPenalty({ action: 'hint', rating: 3000 }), 9);
  assert.equal(result({ assisted: true, difficulty: 10000 }).delta, 0);
  assert.equal(result({ assisted: true, streak: 10 }).fastStreak, 0);
  assert.equal(result({ ranked: false }).delta, 0);
});

test('severe percentage penalties scale with rating and offset all charges paid this attempt', () => {
  assert.equal(severePenalty(1000), 50);
  assert.equal(severePenalty(3000), 250);
  assert.equal(severePenalty(4000), 400);
  assert.equal(severePenalty(0), 0);
  assert.equal(severePenalty(1), 1);
  assert.equal(actionPenalty({ action: 'solution', rating: 1000, penaltyPaid: 3 }), 47);
  assert.equal(actionPenalty({ action: 'abandon', rating: 950, penaltyPaid: 50 }), 0);
  assert.equal(actionPenalty({ action: 'restart', rating: 1000 }), 50);
});

test('fast streak boosts only the bonus, caps at ten percent, and resets after slow or undone solves', () => {
  const first = result({ elapsedSeconds: 20 });
  const sixth = result({ elapsedSeconds: 20, streak: 5 });
  assert.equal(first.fastStreak, 1);
  assert.equal(first.streakMultiplier, 1);
  assert.equal(sixth.fastStreak, 6);
  assert.equal(sixth.streakMultiplier, 1.1);
  assert.equal(result({ elapsedSeconds: 20, streak: 100 }).streakMultiplier, 1.1);
  assert.equal(first.floor, sixth.floor);
  assert.ok(sixth.fastBonus > first.fastBonus);
  assert.equal(result({ elapsedSeconds: 31, streak: 5 }).fastStreak, 0);
  assert.equal(result({ elapsedSeconds: 20, streak: 5, undos: 1 }).fastStreak, 0);
  assert.ok(result({ undos: 1 }).delta < result({}).delta);
  assert.ok(result({ undos: 1000 }).delta >= 1);
});

test('progression simulation tapers clean gains around 3000 without pretending there is a hard cap', () => {
  let rating = 1000, streak = 0;
  const gains = [];
  for (let i = 0; i < 500; i++) {
    const params = challengeParameters(9, true);
    const next = result({ rating, difficulty: params.difficulty, cardCount: 9, parSeconds: params.parSeconds, elapsedSeconds: params.parSeconds * .25, streak });
    assert.equal(next.ratingAfter, rating + next.delta);
    assert.ok(Number.isInteger(next.delta));
    gains.push(next.delta);
    rating = next.ratingAfter; streak = next.fastStreak;
  }
  assert.ok(rating > 2500 && rating < 4000);
  assert.ok(gains.at(-1) < gains[0]);
  assert.ok(gains.at(-1) <= 3);
  const cautious = result({ rating: 3000, difficulty: 3050, elapsedSeconds: 1800 });
  assert.equal(cautious.delta, -25);
  assert.ok(severePenalty(3000) > 40 * result({ rating: 3000, difficulty: 3050 }).delta);
});

test('repeat-puzzle fingerprints exclude order and game mode', () => {
  assert.equal(puzzleFingerprint([8, 3, 8, 3], 24), puzzleFingerprint([3, 8, 3, 8], 24));
  assert.notEqual(puzzleFingerprint([3, 8, 3, 8], 24), puzzleFingerprint([3, 8, 3, 8], 25));
});

test('all rating changes remain whole points across difficulty, speed and assistance', () => {
  for (const rating of [0, 1, 999, 1000, 1237, 2999, 3000, 4221]) {
    for (let count = 2; count <= 9; count++) {
      const parameters = challengeParameters(count, count % 2 === 0);
      for (const elapsedSeconds of [0.25, 17.7, 1800]) {
        const next = result({ rating, ...parameters, elapsedSeconds, streak: 7, undos: count % 3 });
        assert.ok(Number.isInteger(next.delta));
        assert.ok(Number.isInteger(next.ratingAfter));
      }
    }
    for (const action of ['hint', 'solution', 'restart', 'abandon']) {
      assert.ok(Number.isInteger(actionPenalty({ action, rating, penaltyPaid: 3 })));
    }
  }
});

test('exponential card gates match the requested anchors',()=>{assert.equal(minimumRatedCards(1000),4);assert.equal(minimumRatedCards(2700),8);});

test('accelerating curve includes every card count and stays monotone',()=>{
 const seen=new Set();let previous=2;
 for(let r=0;r<=4000;r++){const n=minimumRatedCards(r);assert(n>=previous);assert(n>=2&&n<=9);seen.add(n);previous=n;}
 assert.deepEqual([...seen],[2,3,4,5,6,7,8,9]);
 assert.equal(minimumRatedCards(500),3);assert.equal(minimumRatedCards(2000),6);
});
