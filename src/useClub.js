import { useCallback, useEffect, useRef, useState } from 'react';

const ENDPOINT = '/api/club';
const historyEntries = data => (data.history ?? []).map(item => ({...item, at:item.at ?? item.createdAt}));
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
async function readResponse(response) {
 let data;
 try { data = await response.json(); } catch { throw new Error('The club returned an unreadable response.'); }
 if (!response.ok) {
  const error = new Error(data.error?.message || data.error || 'The club is temporarily unavailable.');
  error.status = response.status;
  throw error;
 }
 return data;
}
export function useClub() {
 const [ready,setReady] = useState(false), [available,setAvailable] = useState(true);
 const [player,setPlayer] = useState(null), [activeRun,setActiveRun] = useState(null);
 const [leaderboard,setLeaderboard] = useState([]), [ratingHistory,setRatingHistory] = useState([]);
 const [historyHasMore,setHistoryHasMore] = useState(false), [error,setError] = useState(null), [lastResult,setLastResult] = useState(null);
 const live = useRef(false), channel = useRef(null), availableRef = useRef(true), historyCursor = useRef(null), historyFlight = useRef(null);
 const applyResponse = useCallback(data => {
  if (!data || !live.current) return data;
  if (owns(data,'player')) setPlayer(data.player);
  if (owns(data,'activeRun')) setActiveRun(data.activeRun);
  if (owns(data,'leaderboard')) setLeaderboard(data.leaderboard ?? []);
  const run = data.run;
  if (data.adjustment?.delta != null) setLastResult(data.adjustment);
  else if (run && ['completed','abandoned'].includes(run.status) && run.delta != null) setLastResult(run);
  return data;
 }, []);
 const get = useCallback(async (action, params={}) => {
  const query = new URLSearchParams({action,...params});
  return readResponse(await fetch(`${ENDPOINT}?${query}`, {credentials:'same-origin',cache:'no-store'}));
 }, []);
 const markError = useCallback(err => {
  if (!live.current) return;
  if (err.status === 503) {availableRef.current = false;setAvailable(false);}
  setError(err.message || 'Could not reach the club.');
 }, []);
 const refresh = useCallback(async () => {
  const results = await Promise.allSettled([get('me'),get('leaderboard')]);
  if (!live.current) return;
  let success = false;
  for (const result of results) {
   if (result.status === 'fulfilled') { applyResponse(result.value);success = true; }
   else markError(result.reason);
  }
  if (success && !results.some(r=>r.status==='rejected'&&r.reason.status===503)) {availableRef.current=true;setAvailable(true);setError(null);}
  setReady(true);
 }, [get,applyResponse,markError]);
 const notify = useCallback(() => {
  if (channel.current) channel.current.postMessage({type:'changed'});
  else {try {localStorage.setItem('24club:changed',String(Date.now()));} catch { /* Cookies remain the identity source. */ }}
 }, []);
 const request = useCallback(async (action,payload={}) => {
  const body = JSON.stringify({...payload,action,requestId:payload.requestId || crypto.randomUUID()});
  try {
   let response;
   for(let attempt=0;attempt<2;attempt++) {
    try {response = await fetch(ENDPOINT,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body});break;}
    catch(err) {if(attempt===1) throw err;}
   }
   const data = await readResponse(response);
   if(live.current) {
    if(action==='start') setLastResult(null);
    availableRef.current=true;setAvailable(true);setError(null);applyResponse(data);
   }
   notify();
   return data;
  } catch(err) {markError(err);throw err;}
 }, [applyResponse,markError,notify]);
 const register = useCallback(name => request('register',{name}), [request]);
 const loadHistory = useCallback(async () => {
  if(historyFlight.current) return historyFlight.current;
  const operation = (async () => {
   try {
    const data = await get('history');
    if(live.current) {setRatingHistory(historyEntries(data));setHistoryHasMore(Boolean(data.hasMore));historyCursor.current=data.nextBefore ?? data.nextCursor ?? data.cursor ?? null;}
    return data;
   } catch(err) {markError(err);return null;}
  })();
  historyFlight.current=operation;
  try {return await operation;} finally {historyFlight.current=null;}
 }, [get,markError]);
 const loadMoreHistory = useCallback(async () => {
  if(historyFlight.current) return historyFlight.current;
  const cursor = historyCursor.current;
  if(!cursor) return null;
  const operation = (async () => {
   try {
    const data = await get('history',{before:cursor});
    if(live.current) {
     setRatingHistory(previous => {const seen=new Set();return [...historyEntries(data),...previous].filter(item=>{const key=item.id ?? `${item.runId ?? ''}:${item.at}:${item.reason ?? ''}`;if(seen.has(key))return false;seen.add(key);return true;}).sort((a,b)=>new Date(a.at)-new Date(b.at));});
     setHistoryHasMore(Boolean(data.hasMore));historyCursor.current=data.nextBefore ?? data.nextCursor ?? data.cursor ?? null;
    }
    return data;
   } catch(err) {markError(err);return null;}
  })();
  historyFlight.current=operation;
  try {return await operation;} finally {historyFlight.current=null;}
 }, [get,markError]);
 const clearError = useCallback(()=>setError(null),[]);
 useEffect(() => {
  live.current=true;
  let disposed=false;
  // Defer the first read so React StrictMode's discarded effect does not duplicate it.
  queueMicrotask(()=>{if(!disposed) refresh();});
  const boardTimer=setInterval(()=>{if(document.visibilityState==='visible'&&availableRef.current)get('leaderboard').then(applyResponse).catch(markError);},5000);
  const meTimer=setInterval(()=>{if(document.visibilityState==='visible'&&availableRef.current)get('me').then(applyResponse).catch(markError);},30000);
  const visible=()=>{if(document.visibilityState==='visible')refresh();};
  const storage=e=>{if(e.key==='24club:changed')refresh();};
  document.addEventListener('visibilitychange',visible);
  window.addEventListener('storage',storage);
  if(typeof BroadcastChannel!=='undefined') {const bus=new BroadcastChannel('24club');bus.onmessage=()=>refresh();channel.current=bus;}
  return()=>{disposed=true;live.current=false;clearInterval(boardTimer);clearInterval(meTimer);document.removeEventListener('visibilitychange',visible);window.removeEventListener('storage',storage);channel.current?.close();channel.current=null;};
 }, [refresh,get,applyResponse,markError]);
 return {ready,available,player,activeRun,leaderboard,ratingHistory,historyHasMore,error,lastResult,register,refresh,loadHistory,loadMoreHistory,clearError,request,applyResponse};
}
export default useClub;
