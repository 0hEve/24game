import { useCallback, useEffect, useRef, useState } from 'react';
import { combineNodes, equalsTarget, formatValue, leaf, maxTarget as targetCap, validatePuzzle } from './engine.js';

const SETTINGS_KEY = '24club.settings.v1';
const HISTORY_KEY = '24club.history.v1';
const DEFAULTS = { count: 4, maxTarget: 10000, hard: false, keepCards: false, keepTarget: false };
function readStorage(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Private mode/storage quotas must not prevent play. */ }
}
function sanitizeSettings(value) {
  const count = Math.min(9, Math.max(2, Math.trunc(Number(value?.count) || 4)));
  return {
    count, maxTarget: Math.min(targetCap(count), Math.max(1, Math.trunc(Number(value?.maxTarget) || targetCap(count)))),
    hard: value?.hard === true, keepCards: value?.keepCards === true, keepTarget: value?.keepTarget === true,
  };
}
function validHistory(value) {
  return Array.isArray(value) ? value.filter(r => r && typeof r.id === 'string' && Array.isArray(r.cards)
    && r.cards.length >= 2 && r.cards.length <= 9 && r.cards.every(v => Number.isInteger(v) && v >= 1 && v <= 13)
    && Number.isInteger(r.target) && r.target >= 1 && r.target <= targetCap(r.cards.length)
    && Number.isFinite(r.elapsed) && r.elapsed >= 0 && ['completed', 'retried'].includes(r.status))
    .slice(0, 200).map(r => ({ ...r, settings: sanitizeSettings(r.settings) })) : [];
}
export function formatTime(milliseconds = 0) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
export function cardHotkey(index) { return String(index + 1); }
function makeBoard(cards) { return cards.map((value, slot) => ({ ...leaf(value, slot), slot, key: cardHotkey(slot, cards.length) })); }

