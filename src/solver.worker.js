import { generatePuzzle, findHint } from './engine.js';
self.onmessage = ({ data }) => {
  if (!['generate','hint'].includes(data?.type)) return;
  try { self.postMessage({ id: data.id, result: data.type==='hint' ? findHint(data.options) : generatePuzzle(data.options) }); }
  catch (error) { self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) }); }
};
