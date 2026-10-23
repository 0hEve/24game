# 24 / CLUB

A local arithmetic card game with a configurable target range, 2–9 cards, exact fractions, keyboard play, merge animations, hard mode, and replayable attempt history. Practice works without an account. The club leaderboard uses an opaque browser cookie and a server-only PostgreSQL connection.

## Run locally

Use Node.js 22+ and pnpm. The club leaderboard reads `DATABASE_URL` from `.env.local`. Copy the example file and set that variable to a hosted Postgres connection string (Neon, Supabase, or any other Postgres host).

```sh
pnpm install
cp .env.example .env.local
pnpm db:migrate
pnpm dev --port 2424
```

Open http://127.0.0.1:2424. After `.env.local` exists, double-clicking `start.command` starts the same dev server.

`pnpm db:migrate` creates missing tables and keeps existing players and rating history. Practice still runs when the database is unset; the club API then reports that the database is not configured.

`pnpm build` then `pnpm preview` serves a production build. Serve `dist/` over HTTP. Opening that HTML with `file://` cannot start the module worker.

## Rules and keys

Each starting card is an integer from **1–13**. Merge two cards using addition, subtraction, multiplication, or division. Every original card must be used exactly once and the last card must equal the target. Fractional, negative, and zero intermediates are allowed; division by zero is rejected.

- Select the first card, select an operation, then select the second card.
- `1`, `2`, … select the remaining cards from left to right. With 9 cards, the keys are `1–9`; with 3 remaining, they are `1–3`. `0` is unused.
- `+` adds, `-` subtracts, `*` multiplies, and `/` divides.
- `U` or Backspace undoes. Escape clears your selection or closes History.
- `R` deals another round using the saved **Keep cards / Keep target** preferences.
- **Reattempt this hand** resets the exact current puzzle. History's **Redo** restores that problem and mode.

The result stays at the leftmost of the two selected cards. After each merge, every remaining card is renumbered from left to right; undo restores the previous board and numbering. For subtraction/division, **selection order determines operand order**, even if the result ends up on a different side. Hard mode shows expression stacks instead of calculating their displayed value. Revealing the solution marks the attempt assisted.

Settings apply to the next deal. Increasing card count resets the target limit to its maximum. The target limit is `min(13^cardCount, 10,000)`; this is an upper bound, not a claim that every number below it can be reached. The game chooses a target with a verified full-card solution. If retained cards/target conflict with new settings, the game keeps the current round and explains the constraint.

## Solver and performance

All game and solution arithmetic uses normalized **BigInt rational numbers**. Generated rounds include an exact expression-tree witness, verified before display. Work happens in a dedicated Web Worker to keep input responsive.

Ordinary rounds draw fresh card values independently from 1–13 using the browser's native random source. There is no fixed opening target or preset hand list. For 2–4 cards, the engine enumerates the hand's reachable rational values and randomly selects among its distinct positive integer targets in your range. For 5–9 cards, it samples 64 random expression trees for that hand, then randomly selects a distinct verified target. It avoids repeating the previous target when another verified choice exists. A hand with no verified target in range is redrawn; it is never replaced with a canned fallback hand.

Targets are constrained by reachability and are not uniformly distributed over all integers from 1 to the limit. **Keep cards** and **Keep target** intentionally constrain randomness; a locked target may use constructive expression search to obtain a verified hand. Exact reattempts and history redo intentionally reproduce the saved puzzle. Explicit seeds are used only in reproducible automated tests. Search deduplicates equivalent rational states and stops at a valid full-card solution. Large searches run with a time budget and distinguish an unfinished search from a proof that a combination is impossible.

**Give me a hint** reveals one suggested operation, without its result or the rest of the solution. The hint engine first checks whether the verified witness can be continued from your current merged cards. If your moves took a different route, it searches the remaining rational-valued cards for a complete continuation and suggests only its first move. It reports a dead end only after exhausting the search; on a time limit, it suggests undoing or reattempting rather than claiming impossibility. **Show solution** is a separate action for the full worked answer. Both mark the attempt assisted. Any valid player expression reaching the target with all cards wins; it does not have to match the example solution.

Historical records save the verified expression tree so replay does not depend on finding it again. The most recent 200 attempts and preferences are stored in this browser's localStorage. Clearing site data removes that local history. The timer measures elapsed wall time, including time spent reviewing hints/history; completed attempts stop the timer.



## Verify

```sh
pnpm test
pnpm build
```

## Club identities and permanent ratings

Choose a unique 3–20 character club name. Everyone starts at **1000**. Names are case insensitive and stay reserved permanently. A random 256-bit browser cookie remembers your player for a year and is renewed on return. The cookie is HttpOnly, SameSite=Lax and Secure in production; only its SHA-256 hash is stored in PostgreSQL. Clearing the cookie means choosing a new unused name; there is no password or name-based recovery. Existing profiles and rating history remain on the leaderboard.

Ranked rounds are issued and checked on the server. Every merge, undo, useful hint, reveal and finish is recorded against the authenticated active run. Server timestamps determine elapsed time. Refresh resumes the active run without a penalty. Transactions lock the player row, record each change in an append-only ledger, and update the leaderboard together. Idempotent request receipts prevent duplicate points; run revisions reject stale actions from other tabs. The full solution stays server-side until explicitly revealed or the round is complete. This supports casual competition; browser cookies cannot prevent multiple identities or the use of external solvers.

Your rating and rank update immediately after your action. Other players refresh every five seconds while the page is visible. The progress view shows the permanent rating ledger, including individual penalties. Older entries can be paged without deleting history.

## Rating policy

All Elo values are integers. Positive rewards require `clamp(ceil(2 + 7 * (exp(clamp(R,0,3000)/1500)-1)/(exp(2)-1)), 2, 9)` cards: 2 at 0, 3 at 500, 4 at 1000, 6 at 2000, 8 at 2700, 9 at 3000. Fewer cards can only maintain or lose rating. Difficulty estimates remain provisional.

Completion rewards decay exponentially with elapsed/reference time. A time penalty grows linearly, reaching 10% of the abandonment penalty at three reference times. Long completed rounds can lose at most that time penalty; hints remain additional charges. Assisted rounds earn no positive reward. Hints cost `ceil(0.003*R)`; abandonment/reveal costs `round(R*clamp(.05+(R-1000)/60000,.02,.10))`. Reveal followed by abandonment avoids duplicate charges. Fast clean streak bonuses remain capped at 10%.

## Database

Leaderboard data lives in hosted PostgreSQL. This repository includes the schema in `db/schema.sql` and leaves out the database files and credentials. `.env.local`, other `.env` files except `.env.example`, and `.data/` are gitignored.

`DATABASE_URL` is the club database. `DATABASE_TEST_URL` is optional and must name a separate database ending in `_test`. `pnpm test` runs arithmetic, rating-policy, and PostgreSQL API tests. Test cleanup is limited to that `_test` database.

For offline work on one machine, `pnpm db:local` can create a PostgreSQL 17 cluster in `.data/postgres` on `127.0.0.1:54324`. That directory is gitignored. On a Mac that does not already have PostgreSQL 17, install it with `brew install postgresql@17`. Hosted `DATABASE_URL` is the setup this repo expects.
