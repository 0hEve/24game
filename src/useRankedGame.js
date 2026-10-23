import {minimumRatedCards} from '../server/rating.js';
import {useCallback,useEffect,useRef,useState} from 'react';
import {useGame as usePracticeGame} from './useGame.js';
import {useClub} from './useClub.js';
const HISTORY='24club.server-attempts.v1';
const readHistory=()=>{try{return JSON.parse(localStorage.getItem(HISTORY))||[];}catch{return [];}};
export function useGame(){
 const club=useClub();
 const [localPractice,setLocalPractice]=useState(false);
 const serverMode=Boolean(club.player)&&!localPractice;
 const practice=usePracticeGame({enabled:!serverMode});
 const minimumCards=club.player?minimumRatedCards(club.player.rating):2;
 useEffect(()=>{if(practice.settings.count<minimumCards)practice.setCount(minimumCards);},[minimumCards,practice.settings.count]);
 const [run,setRun]=useState(null),[selected,setSelected]=useState(null),[operator,setOperator]=useState(null);
 const [pending,setPending]=useState(false),[merging,setMerging]=useState(null),[error,setError]=useState(null);
 const [elapsed,setElapsed]=useState(0),[historyOpen,setHistoryOpen]=useState(false),[solutionOpen,setSolutionOpen]=useState(false);
 const [hintOpen,setHintOpen]=useState(false),[hintText,setHintText]=useState('');
 const [serverHistory,setServerHistory]=useState(readHistory);
 const current=useRef({});current.current={club,practice,run,selected,operator,pending,merging,serverMode,historyOpen,solutionOpen};
 const busy=useRef(false),initialized=useRef(null),logged=useRef(new Set(serverHistory.map(r=>r.id)));
 useEffect(()=>{try{localStorage.setItem(HISTORY,JSON.stringify(serverHistory));}catch{}},[serverHistory]);
 const record=useCallback(r=>{
  if(!r||r.status==='active'||logged.current.has(r.id))return;
  logged.current.add(r.id);
  const tree=r.solution?.tree||(r.status==='completed'?r.board?.[0]:null);
  const row={id:r.id,serverRunId:r.id,cards:r.cards,target:r.target,settings:r.settings,elapsed:Math.max(0,new Date(r.finishedAt)-new Date(r.startedAt)),status:r.status==='completed'?'completed':'retried',assisted:Boolean(r.hintCount||r.revealed),at:r.finishedAt||new Date().toISOString(),solution:tree?.expr||'',witness:tree||undefined,ranked:r.ranked,delta:r.delta};
  setServerHistory(previous=>[row,...previous].slice(0,200));
 },[]);
 const apply=useCallback(data=>{
  record(data.previousRun);
  const next=data.run||data.activeRun;
  if(next){setRun(next);record(next);setElapsed(Math.max(0,new Date(next.finishedAt||Date.now())-new Date(next.startedAt)));}
  return next;
 },[record]);
 const action=useCallback(async(name,payload={})=>{
  if(busy.current)return null;
  busy.current=true;setPending(true);setError(null);
  try{
   const r=current.current.run;
   const data=await current.current.club.request(name,{...(r?{runId:r.id,expectedRevision:r.revision}:{}),...payload});
   apply(data);return data;
  }catch(err){setError(err.message);await current.current.club.refresh();throw err;}
  finally{busy.current=false;setPending(false);setMerging(null);}
 },[apply]);
 useEffect(()=>{
  if(!club.ready||!club.player||initialized.current===club.player.id)return;
  initialized.current=club.player.id;setLocalPractice(false);
  if(club.activeRun)apply({run:club.activeRun});
  else action('start',{settings:{...practice.settings,count:Math.max(practice.settings.count,minimumCards),keepCards:false,keepTarget:false}}).catch(()=>{});
 },[club.ready,club.player?.id,apply,action]);
 useEffect(()=>{
  const active=club.activeRun;
  if(serverMode&&active&&!busy.current&&(!run||active.id!==run.id||(active.revision??0)>(run.revision??0)))apply({run:active});
 },[club.activeRun,serverMode,run,apply]);
 useEffect(()=>{
  if(!serverMode||!run||run.status!=='active')return;
  const update=()=>setElapsed(Math.max(0,Date.now()-new Date(run.startedAt).getTime()));update();
  const timer=setInterval(update,100);return()=>clearInterval(timer);
 },[run?.id,run?.status,serverMode]);
 const clearSelection=useCallback(()=>{setSelected(null);setOperator(null);},[]);
 const clearHelp=useCallback(()=>{setHintOpen(false);setHintText('');setSolutionOpen(false);clearSelection();},[clearSelection]);
 const deal=useCallback(()=>{
  const s=current.current;if(!s.serverMode&&!s.club.player){s.practice.deal();return;}
  if(busy.current)return;setLocalPractice(false);clearHelp();action('start',{settings:{...s.practice.settings,count:Math.max(s.practice.settings.count,minimumRatedCards(s.club.player.rating))}}).catch(()=>{});
 },[action,clearHelp]);
 const reattempt=useCallback(()=>{
  const s=current.current;if(!s.serverMode){s.practice.reattempt();return;}
  if(!s.run||busy.current)return;clearHelp();action('start',{settings:s.run.settings,replayRunId:s.run.id}).catch(()=>{});
 },[action,clearHelp]);
 const redo=useCallback(record=>{
  const s=current.current;
  if(s.club.player&&record.serverRunId){setLocalPractice(false);clearHelp();action('start',{settings:record.settings,replayRunId:record.serverRunId}).then(()=>setHistoryOpen(false)).catch(()=>{});}
  else if(s.serverMode&&s.run?.status==='active'){action('abandon').then(()=>{setLocalPractice(true);s.practice.redo(record);setHistoryOpen(false);}).catch(()=>{});}
  else{if(s.club.player)setLocalPractice(true);s.practice.redo(record);setHistoryOpen(false);}
 },[action,clearHelp]);
 const chooseOperator=useCallback(op=>{
  const s=current.current;if(!s.serverMode)return s.practice.chooseOperator(op);
  if(!busy.current&&s.run?.status==='active'&&s.selected!==null)setOperator(op);
 },[]);
 const chooseCard=useCallback(slot=>{
  const s=current.current;if(!s.serverMode)return s.practice.chooseCard(slot);
  if(busy.current||s.run?.status!=='active')return;
  if(s.selected===null||!s.operator){setSelected(s.selected===slot?null:slot);return;}
  if(s.selected===slot){clearSelection();return;}
  setHintOpen(false);setHintText('');
  const source=Math.max(s.selected,slot),destination=Math.min(s.selected,slot);
  if(!matchMedia('(prefers-reduced-motion: reduce)').matches){
   const from=document.querySelector(`[data-testid="card-${source}"]`)?.closest('.card-slot');const to=document.querySelector(`[data-testid="card-${destination}"]`)?.closest('.card-slot');
   if(from&&to){const a=from.getBoundingClientRect(),b=to.getBoundingClientRect();from.animate([{transform:'translate(0,0)',opacity:1},{transform:`translate(${b.left-a.left}px,${b.top-a.top}px) scale(.88)`,opacity:0}],{duration:280,easing:'ease-in-out'});}
  }
  setMerging({from:source,to:destination,op:s.operator});clearSelection();
  action('move',{a:s.selected,b:slot,op:s.operator}).catch(()=>{});
 },[action,clearSelection]);
 const undo=useCallback(()=>{
  const s=current.current;if(!s.serverMode)return s.practice.undo();
  if(busy.current||s.run?.status!=='active'||!s.run.canUndo)return;
  clearHelp();action('undo').catch(()=>{});
 },[action,clearHelp]);
 const requestHint=useCallback(()=>{
  const s=current.current;if(!s.serverMode)return s.practice.requestHint();
  if(busy.current||s.run?.status!=='active')return;
  clearSelection();setHintOpen(true);setHintText('Finding a move from your current cards…');
  action('hint').then(data=>{if(data)setHintText(data.hint?.text||'Try another route.');}).catch(err=>setHintText(err.message));
 },[action,clearSelection]);
 const toggleSolution=useCallback(()=>{
  const s=current.current;if(!s.serverMode)return s.practice.toggleSolution();
  if(busy.current||!s.run)return;
  if(s.solutionOpen){setSolutionOpen(false);return;}
  if(s.run.solution){setSolutionOpen(true);return;}
  action('solution').then(data=>{if(data){setSolutionOpen(true);setRun(previous=>({...previous,solution:data.solution||data.run?.solution}));}}).catch(()=>{});
 },[action]);
 useEffect(()=>{
  if(!serverMode)return;
  const onKey=event=>{
   if(event.ctrlKey||event.metaKey||event.altKey||event.repeat||event.target?.isContentEditable||['INPUT','TEXTAREA','SELECT'].includes(event.target?.tagName))return;
   if(document.querySelector('[aria-modal="true"]'))return;
   const key=event.key.toLowerCase(),s=current.current;
   if(key==='escape'){clearSelection();setHistoryOpen(false);return;}
   if(s.historyOpen)return;
   if(key==='r'){event.preventDefault();deal();}
   else if(key==='u'||key==='backspace'){event.preventDefault();undo();}
   else if(['+','-','*','/'].includes(key)){event.preventDefault();chooseOperator(key);}
   else if(/^[1-9]$/.test(key)){const card=s.run?.board?.[Number(key)-1];if(card){event.preventDefault();chooseCard(card.slot);}}
  };document.addEventListener('keydown',onKey);return()=>document.removeEventListener('keydown',onKey);
 },[serverMode,deal,undo,chooseCard,chooseOperator,clearSelection]);
 const combinedHistory=[...serverHistory,...practice.history].sort((a,b)=>new Date(b.at)-new Date(a.at)).slice(0,200);
 if(!serverMode)return {...practice,club,minimumCards,history:combinedHistory,redo,deal,reattempt};
 const completed=run?.status==='completed';
 const rating=club.player?.rating??1000;
 const penaltyPreview=run?.ranked&&run.status==='active'?Math.max(0,(rating>0?Math.max(1,Math.round(rating*Math.min(.10,Math.max(.02,.05+(rating-1000)/60000)))):0)-(run.penaltyPaid||0)):0;
 const hintPenaltyPreview=run?.ranked&&run.status==='active'?Math.max(1,Math.ceil(3*rating/1000)):0;
 const round=run?{...run,startedAt:new Date(run.startedAt).getTime(),solution:run.solution,ranked:run.ranked}:null;
 return {...practice,club,minimumCards,penaltyPreview,hintPenaltyPreview,round,board:run?.board||[],selected,operator,merging,loading:pending||!run,error,elapsed,completed,assisted:Boolean(run?.hintCount||run?.revealed),moves:run?.moves||[],canUndo:Boolean(run?.canUndo&&!completed&&!pending),history:combinedHistory,historyOpen,setHistoryOpen,solutionOpen,toggleSolution,hintOpen,hintText,hintLoading:pending&&hintOpen,requestHint,chooseCard,chooseOperator,undo,clearSelection,deal,reattempt,redo,message:run?.ranked?`Rated · New problem / reveal: −${penaltyPreview}. Hint: −${hintPenaltyPreview}.`:'Practice round · no rating changes.',dismissError:()=>{setError(null);club.clearError();}};
}
