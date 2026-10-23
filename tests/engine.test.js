import test from 'node:test';
import assert from 'node:assert/strict';
import { rational, operate, formatValue, equalsTarget, leaf, combineNodes, solutionSteps, maxTarget, generatePuzzle, validatePuzzle, findHint } from '../src/engine.js';

function verify(puzzle) {
  assert.equal(validatePuzzle(puzzle.cards,puzzle.target,puzzle.solution),true);
  const seen = [];
  function walk(node) {
    if (!node.left) {
      assert.equal(node.ids.length,1); const index = node.ids[0];
      assert.equal(node.card,puzzle.cards[index]); seen.push(index);
      assert.deepEqual(node.value,rational(puzzle.cards[index])); return node.value;
    }
    const a = walk(node.left), b = walk(node.right), result = operate(a,b,node.op);
    assert.deepEqual(node.value,result); return result;
  }
  assert.equal(equalsTarget(walk(puzzle.solution),puzzle.target),true);
  assert.deepEqual(seen.sort((a,b)=>a-b),puzzle.cards.map((_,i)=>i));
  assert.doesNotThrow(()=>JSON.stringify(puzzle));
}

test('rational arithmetic is reduced, signed, exact, and serializable', () => {
  assert.deepEqual(rational(6,-8),{n:'-3',d:'4'});
  assert.deepEqual(operate(rational(1,3),rational(1,6),'+'),rational(1,2));
  assert.deepEqual(operate(rational('9007199254740993'),rational(1),'+'),rational('9007199254740994'));
  assert.equal(formatValue(rational(4,3)),'4/3');
  assert.throws(()=>operate(rational(1),rational(0),'/'),/zero/);
  assert.throws(()=>combineNodes(leaf(3,0),leaf(3,0),'+'),/once/);
});

test('fraction-only 3,3,8,8 solution uses every actual card once', () => {
  const puzzle = generatePuzzle({count:4,keepCards:true,keepTarget:true,cards:[3,3,8,8],target:24});
  verify(puzzle); assert.equal(puzzle.optimal,false);
  assert.ok(puzzle.solution.fractions>0); assert.equal(solutionSteps(puzzle.solution).length,3);
  assert.ok(solutionSteps(puzzle.solution).some(step=>step.result.includes('/')));
});

test('exhaustive small-hand search distinguishes impossibility', () => {
  assert.throws(()=>generatePuzzle({count:2,keepCards:true,keepTarget:true,cards:[1,1],target:3}),/cannot make/);
  assert.throws(()=>generatePuzzle({count:2,keepTarget:true,target:168}),/No 2-card hand/);
  const possible = generatePuzzle({count:2,keepTarget:true,target:169}); verify(possible);
  assert.deepEqual(possible.cards,[13,13]);
});

test('every supported count generates a verified puzzle inside its mathematical cap', () => {
  assert.deepEqual(Array.from({length:8},(_,i)=>maxTarget(i+2)),[169,2197,10000,10000,10000,10000,10000,10000]);
  for (let count=2;count<=9;count++) {
    const puzzle = generatePuzzle({count,seed:100+count}); verify(puzzle);
    assert.equal(puzzle.cards.length,count); assert.ok(puzzle.target>=1 && puzzle.target<=maxTarget(count));
    assert.equal(puzzle.optimal,false);
  }
});

test('ordinary deals have broad card and target variety without a fixed 24 target', () => {
  const hands = new Set(), targets = new Set(), values = new Set(); let twentyFours = 0;
  for (let seed = 0; seed < 300; seed++) {
    const puzzle = generatePuzzle({ count: 4, seed }); verify(puzzle);
    hands.add(puzzle.cards.join(',')); targets.add(puzzle.target);
    puzzle.cards.forEach(value => values.add(value));
    if (puzzle.target === 24) twentyFours++;
  }
  assert.ok(hands.size > 280);
  assert.ok(targets.size > 120);
  assert.equal(values.size, 13);
  assert.ok(twentyFours < 15);
});

test('live unseeded deals use native random entropy', () => {
  const original = globalThis.crypto.getRandomValues; let calls = 0;
  globalThis.crypto.getRandomValues = function (buffer) { calls++; return original.call(this, buffer); };
  try { verify(generatePuzzle({ count: 4 })); assert.ok(calls >= 5); }
  finally { globalThis.crypto.getRandomValues = original; }
});

test('retention modes preserve cards, target, and both as requested', () => {
  const first = generatePuzzle({count:4,seed:2});
  const hand = generatePuzzle({count:4,keepCards:true,cards:first.cards,target:first.target,seed:3});
  assert.deepEqual(hand.cards,first.cards); assert.notEqual(hand.target,first.target); verify(hand);
  const target = generatePuzzle({count:4,keepTarget:true,target:24,seed:4});
  assert.equal(target.target,24); verify(target);
  const both = generatePuzzle({count:4,keepCards:true,keepTarget:true,cards:first.cards,target:first.target});
  assert.deepEqual(both.cards,first.cards); assert.equal(both.target,first.target); verify(both);
});

test('a locked target produces varied card multisets across seeds', () => {
  const hands = new Set();
  for (let seed=0;seed<8;seed++) {
    const puzzle = generatePuzzle({count:4,keepTarget:true,target:24,seed}); verify(puzzle);
    hands.add(puzzle.cards.slice().sort((a,b)=>a-b).join(','));
  }
  assert.ok(hands.size>=4);
  const old = generatePuzzle({count:4,keepTarget:true,target:24,seed:1});
  const next = generatePuzzle({count:4,keepTarget:true,target:24,cards:old.cards,seed:1});
  assert.notDeepEqual(next.cards.slice().sort((a,b)=>a-b),old.cards.slice().sort((a,b)=>a-b));
});