export function useGame({ enabled = true } = {}) {
  const [settings, setSettings] = useState(() => sanitizeSettings(readStorage(SETTINGS_KEY, DEFAULTS)));
  const [history, setHistory] = useState(() => validHistory(readStorage(HISTORY_KEY, [])));
  const [round, setRound] = useState(null);
  const [board, setBoard] = useState([]);
  const [selected, setSelected] = useState(null);
  const [operator, setOperator] = useState(null);
  const [merging, setMerging] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState('Select a card, an operation, then another card.');
  const [elapsed, setElapsed] = useState(0);
  const [completed, setCompleted] = useState(false);
  const [assisted, setAssisted] = useState(false);
  const [moves, setMoves] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [solutionOpen, setSolutionOpen] = useState(false);
  const [hintOpen, setHintOpen] = useState(false);
  const [hintText, setHintText] = useState('');
  const [hintLoading, setHintLoading] = useState(false);
  const state = useRef({});
  state.current = { settings, history, round, board, selected, operator, merging, loading, completed, assisted, moves, snapshots, historyOpen, solutionOpen, hintLoading };
  const workerRef = useRef(null);
  const cancelSearch = useRef(null);
  const mergeTimer = useRef(null);
  const generation = useRef(0);
  const logged = useRef(new Set());
  const hintWorker = useRef(null);
  const hintTimeout = useRef(null);
  const hintGeneration = useRef(0);
  const resetHint = useCallback(() => {
    hintGeneration.current++;
    clearTimeout(hintTimeout.current);
    hintWorker.current?.terminate();
    hintWorker.current = null;
    setHintOpen(false);
    setHintText('');
    setHintLoading(false);
  }, []);

  useEffect(() => writeStorage(SETTINGS_KEY, settings), [settings]);
  useEffect(() => writeStorage(HISTORY_KEY, history), [history]);
  useEffect(() => {
    if (!enabled || !round || completed) return;
    const update = () => setElapsed(Date.now() - round.startedAt);
    update();
    const timer = setInterval(update, 100);
    return () => clearInterval(timer);
  }, [round, completed, enabled]);

  const archive = useCallback((status, snapshot = state.current, elapsedOverride) => {
    const r = snapshot.round;
    if (!r || logged.current.has(r.id)) return;
    logged.current.add(r.id);
    const record = {
      id: r.id, cards: r.cards, target: r.target, settings: r.settings,
      elapsed: elapsedOverride ?? Math.max(0, Date.now() - r.startedAt), status,
      assisted: snapshot.assisted, at: new Date().toISOString(), solution: r.solution.expr,
      witness: r.solution, optimal: r.optimal, searchNote: r.searchNote,
    };
    setHistory(previous => [record, ...previous].slice(0, 200));
  }, []);

  const start = useCallback(async (options, nextSettings, knownSolution) => {
    const token = ++generation.current;
    resetHint();
    cancelSearch.current?.();
    cancelSearch.current = null;
    workerRef.current?.terminate();
    clearTimeout(mergeTimer.current);
    setMerging(null);
    setLoading(true);
    setError(null);
    setSelected(null);
    setOperator(null);
    let timeout;
    try {
      const puzzle = knownSolution || await new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./solver.worker.js', import.meta.url), { type: 'module' });
        workerRef.current = worker;
        cancelSearch.current = () => { worker.terminate(); reject(new Error('Search cancelled.')); };
        timeout = setTimeout(() => { worker.terminate(); reject(new Error('This search is taking too long. Try a new hand or a wider target range. Your current round is preserved.')); }, 20000);
        worker.onmessage = event => {
          if (event.data.id !== token) return;
          if (event.data.error) reject(new Error(typeof event.data.error === 'string' ? event.data.error : event.data.error.message));
          else resolve(event.data.result);
        };
        worker.onerror = event => reject(new Error(event.message || 'The solver could not start. Please try again.'));
        worker.postMessage({ id: token, type: 'generate', options });
      });
      if (token !== generation.current) return;
      // Verify the supplied witness before making this a playable round.
      validatePuzzle(puzzle?.cards, puzzle?.target, puzzle?.solution);
      archive('retried');
      const r = { ...puzzle, id: crypto.randomUUID(), settings: { ...nextSettings }, startedAt: Date.now() };
      setRound(r);
      setBoard(makeBoard(puzzle.cards));
      setMoves([]);
      setSnapshots([]);
      setElapsed(0);
      setCompleted(false);
      setAssisted(false);
      setSolutionOpen(false);
      setHistoryOpen(false);
      setMessage('Select a card, an operation, then another card.');
    } catch (failure) {
      if (token === generation.current) setError(failure.message);
    } finally {
      clearTimeout(timeout);
      if (token === generation.current) { workerRef.current?.terminate(); workerRef.current = null; cancelSearch.current = null; setLoading(false); }
    }
  }, [archive, resetHint]);

  useEffect(() => {
    if (!enabled) return;
    const initial = state.current.settings;
    start({ count: initial.count, maxTarget: initial.maxTarget, keepCards: false, keepTarget: false }, initial);
    return () => { generation.current++; hintGeneration.current++; clearTimeout(hintTimeout.current); hintWorker.current?.terminate(); cancelSearch.current?.(); workerRef.current?.terminate(); clearTimeout(mergeTimer.current); };
  }, [start, enabled]);

  const updateSettings = useCallback(patch => setSettings(previous => sanitizeSettings({ ...previous, ...patch })), []);
  const setCount = useCallback(count => setSettings(previous => ({ ...previous, count, maxTarget: targetCap(count) })), []);
  const deal = useCallback(() => {
    const s = state.current;
    if (s.loading || s.merging) return;
    const sameCount = s.round?.cards.length === s.settings.count;
    const options = { ...s.settings, keepCards: s.settings.keepCards && sameCount, cards: s.round?.cards, target: s.round?.target, witness: s.round?.solution };
    const preserved = options.keepCards && options.keepTarget && s.round.target <= options.maxTarget ? s.round : undefined;
    start(options, s.settings, preserved);
  }, [start]);
  const reattempt = useCallback(() => {
    const s = state.current;
    if (!s.round || s.loading || s.merging) return;
    start({}, s.round.settings, s.round);
  }, [start]);
  const redo = useCallback(record => {
    const s = state.current;
    if (s.loading || s.merging) return;
    const restoredSettings = sanitizeSettings({ ...record.settings, count: record.cards.length, maxTarget: Math.max(record.target, record.settings?.maxTarget || record.target) });
    setSettings(restoredSettings);
    const known = record.witness ? { cards: record.cards, target: record.target, solution: record.witness, optimal: record.optimal, searchNote: record.searchNote } : undefined;
    start({ count: record.cards.length, maxTarget: restoredSettings.maxTarget, keepCards: true, keepTarget: true, cards: record.cards, target: record.target }, restoredSettings, known);
  }, [start]);
  const clearSelection = useCallback(() => { setSelected(null); setOperator(null); }, []);
  const chooseOperator = useCallback(op => {
    const s = state.current;
    if (s.loading || s.completed || s.merging) return;
    if (s.selected === null) { setMessage('Pick your first card, then an operation.'); return; }
    setOperator(op);
    setMessage('Now select the second card. Your first card is the left operand.');
  }, []);
  const chooseCard = useCallback(slot => {
    const s = state.current;
    if (s.loading || s.completed || s.merging) return;
    const nextCard = s.board.find(card => card.slot === slot);
    if (!nextCard) return;
    if (s.selected === null || !s.operator) {
      setSelected(s.selected === slot ? null : slot);
      setMessage('Choose an operation: +, −, ×, or ÷.');
      return;
    }
    if (s.selected === slot) { clearSelection(); return; }
    const first = s.board.find(card => card.slot === s.selected);
    let merged;
    try {
      merged = combineNodes(first, nextCard, s.operator);
    } catch (failure) {
      setError(failure.message || 'You cannot divide by zero.');
      return;
    }
    const survivor = Math.min(first.slot, nextCard.slot);
    const removed = Math.max(first.slot, nextCard.slot);
    merged = { ...merged, slot: survivor, key: cardHotkey(survivor, s.round.cards.length) };
    resetHint();
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduceMotion) {
      const source = document.querySelector(`[data-testid="card-${removed}"]`)?.closest('.card-slot');
      const destination = document.querySelector(`[data-testid="card-${survivor}"]`)?.closest('.card-slot');
      if (source && destination) {
        const a = source.getBoundingClientRect(), b = destination.getBoundingClientRect();
        source.animate([{ transform: 'translate(0, 0)', opacity: 1 },
          { transform: `translate(${b.left - a.left}px, ${b.top - a.top}px) scale(.88)`, opacity: 0 }],
        { duration: 280, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' });
      }
    }
    setMerging({ from: removed, to: survivor, op: s.operator });
    setSelected(null);
    setOperator(null);
    mergeTimer.current = setTimeout(() => {
      const newBoard = [...s.board.filter(card => card.slot !== first.slot && card.slot !== nextCard.slot), merged]
        .sort((a, b) => a.slot - b.slot)
        .map((card, index) => ({ ...card, key: cardHotkey(index) }));
      setSnapshots(previous => [...previous, { board: s.board, moves: s.moves }]);
      setBoard(newBoard);
      setMoves(previous => [...previous, { expr: merged.expr, result: formatValue(merged.value), op: s.operator }]);
      setMerging(null);
      if (newBoard.length === 1) {
        if (equalsTarget(merged.value, s.round.target)) {
          const duration = Date.now() - s.round.startedAt;
          setElapsed(duration);
          setCompleted(true);
          setMessage('You made it. Every card, one answer.');
          archive('completed', { ...s, assisted: state.current.assisted }, duration);
        } else {
          setMessage(s.round.settings.hard ? 'That is not the target. Undo a move and try another route.' : `${formatValue(merged.value)} is not ${s.round.target}. Undo a move and try another route.`);
        }
      } else setMessage(`Merged. ${newBoard.length} cards left. Keep going.`);
    }, reduceMotion ? 0 : 280);
  }, [archive, clearSelection, resetHint]);
  const undo = useCallback(() => {
    const s = state.current;
    if (s.loading || s.completed || s.merging || !s.snapshots.length) return;
    const previous = s.snapshots[s.snapshots.length - 1];
    setBoard(previous.board);
    setMoves(previous.moves);
    setSnapshots(s.snapshots.slice(0, -1));
    resetHint();
    clearSelection();
    setError(null);
    setMessage('Move undone. Try a different combination.');
  }, [clearSelection, resetHint]);
  const requestHint = useCallback(() => {
    const s = state.current;
    if (!s.round || s.loading || s.merging || s.completed || s.hintLoading) return;
    const id = ++hintGeneration.current;
    hintWorker.current?.terminate();
    setAssisted(true);
    setHintLoading(true);
    setHintOpen(true);
    setSelected(null);
    setOperator(null);
    setHintText('Finding a move from your current cards…');
    const worker = new Worker(new URL('./solver.worker.js', import.meta.url), { type: 'module' });
    hintWorker.current = worker;
    const timeout = setTimeout(() => {
      worker.terminate();
      if (id === hintGeneration.current) { setHintLoading(false); setHintText('This route needs a longer search. Undo a move or reattempt the hand to get a hint from the verified route.'); }
    }, 3000);
    hintTimeout.current = timeout;
    const finish = text => {
      clearTimeout(timeout);
      worker.terminate();
      if (id !== hintGeneration.current) return;
      hintWorker.current = null;
      setHintLoading(false);
      setHintText(text);
    };
    worker.onmessage = event => {
      if (event.data.id !== id) return;
      finish(event.data.error || event.data.result?.text || 'Undo a move to return to the verified route, then ask for another hint.');
    };
    worker.onerror = () => finish('The hint search could not start. Please try again.');
    worker.postMessage({ id, type: 'hint', options: { nodes: s.board, target: s.round.target, witness: s.round.solution } });
  }, []);
  const toggleSolution = useCallback(() => {
    if (!state.current.round || state.current.loading || state.current.merging) return;
    if (!state.current.solutionOpen) setAssisted(true);
    setSolutionOpen(value => !value);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const onKey = event => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
      const tag = event.target?.tagName;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag) || event.target?.isContentEditable) return;
      const s = state.current;
      const key = event.key.toLowerCase();
      if (document.querySelector('[aria-modal="true"]') && key !== 'escape') return;
      if (key === 'escape') { setHistoryOpen(false); clearSelection(); return; }
      if (s.historyOpen) return;
      const operations = { '+': '+', '-': '-', '*': '*', '/': '/' };
      if (key === 'r') { event.preventDefault(); deal(); }
      else if (key === 'u' || key === 'backspace') { event.preventDefault(); undo(); }
      else if (operations[key]) { event.preventDefault(); chooseOperator(operations[key]); }
      else if (/^[1-9]$/.test(key) && s.round) {
        const card = s.board[Number(key) - 1];
        if (!card) return;
        event.preventDefault(); chooseCard(card.slot);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [chooseCard, chooseOperator, clearSelection, deal, undo, enabled]);

  return { settings, updateSettings, setCount, round, board, selected, operator, merging, loading,
    error, message, elapsed, completed, assisted, moves, canUndo: snapshots.length > 0 && !completed && !loading && !merging,
    history, historyOpen, setHistoryOpen, solutionOpen, toggleSolution, hintOpen, hintText, hintLoading, requestHint, chooseCard, chooseOperator,
    undo, clearSelection, deal, reattempt, redo, dismissError: () => setError(null) };
}
