// All arithmetic stays exact. Strings keep rational values transferable to workers.
const gcd = (a, b) => { a = a < 0n ? -a : a; while (b) [a, b] = [b, a % b]; return a; };
export function rational(n, d = 1) {
  n = BigInt(n); d = BigInt(d);
  if (!d) throw new Error('Cannot divide by zero.');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d); return { n: String(n / g), d: String(d / g) };
}
export function operate(a, b, op) {
  const an = BigInt(a.n), ad = BigInt(a.d), bn = BigInt(b.n), bd = BigInt(b.d);
  if (op === '+') return rational(an * bd + bn * ad, ad * bd);
  if (op === '-') return rational(an * bd - bn * ad, ad * bd);
  if (op === '*') return rational(an * bn, ad * bd);
  if (op === '/') return rational(an * bd, ad * bn);
  throw new Error('Unknown operation.');
}
export const formatValue = q => q.d === '1' ? q.n : `${q.n}/${q.d}`;
export const equalsTarget = (q, target) => BigInt(q.n) === BigInt(target) * BigInt(q.d);
export const maxTarget = count => Math.min(13 ** count, 10000);
const key = q => `${q.n}/${q.d}`;
const symbols = { '+': '+', '-': '−', '*': '×', '/': '÷' };
export function leaf(value, index) {
  return { value: rational(value), expr: String(value), ids: [index], cost: 0,
    divisions: 0, fractions: 0, negatives: 0, depth: 0, depthCost: 0, card: value };
}
export function combineNodes(a, b, op) {
  if (a.ids.some(id => b.ids.includes(id))) throw new Error('A card can only be used once.');
  const value = operate(a.value, b.value, op);
  const divisions = a.divisions + b.divisions + Number(op === '/');
  const fractions = a.fractions + b.fractions + Number(value.d !== '1');
  const negatives = a.negatives + b.negatives + Number(BigInt(value.n) < 0n);
  const depth = 1 + Math.max(a.depth, b.depth);
  const depthCost = a.depthCost + b.depthCost + a.ids.length + b.ids.length;
  return { value, expr: `(${a.expr} ${symbols[op]} ${b.expr})`, ids: [...a.ids, ...b.ids],
    left: a, right: b, op, divisions, fractions, negatives, depth, depthCost,
    cost: 0 };
}
export function solutionSteps(node) {
  const steps = [];
  function visit(n) { if (!n.left) return; visit(n.left); visit(n.right);
    steps.push({ a: formatValue(n.left.value), b: formatValue(n.right.value), op: symbols[n.op],
      result: formatValue(n.value), expr: n.expr }); }
  visit(node); return steps;
}
// Treat saved witnesses as untrusted data. Recompute the complete expression
// from the dealt cards rather than accepting a claimed root result.
export function validatePuzzle(cards, target, solution) {
  const invalid = detail => { throw new Error(`Invalid puzzle witness: ${detail}`); };
  if (!Array.isArray(cards) || cards.length < 2 || cards.length > 9
    || cards.some(n => !Number.isInteger(n) || n < 1 || n > 13)) invalid('cards must contain 2–9 values from 1 to 13.');
  if (!Number.isInteger(target) || target < 1 || target > maxTarget(cards.length)) invalid('the target is outside the permitted range.');
  let visited = 0; const seen = new Set(), references = new Set();
  function claimedValue(node) {
    const q = node.value;
    // Bounds also prevent pathological BigInt input from a corrupted save.
    if (!q || typeof q.n !== 'string' || typeof q.d !== 'string' || q.n.length > 100 || q.d.length > 100
      || !/^-?\d+$/.test(q.n) || !/^\d+$/.test(q.d)) invalid('a node has an invalid rational value.');
    try { return rational(q.n,q.d); } catch { invalid('a denominator is zero.'); }
  }
  function walk(node) {
    if (++visited > cards.length * 2 - 1 || !node || typeof node !== 'object' || references.has(node)) invalid('the expression tree is too large or repeats a node.');
    references.add(node);
    const claimed = claimedValue(node);
    if (!Array.isArray(node.ids) || !node.ids.length || node.ids.length > cards.length || node.ids.some(id => !Number.isInteger(id) || id < 0 || id >= cards.length)
      || new Set(node.ids).size !== node.ids.length) invalid('card indices must be distinct valid positions.');
    let actual, ids;
    if (!node.left && !node.right) {
      if (node.op !== undefined || node.ids.length !== 1) invalid('a leaf must use exactly one card.');
      const id = node.ids[0];
      if (seen.has(id)) invalid('a card was used more than once.');
      seen.add(id); actual = rational(cards[id]); ids = [id];
      if (node.card !== undefined && node.card !== cards[id]) invalid('a leaf does not match its dealt card.');
    } else {
      if (!node.left || !node.right || !['+','-','*','/'].includes(node.op)) invalid('an operation needs two children and a supported operator.');
      const a = walk(node.left), b = walk(node.right); ids = [...a.ids,...b.ids];
      try { actual = operate(a.value,b.value,node.op); } catch { invalid('an operation divides by zero.'); }
    }
    if (key(actual) !== key(claimed)) invalid('a claimed value does not match the exact arithmetic.');
    if (node.ids.length !== ids.length || node.ids.some(id => !ids.includes(id))) invalid('a node lists the wrong card positions.');
    return { value: actual, ids };
  }
  const result = walk(solution);
  if (seen.size !== cards.length || result.ids.length !== cards.length) invalid('the expression must use every card exactly once.');
  if (!equalsTarget(result.value,target)) invalid('the expression does not reach the target.');
  return true;
}
function variants(a, b) {
  const out = [combineNodes(a, b, '+'), combineNodes(a, b, '*'), combineNodes(a, b, '-'), combineNodes(b, a, '-')];
  if (b.value.n !== '0') out.push(combineNodes(a, b, '/'));
  if (a.value.n !== '0') out.push(combineNodes(b, a, '/'));
  return out;
}
const cache = new Map();
const cacheKey = (cards, target) => `${cards.join(',')}:${target}`;
function remember(cards, target, solution, optimal = false) {
  const k = cacheKey(cards, target);
  cache.set(k, { solution, optimal });
  if (cache.size > 128) cache.delete(cache.keys().next().value);
  return cache.get(k);
}
// Subset dynamic programming is exhaustive for small hands, including fractions.
function reachable(cards) {
  const size = 1 << cards.length, maps = Array(size);
  for (let i = 0; i < cards.length; i++) { const n = leaf(cards[i], i); maps[1 << i] = new Map([[key(n.value), n]]); }
  for (let mask = 1; mask < size; mask++) {
    if (maps[mask]) continue;
    const results = new Map();
    for (let a = (mask - 1) & mask; a; a = (a - 1) & mask) {
      const b = mask ^ a; if (!b || a > b) continue;
      for (const x of maps[a].values()) for (const y of maps[b].values()) {
        for (const n of variants(x, y)) { const k = key(n.value), old = results.get(k);
          if (!old) results.set(k, n); }
      }
    }
    maps[mask] = results;
  }
  return maps[size - 1];
}
function searchForest(initial, target, milliseconds = 500) {
  const end = Date.now() + milliseconds, seen = new Set(); let timedOut = false;
  function visit(nodes) {
    if (Date.now() >= end) { timedOut = true; return null; }
    if (nodes.length === 1) return equalsTarget(nodes[0].value,target) ? nodes[0] : null;
    // Equal multisets of exact values have identical reachability regardless
    // of the earlier routes used to produce them.
    const state = nodes.map(n => key(n.value)).sort().join('|');
    if (seen.has(state)) return null; seen.add(state);
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const rest = nodes.filter((_, k) => k !== i && k !== j);
      for (const n of variants(nodes[i],nodes[j])) {
        const found = visit([...rest,n]);
        if (found) return found;
        if (timedOut) return null;
      }
    }
    return null;
  }
  return { solution: visit(initial), timedOut };
}
function solve(cards, target, witness) {
  const prior = cache.get(cacheKey(cards, target));
  if (witness || prior) {
    const solution = witness || prior.solution;
    validatePuzzle(cards,target,solution);
    return remember(cards,target,solution);
  }
  const {solution,timedOut} = searchForest(cards.map(leaf),target,cards.length<=4 ? Infinity : 500);
  if (!solution) throw new Error(timedOut ? 'The search time limit was reached. This does not prove the hand impossible. Unlock the cards or target to generate a verified puzzle.' : `These cards cannot make ${target} using every card. Change the target or unlock the cards.`);
  return remember(cards, target, solution);
}
export function findHint({nodes,target,witness}) {
  if (!Array.isArray(nodes) || !nodes.length || nodes.length>9) throw new Error('Hints require the current card board.');
  const signature = node => node.ids.slice().sort((a,b)=>a-b).join(',');
  const board = new Map(nodes.map(node=>[signature(node),node]));
  function frontier(tree) {
    if (!tree || typeof tree !== 'object') return null;
    const found = board.get(signature(tree));
    if (found && key(found.value)===key(tree.value)) return found;
    if (!tree.left || !tree.right) return null;
    const a = frontier(tree.left), b = frontier(tree.right);
    return a && b ? combineNodes(a,b,tree.op) : null;
  }
  function ready(tree) {
    if (!tree || board.get(signature(tree))===tree) return null;
    const left = board.get(signature(tree.left)), right = board.get(signature(tree.right));
    if (left && right && key(left.value)===key(tree.left.value) && key(right.value)===key(tree.right.value)) return {a:left,b:right,op:tree.op};
    return ready(tree.left) || ready(tree.right);
  }
  let proof;
  try { proof = witness ? frontier(witness) : null; } catch { proof = null; }
  if (proof && (!equalsTarget(proof.value,target) || signature(proof)!==nodes.flatMap(n=>n.ids).sort((a,b)=>a-b).join(','))) proof = null;
  let timedOut = false;
  if (!proof) ({solution:proof,timedOut}=searchForest(nodes,target,nodes.length<=4 ? Infinity : 500));
  if (!proof) return timedOut
    ? {status:'unknown',text:'A continuation could not be verified in time. Undo a move to return toward the sample solution.'}
    : {status:'dead-end',text:'These remaining values cannot reach the target. Undo a move and try another operation.'};
  const move = ready(proof);
  if (!move) return {status:'dead-end',text:'The target has already been reached.'};
  const {a,b,op}=move, action={'+':'Add','-':'Subtract','*':'Multiply','/':'Divide'}[op];
  const connector={'+':'and','-':'from','*':'and','/':'by'}[op];
  const values = op==='-' ? `${formatValue(b.value)} from ${formatValue(a.value)}` : `${formatValue(a.value)} ${connector} ${formatValue(b.value)}`;
  return {status:'move',move:{a:a.slot,b:b.slot,op},text:`${action} ${values}. Select card ${a.key ?? a.slot+1}, then ${op}, then card ${b.key ?? b.slot+1}.`};
}
function randomSource(seed) {
  if (seed === undefined) {
    const word = new Uint32Array(1);
    return () => { globalThis.crypto.getRandomValues(word); return word[0] / 4294967296; };
  }
  // Explicit seeds are only used by reproducible tests; live deals use crypto.
  let x = Number(seed) >>> 0;
  return () => { x += 0x6D2B79F5; let t = x; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const pick = (array, random) => array[Math.floor(random() * array.length)];
function randomWitness(cards, random) {
  const nodes = cards.map(leaf);
  while (nodes.length > 1) {
    const a = nodes.splice(Math.floor(random() * nodes.length), 1)[0];
    const b = nodes.splice(Math.floor(random() * nodes.length), 1)[0];
    const candidates = variants(a, b).filter(n => n.value.d === '1' && BigInt(n.value.n) >= 0n && BigInt(n.value.n) <= 100000n);
    nodes.push(pick(candidates, random));
  }
  return nodes[0];
}
function randomReachableTarget(cards, limit, previous, random, knownWitness) {
  const candidates = new Map();
  const add = node => {
    if (!node || node.value.d !== '1') return;
    const value = Number(node.value.n);
    if (value >= 1 && value <= limit) candidates.set(value, node);
  };
  if (cards.length <= 4) {
    // Sample distinct reachable integer targets, rather than letting values
    // with many equivalent expression trees dominate the deal distribution.
    for (const node of reachable(cards).values()) add(node);
  } else {
    // A full nine-card state space is too large. Sample independent expression
    // trees for the already drawn hand, keeping one verified witness per target.
    for (let attempt = 0; attempt < 64; attempt++) add(randomWitness(cards, random));
  }
  add(knownWitness);
  const alternatives = [...candidates.keys()].filter(value => value !== previous);
  const choices = alternatives.length ? alternatives : [...candidates.keys()];
  if (!choices.length) return null;
  const target = pick(choices, random);
  return { cards, target, witness: candidates.get(target) };
}
function relabel(node, start = 0) {
  if (!node.left) return { node: leaf(node.card, start), next: start + 1 };
  const a = relabel(node.left, start), b = relabel(node.right, a.next);
  return { node: combineNodes(a.node, b.node, node.op), next: b.next };
}
function cardsFrom(node) { return node.left ? [...cardsFrom(node.left), ...cardsFrom(node.right)] : [node.card]; }
// Catalogues contain all rational values achievable by 1, 2 or 3 freely chosen cards.
// Retaining one witness per value makes fixed-target generation fast.
const catalogues = [null];
function catalogue(count) {
  if (catalogues[count]) return catalogues[count];
  const map = new Map();
  if (count === 1) for (let v = 1; v <= 13; v++) map.set(`${v}/1`, leaf(v, 0));
  else for (let i = 1; i <= Math.floor(count / 2); i++) {
    for (const a of catalogue(i).values()) for (const b0 of catalogue(count - i).values()) {
      const b = relabel(b0, i).node;
      for (const n of variants(a, b)) { const k = key(n.value); if (!map.has(k)) map.set(k,n); }
    }
  }
  catalogues[count] = map; return map;
}
function inverseValues(t, a) {
  const result = [[operate(t,a,'-'), '+', false], [operate(t,a,'+'), '-', true], [operate(a,t,'-'), '-', false]];
  // Pair entries indicate whether the unknown subtree goes on the left.
  if (a.n !== '0') result.push([operate(t,a,'/'), '*', false], [operate(t,a,'*'), '/', true]);
  if (t.n !== '0' && a.n !== '0') result.push([operate(a,t,'/'), '/', false]);
  return result;
}
function freeWitness(count, target, random) {
  // Every integer through 9999 has a decimal Horner expression with at most
  // seven leaves; 10000 is four tens multiplied. Pad with ×1 as needed.
  if (count >= 7) {
    const constructions = [];
    if (target === 10000) constructions.push([10,10,10,10].map(leaf).reduce((a,b)=>combineNodes(a,b,'*')));
    for (let base = 2; base <= 13; base++) {
      let rest = target; const digits = [];
      while (rest) { digits.unshift(rest % base); rest = Math.floor(rest / base); }
      let node = leaf(digits[0],0);
      for (const digit of digits.slice(1)) {
        node = combineNodes(node,leaf(base,node.ids.length),'*');
        if (digit) node = combineNodes(node,leaf(digit,node.ids.length),'+');
      }
      if (node.ids.length <= count) constructions.push(node);
    }
    let node = pick(constructions, random);
    while (node.ids.length < count) {
      const i = node.ids.length;
      if (count - i >= 2 && random() < 0.65) {
        const v = 1 + Math.floor(random()*13);
        node = combineNodes(node,combineNodes(leaf(v,i),leaf(v,i+1),'-'),'+');
      } else node = combineNodes(node,leaf(1,i),'*');
    }
    return node;
  }
  const deadline = Date.now() + 1800, memo = new Map(), orders = new Map(); let expired = false;
  function order(size) {
    if (!orders.has(size)) { const values = [...catalogue(size).values()], offset = Math.floor(random()*values.length);
      orders.set(size,[...values.slice(offset),...values.slice(0,offset)]); }
    return orders.get(size);
  }
  function find(size,t,root = false) {
    if (size <= 3 && !root) return catalogue(size).get(key(t)) || null;
    const memoKey = `${size}:${key(t)}`;
    if (memo.has(memoKey)) return memo.get(memoKey);
    for (let left = Math.floor(size / 2); left >= 1; left--) {
      const right = size - left;
      for (const a of order(left)) for (const [q,op,unknownLeft] of inverseValues(t,a.value)) {
        if (count > 4 && Date.now() >= deadline) { expired = true; return null; }
        const b0 = find(right,q); if (!b0) continue;
        const b = relabel(b0,left).node;
        if (op === '/' && (unknownLeft ? a : b).value.n === '0') continue;
        const n = unknownLeft ? combineNodes(b,a,op) : combineNodes(a,b,op);
        if (key(n.value) === key(t)) return relabel(n).node;
      }
    }
    if (!expired) memo.set(memoKey,null); return null;
  }
  return find(count,rational(target),true);
}
export function generatePuzzle(options = {}) {
  const count = Number(options.count ?? 4), limit = Number(options.maxTarget ?? maxTarget(count));
  if (!Number.isInteger(count) || count < 2 || count > 9) throw new Error('Choose between 2 and 9 cards.');
  if (!Number.isInteger(limit) || limit < 1 || limit > maxTarget(count)) throw new Error(`The target limit must be between 1 and ${maxTarget(count)}.`);
  const random = randomSource(options.seed), keepCards = Boolean(options.keepCards), keepTarget = Boolean(options.keepTarget);
  let cards, target, witness;
  if (keepCards) {
    if (!Array.isArray(options.cards) || options.cards.length !== count || options.cards.some(n => !Number.isInteger(n) || n < 1 || n > 13)) throw new Error('Retained cards must match the card count and contain values from 1 to 13.');
    cards = options.cards.slice();
  }
  if (keepTarget) {
    target = Number(options.target);
    if (!Number.isInteger(target) || target < 1 || target > limit) throw new Error('The retained target must fit within the target limit.');
  }
  if (keepTarget && !keepCards) {
    witness = freeWitness(count, target, random);
    const previous = Array.isArray(options.cards) ? options.cards.slice().sort((a,b)=>a-b).join(',') : null;
    const retries = count <= 4 ? 7 : 1;
    for (let retry=0; witness && previous && retry<retries && cardsFrom(witness).sort((a,b)=>a-b).join(',') === previous; retry++) {
      const alternative = freeWitness(count,target,random);
      if (alternative) witness = alternative;
    }
    if (!witness) throw new Error(count <= 4 ? `No ${count}-card hand with values 1–13 can make ${target}. Lower the target or add cards.` : 'No witness was found within this construction. Try more cards or unlock the target; this does not prove impossibility.');
    cards = cardsFrom(witness);
  } else if (!keepTarget) {
    let fallback;
    for (let attempt = 0; attempt < 800; attempt++) {
      if (!keepCards) cards = Array.from({length: count}, () => 1 + Math.floor(random() * 13));
      const known = keepCards ? options.witness || cache.get(cacheKey(cards, options.target))?.solution : undefined;
      if (known) validatePuzzle(cards, options.target, known);
      fallback = randomReachableTarget(cards, limit, options.target, random, known);
      if (fallback || keepCards) break;
    }
    if (!fallback) {
      throw new Error('No reachable target was verified within the selected range. Increase the target limit or try another random hand.');
    } else ({cards, witness, target} = fallback);
  }
  const solved = solve(cards, target, witness);
  const repeated = !keepTarget && target === options.target ? ' No different reachable target was found; the target was retained.' : '';
  return { cards, target, solution: solved.solution, optimal: solved.optimal,
    searchNote: 'Verified with exact arithmetic; every card is used once.' + repeated };
}
