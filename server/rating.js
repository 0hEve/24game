// v2 is an Elo-inspired progression score, not a calibrated competitive Elo.
// Difficulty bands and timing baselines are provisional design parameters.
// Completion gains taper with rating; assistance costs are immediate ledger
// events, so an assisted completion never refunds the assistance charge.
export const RATING_VERSION = 'v2';
export const INITIAL_RATING = 1000;
const PAR = [12, 25, 60, 90, 120, 150, 180, 210];
const DIFFICULTY = [600, 800, 1000, 1400, 1800, 2200, 2600, 2900];
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

export function challengeParameters(count, hard = false) {
  if (!Number.isInteger(count) || count < 2 || count > 9) throw new Error('Choose between 2 and 9 cards.');
  return { difficulty: DIFFICULTY[count - 2] + (hard ? 150 : 0), parSeconds: PAR[count - 2] * (hard ? 1.35 : 1), version: RATING_VERSION };
}

export function puzzleFingerprint(cards, target) {
  return `${cards.slice().sort((a, b) => a - b).join(',')}:${target}`;
}

export function severePenalty(rating) {
  if (rating <= 0) return 0;
  const percentage = clamp(.05 + (rating - INITIAL_RATING) / 60000, .02, .10);
  return Math.max(1, Math.round(rating * percentage));
}

export function actionPenalty({ action, rating, penaltyPaid = 0 }) {
  if (action === 'hint') return Math.max(1, Math.ceil(3 * rating / INITIAL_RATING));
  // All penalties already paid on this attempt offset its harsh charge.
  // Revealing and then moving to the next puzzle never charges it twice.
  return Math.max(0, severePenalty(rating) - penaltyPaid);
}

export function minimumRatedCards(rating) {
  return clamp(Math.ceil(2 + 7 * Math.expm1(clamp(rating, 0, 3000) / 1500) / Math.expm1(2) - 1e-10), 2, 9);
}

export function completionAdjustment({ rating, cardCount = 4, difficulty, parSeconds, elapsedSeconds = 0, undos = 0, assisted = false, ranked = true, streak = 0 }) {
  if (!ranked) return { delta: 0, ratingAfter: rating, fastStreak: 0, streakMultiplier: 1, floor: 0, fastBonus: 0 };
  const elapsed = Math.max(0, elapsedSeconds);
  const expected = 1 / (1 + 10 ** ((difficulty - rating) / 400));
  const aboveStart = Math.max(0, rating - INITIAL_RATING);
  const floor = Math.max(1, Math.round(5 * Math.exp(-aboveStart / 900)));
  const amplitude = 80 * Math.exp(-((aboveStart / 1250) ** 2));
  const fastEligible = undos === 0 && elapsed <= parSeconds * .5;
  const fastStreak = fastEligible ? streak + 1 : 0;
  const streakMultiplier = fastEligible ? 1 + .02 * Math.min(Math.max(0, fastStreak - 1), 5) : 1;
  const fastBonus = Math.round(amplitude * (1 - expected) * Math.exp(-elapsed / parSeconds) * streakMultiplier);
  const reward = assisted || cardCount < minimumRatedCards(rating) ? 0 : Math.max(1, Math.floor((floor + fastBonus) * Math.max(.25, .9 ** undos)));
  const timeCap = Math.round(severePenalty(rating) * .10);
  const timePenalty = Math.min(timeCap, Math.floor(timeCap * elapsed / (parSeconds * 3)));
  const timedReward = Math.floor(reward * Math.exp(-elapsed / (parSeconds * 3)));
  const delta = Math.max(-rating, timedReward - timePenalty);
  return { delta, ratingAfter: rating + delta, timePenalty, minimumCards: minimumRatedCards(rating), fastStreak: !assisted && reward > 0 ? fastStreak : 0, streakMultiplier, floor, fastBonus, expected };
}