test('locked targets near cap receive constructive witnesses with five through nine cards', () => {
  for (const count of [5,6,7,8,9]) {
    const puzzle = generatePuzzle({count,keepTarget:true,target:9973});
    assert.equal(puzzle.target,9973); verify(puzzle);
  }
  verify(generatePuzzle({count:9,keepTarget:true,target:10000}));
});

test('nine-card generation remains bounded and worker-transferable', () => {
  const start = performance.now(); const puzzle = generatePuzzle({count:9,seed:91}); verify(puzzle);
  assert.ok(performance.now()-start<3000); assert.equal(puzzle.optimal,false);
  assert.match(puzzle.searchNote,/Verified with exact arithmetic/);
  assert.deepEqual(structuredClone(puzzle),puzzle);
});

const boardFor = cards => cards.map((value,i)=>({...leaf(value,i),slot:i,key:String(i+1)}));
function applyHint(nodes,hint) {
  assert.equal(hint.status,'move');
  const a=nodes.find(n=>n.slot===hint.move.a), b=nodes.find(n=>n.slot===hint.move.b);
  assert.ok(a&&b&&a!==b);
  const merged={...combineNodes(a,b,hint.move.op),slot:Math.min(a.slot,b.slot),key:a.slot<b.slot?a.key:b.key};
  return [...nodes.filter(n=>n!==a&&n!==b),merged].sort((a,b)=>a.slot-b.slot).map((node,i)=>({...node,key:String(i+1)}));
}

test('one-step hints solve the fractional hand without exposing a full expression', () => {
  const puzzle=generatePuzzle({count:4,keepCards:true,keepTarget:true,cards:[3,3,8,8],target:24});
  let nodes=boardFor(puzzle.cards);
  while(nodes.length>1) {
    const hint=findHint({nodes,target:24,witness:puzzle.solution});
    assert.ok(!hint.text.includes('=')&&!hint.text.includes(puzzle.solution.expr));
    nodes=applyHint(nodes,hint);
  }
  assert.ok(equalsTarget(nodes[0].value,24));
});

test('hints accept valid alternate branches incompatible with the stored witness', () => {
  const cards=[2,3,4,6], original=boardFor(cards);
  const witness=combineNodes(combineNodes(original[0],original[1],'*'),combineNodes(original[3],original[2],'-'),'*'); // 12
  // An alternate first merge 2+4=6 still reaches12: (2+4)+3+6−3 is
  // unavailable, but (2+4)×(6÷3)=12 uses exactly the remaining nodes.
  const merged={...combineNodes(original[0],original[2],'+'),slot:0,key:'1'};
  let nodes=[merged,original[1],original[3]];
  while(nodes.length>1) nodes=applyHint(nodes,findHint({nodes,target:12,witness}));
  assert.ok(equalsTarget(nodes[0].value,12));
});

test('hints report a proven dead end and immediately use a nine-card witness', () => {
  assert.equal(findHint({nodes:boardFor([1,1]),target:3}).status,'dead-end');
  const puzzle=generatePuzzle({count:9,keepTarget:true,target:9973,seed:71});
  const start=performance.now();
  const hint=findHint({nodes:boardFor(puzzle.cards),target:puzzle.target,witness:puzzle.solution});
  assert.equal(hint.status,'move'); assert.ok(performance.now()-start<100);
  const after=applyHint(boardFor(puzzle.cards),hint);
  assert.equal(findHint({nodes:after,target:puzzle.target,witness:puzzle.solution}).status,'move');
});

test('target limit and retained settings are validated explicitly', () => {
  assert.throws(()=>generatePuzzle({count:2,maxTarget:170}),/between 1 and 169/);
  assert.throws(()=>generatePuzzle({count:4,maxTarget:10,keepTarget:true,target:24}),/retained target/);
  assert.throws(()=>generatePuzzle({count:4,keepCards:true,cards:[1,2]}),/Retained cards/);
  verify(generatePuzzle({count:9,maxTarget:1,seed:31}));
});

test('validation rejects forged cards, indices, operations, and claimed arithmetic', () => {
  const puzzle = generatePuzzle({count:4,keepCards:true,keepTarget:true,cards:[3,3,8,8],target:24});
  const badLeaf = leaf(24,0); badLeaf.ids = [0,1,2,3];
  assert.throws(()=>validatePuzzle(puzzle.cards,24,badLeaf),/leaf/);
  const wrongValue = structuredClone(puzzle.solution); wrongValue.value = rational(25);
  assert.throws(()=>validatePuzzle(puzzle.cards,24,wrongValue),/arithmetic/);
  const wrongIds = structuredClone(puzzle.solution); wrongIds.ids = [1,2,3,4];
  assert.throws(()=>validatePuzzle(puzzle.cards,24,wrongIds),/indices/);
  const forged = combineNodes(leaf(4,0),leaf(6,1),'*');
  assert.throws(()=>validatePuzzle([3,8],24,forged),/dealt card|arithmetic/);
  const duplicate = structuredClone(puzzle.solution);
  duplicate.right = duplicate.left;
  assert.throws(()=>validatePuzzle(puzzle.cards,24,duplicate),/repeats|once/);
  const badOp = structuredClone(puzzle.solution); badOp.op = '**';
  assert.throws(()=>validatePuzzle(puzzle.cards,24,badOp),/supported/);
  const cyclic = structuredClone(puzzle.solution); cyclic.left = cyclic;
  assert.throws(()=>validatePuzzle(puzzle.cards,24,cyclic),/repeats|large/);
  const huge = structuredClone(puzzle.solution); huge.value.n = '9'.repeat(10000);
  assert.throws(()=>validatePuzzle(puzzle.cards,24,huge),/rational/);
});
