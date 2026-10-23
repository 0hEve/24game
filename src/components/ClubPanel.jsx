import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, Trophy, TrendingUp, X, ChevronDown, ArrowRight } from 'lucide-react';
import '../club.css';

const number = value => Math.round(Number(value ?? 0)).toLocaleString(undefined, { maximumFractionDigits: 0 });
const signed = value => {
 const points = Math.round(Number(value ?? 0));
 return `${points > 0 ? '+' : points < 0 ? '−' : ''}${number(Math.abs(points))}`;
};
function ClubModal({children, onClose}) {
 const ref = useRef(null), close = useRef(onClose), title = useId(); close.current = onClose;
 useEffect(() => {
  const previous = document.activeElement;
  const first = ref.current?.querySelector('input, button'); first?.focus();
  const key = e => {
   if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close.current(); }
   if (e.key === 'Tab') {
    const items = [...ref.current.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')];
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {e.preventDefault(); last?.focus();}
    else if (!e.shiftKey && document.activeElement === last) {e.preventDefault(); first?.focus();}
   }
  };
  document.addEventListener('keydown', key, true);
  return () => { document.removeEventListener('keydown', key, true); previous?.focus(); };
 }, []);
 return createPortal(<div className="club-backdrop" onClick={onClose}><section className="club-modal" ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={title} onClick={e=>e.stopPropagation()}><header><div><span className="club-eyebrow">A LITTLE FRIENDLY COMPETITION</span><h2 id={title}>The 24 Club <span>✦</span></h2></div><button className="club-icon" onClick={onClose} aria-label="Close leaderboard"><X size={22}/></button></header>{children}</section></div>, document.body);
}
export function RatingBadge({club}) {
 if (!club?.player) return null;
 return <span className="club-rating-badge"><TrendingUp size={14}/><b>{number(club.player.rating)}</b><span>#{number(club.player.rank)}</span>{club.player.fastStreak>0?<small>{club.player.fastStreak} fast solves</small>:null}</span>;
}
export function RatingResult({club}) {
 const result = club?.lastResult;
 if (!result) return null;
 return <div className={`club-result ${result.delta < 0 ? 'negative' : ''}`} role="status"><span className="club-result-delta">{signed(result.delta)}</span><span>{result.ranked === false ? 'Practice round' : String(result.reason ?? 'Rating change').replaceAll('_',' ')}<b>{number(result.ratingAfter ?? result.after)} rating</b></span></div>;
}
function Progress({club}) {
 const entries = club.ratingHistory ?? [];
 const points = [...entries].sort((a,b)=>new Date(a.at)-new Date(b.at));
 const values = [1000, ...points.map(p=>Number(p.rating))];
 const min = Math.min(...values)-20, max = Math.max(...values)+20;
 const x = i => 45+(i/Math.max(1,points.length-1))*470;
 const y = rating => 160-(rating-min)/(max-min)*125;
 return <div className="club-progress"><div className="club-section-heading"><h3>Your rating, over time</h3><span>Started at 1,000</span></div>{points.length ? <><svg className="club-chart" viewBox="0 0 550 195" role="img" aria-label={`Rating progress across ${points.length} recorded changes. Latest rating ${points[points.length-1].rating}.`}><line x1="45" x2="515" y1={y(1000)} y2={y(1000)} className="club-baseline"/><text x="38" y={y(1000)+4} textAnchor="end">1,000</text><text x="45" y="185">{new Date(points[0].at).toLocaleDateString(undefined,{month:'short',day:'numeric'})}</text><text x="515" y="185" textAnchor="end">{new Date(points.at(-1).at).toLocaleDateString(undefined,{month:'short',day:'numeric'})}</text><polyline points={points.map((p,i)=>`${x(i)},${y(p.rating)}`).join(' ')} className="club-chart-line"/>{points.map((p,i)=><circle key={`${p.runId ?? p.at}-${i}`} cx={x(i)} cy={y(p.rating)} r="4" className="club-chart-dot"><title>{new Date(p.at).toLocaleString()}: {p.rating} ({signed(p.delta)})</title></circle>)}</svg><ol className="club-rating-history">{[...entries].sort((a,b)=>new Date(b.at)-new Date(a.at)).map((p,i)=><li key={`${p.runId ?? p.at}-${i}`}><div><b>{String(p.reason ?? 'Rating update').replaceAll('_',' ')}</b><time dateTime={p.at}>{new Date(p.at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</time></div><span className={p.delta<0?'loss':'gain'}>{signed(p.delta)}</span><strong>{number(p.rating)}</strong></li>)}</ol>{club.historyHasMore?<button className="club-secondary club-load" onClick={()=>club.loadMoreHistory()}>Load earlier changes <ChevronDown size={15}/></button>:null}</>:<div className="club-empty"><TrendingUp size={30}/><h3>Your next chapter starts at 1,000.</h3><p>Play a rated round to begin your progress chart.</p></div>}</div>;
}
export default function ClubPanel({club}) {
 const [open,setOpen] = useState(false), [tab,setTab] = useState('board'), [name,setName] = useState(''), [busy,setBusy] = useState(false), [localError,setLocalError] = useState('');
 const inputId = useId();
 if (!club) return null;
 const player = club.player;
 const show = () => { setOpen(true); club.refresh?.(); if(player) club.loadHistory?.(); };
 const submit = async e => {e.preventDefault(); setLocalError(''); if(!/^[A-Za-z0-9_-]{3,20}$/.test(name.trim())) {setLocalError('Use 3–20 letters, numbers, underscores or hyphens.'); return;} setBusy(true); try {await club.register(name.trim());} catch(err) {setLocalError(err.message || 'Could not reserve that name. Try again.');} finally {setBusy(false);} };
 return <><section className="club-panel" aria-label="Your club rating"><div className="club-panel-heading"><span className="club-eyebrow"><Trophy size={14}/> THE CLUB</span><span className="club-live"><i/> LIVE</span></div>{!club.ready?<p className="club-muted">Getting the club ready…</p>:!club.available?<><h3>Practice is always open.</h3><p className="club-muted">Ratings are temporarily unavailable.</p></>:player?<><div className="club-player-line"><div><span className="club-player-name">{player.name}</span><div className="club-big-rating">{number(player.rating)}<small>RATING</small></div></div><span className="club-rank">#{number(player.rank)}<small>IN THE CLUB</small></span></div>{player.fastStreak>0?<p className="club-streak">✦ {player.fastStreak} fast solves <span>· bonus up to 10%</span></p>:null}<button className="club-primary" onClick={show}>Leaderboard & progress <ArrowUpRight size={17}/></button></>:<><h3>Good with numbers?<br/>Make a name for yourself.</h3><p className="club-muted">Start at 1,000. Find your place in the club.</p><button className="club-primary" onClick={show}>Join the leaderboard <ArrowUpRight size={17}/></button></>}<p className="club-provisional">Elo-inspired · provisional puzzle ratings</p></section>{open?<ClubModal onClose={()=>setOpen(false)}>{!player?<form className="club-register" onSubmit={submit}><h3>Every player starts at 1,000.</h3><p>Choose a unique name. Your next round can count.</p><label htmlFor={inputId}>Your club name</label><div className="club-name-field"><input id={inputId} autoComplete="off" maxLength={20} minLength={3} value={name} onChange={e=>{setName(e.target.value);setLocalError('');club.clearError?.();}} placeholder="e.g. number_cruncher" aria-describedby={`${inputId}-note`} required/><button className="club-primary" disabled={busy} type="submit">{busy?'Joining…':'Join the club'}<ArrowRight size={16}/></button></div><p id={`${inputId}-note`} className="club-cookie-note">Your browser remembers you with a cookie. If cleared, your name stays reserved and you’ll need a new one.</p></form>:<div className="club-modal-player"><div><span>{player.name}</span><strong>{number(player.rating)} <small>rating</small></strong></div><span className="club-rank">#{number(player.rank)}<small>IN THE CLUB</small></span></div>}{player?.fastStreak>0?<p className="club-streak">✦ {player.fastStreak} fast solves <span>· bonus up to 10%</span></p>:null}{localError||club.error?<div className="club-error" role="alert">{localError||club.error}</div>:null}<div className="club-tabs" role="tablist" aria-label="Club views"><button role="tab" id="club-board-tab" aria-selected={tab==='board'} aria-controls="club-board-panel" onClick={()=>setTab('board')}><Trophy size={16}/> Leaderboard</button><button role="tab" id="club-progress-tab" aria-selected={tab==='progress'} aria-controls="club-progress-panel" disabled={!player} onClick={()=>{setTab('progress');club.loadHistory?.();}}><TrendingUp size={16}/> Your progress</button></div><div role="tabpanel" id={`club-${tab==='board'?'board':'progress'}-panel`} aria-labelledby={`club-${tab==='board'?'board':'progress'}-tab`}>{tab==='progress'?<Progress club={club}/>:<>{club.leaderboard?.length?<div className="club-table-wrap"><table className="club-table"><thead><tr><th scope="col">Rank</th><th scope="col">Player</th><th scope="col">Rating</th><th scope="col">Games</th></tr></thead><tbody>{club.leaderboard.map(row=><tr className={row.id===player?.id?'is-you':''} key={row.id}><td><span className={row.rank<=3?'club-top-rank':''}>{row.rank===1?'♛':`#${row.rank}`}</span></td><th scope="row">{row.name}{row.id===player?.id?<small>YOU</small>:null}</th><td>{number(row.rating)}</td><td>{number(row.games)}</td></tr>)}</tbody></table></div>:<div className="club-empty"><Trophy size={30}/><h3>A fresh leaderboard.</h3><p>Join the club and make the first move.</p></div>}</>}</div><details className="club-scoring"><summary>How ratings work <ChevronDown size={15}/></summary><p>Everyone starts at 1,000. Rewards decay with time and a time penalty grows to 10% of the abandonment penalty after three reference times. Slow completions can lose points. The minimum cards for positive rewards rises on an accelerating exponential curve: 2 at 0 Elo, 3 at 500, 4 at 1,000, 6 at 2,000, 8 at 2,700 and 9 at 3,000. All 2–9 card options stay available; every dealt puzzle has a verified solution. Hints cost 0.3% of current Elo, rounded up. Abandonment and reveals use a progressive percentage of Elo (50 at 1,000; 250 at 3,000). Assisted finishes earn no reward. All rating changes are integers.</p></details></ClubModal>:null}</>;
}
