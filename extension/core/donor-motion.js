// Animace odznaku dárce (port artifacts/donor-badges-v2/unitychat-donor-motion-v4/motion-v4.js do ES modulu).
// `motionSvg(id, { duration, strength, offset, once, phase, uid })` vrátí SVG s CSS animací (jedna časová osa),
// `phase` = statický snímek. Tempo, intenzitu a odstupy řídí core/donor-badge.js (DonorMotion). Generováno z podkladů
// (upravené jen: bez UMD obalu, zdroj SVG z donor-badge-data.js). Bez DOM.
import { DONOR_BADGE_SVG } from './donor-badge-data.js';

const CONCEPTS = { 'qr-patron': { id: 'qr-patron', name: 'QR Patron' }, 'donor-coin': { id: 'donor-coin', name: 'Mince' }, 'money-bag': { id: 'money-bag', name: 'Váček' }, 'support-card': { id: 'support-card', name: 'Karta' } };

 const defaults={duration:3,strength:1};
 const descriptions={
  'qr-patron':'Rozlet QR značek → tep srdce → složení',
  'donor-coin':'Nadhození → otočka mince → pružné dosednutí',
  'money-bag':'Výskok se zlatem → měkký dopad → odraz',
  'support-card':'Náklon → přemet karty → zacvaknutí',
 };
 const frame=(p,v={})=>({p,x:0,y:0,r:0,sx:1,sy:1,s:1,a:1,...v});
 const tracks={
  qr:[frame(0),frame(.07,{s:.93,r:-4}),frame(.2,{s:.63,r:12}),frame(.32,{s:.72,r:-9}),frame(.45,{s:.87,r:5}),frame(.58,{s:.97,r:-2}),frame(.68),frame(1)],
  coin:[frame(0),frame(.075,{y:.4,r:-8,s:.95}),frame(.15,{y:-.8,r:-14,s:.85,sx:.55}),frame(.22,{y:-1.2,r:-8,s:.84,sx:.065}),frame(.32,{y:-.7,r:8,s:.88,sx:-1}),frame(.42,{y:-.4,r:12,s:.88,sx:-.065}),frame(.53,{r:-7,s:.93}),frame(.62,{r:3,s:.97}),frame(.7),frame(1)],
  bag:[frame(0),frame(.075,{y:.8,sx:1.08,sy:.84,s:.96}),frame(.17,{y:-2.35,r:-17,sx:.9,sy:1.05,s:.73}),frame(.26,{y:-2.5,r:12,s:.7}),frame(.38,{y:-.6,r:-8,s:.83}),frame(.46,{y:1.7,sx:1.12,sy:.73,s:.94}),frame(.54,{y:-.65,r:5,sx:.94,sy:1.06,s:.85}),frame(.65,{s:.98}),frame(.73),frame(1)],
  card:[frame(0),frame(.08,{r:-7,s:.88}),frame(.17,{x:.3,y:-.6,r:15,sy:.5,s:.81}),frame(.24,{x:.5,y:-.8,r:10,sy:.065,s:.83}),frame(.34,{x:-.4,y:-.4,r:-13,sy:-1,s:.8}),frame(.44,{x:-.3,r:-8,sy:-.065,s:.88}),frame(.56,{r:7,s:.85}),frame(.65,{r:-3,s:.94}),frame(.72),frame(1)],
  heart:[frame(0),frame(.1,{s:.88}),frame(.22,{s:1.5}),frame(.3,{s:.92}),frame(.39,{s:1.3}),frame(.5),frame(1)],
 };
 const cornerTrack=(x,y,r)=>[frame(0),frame(.07),frame(.2,{x,y,r}),frame(.32,{x:x*.6,y:y*.6,r:r*.5}),frame(.45,{x:-x*.13,y:-y*.13,r:-r*.08}),frame(.58),frame(1)];
 const lerp=(a,b,t)=>a+(b-a)*t;
 function sample(points,t){if(t<=points[0].p)return points[0];for(let i=1;i<points.length;i++){if(t<=points[i].p){const a=points[i-1],b=points[i],u=(t-a.p)/(b.p-a.p);return Object.fromEntries(Object.keys(a).map(k=>[k,lerp(a[k],b[k],u)]));}}return points.at(-1);}
 const silhouettes={
  'donor-coin':'<circle cx="10" cy="10" r="9"/>',
  'money-bag':'<path d="M6 1 8 5h4l2-4-3 1-1-1-1 1ZM7 6h6l4.5 5.5c2.8 4 .9 7.5-3.5 7.5H6c-4.4 0-6.3-3.5-3.5-7.5Z"/>',
  'support-card':'<path d="M3 2.5h14q2.5 0 2.5 2.5v10q0 2.5-2.5 2.5H3Q.5 17.5.5 15V5Q.5 2.5 3 2.5ZM2 4v12h16V4Z" clip-rule="evenodd"/><rect x="3" y="9" width="4" height="4" rx=".7"/>',
 };
 const shine=[frame(0,{x:-18,a:0}),frame(.07,{x:-18,a:0}),frame(.16,{x:-7,a:.82}),frame(.45,{x:26,a:.82}),frame(.54,{x:33,a:0}),frame(1,{x:33,a:0})];
 function svg(concept,item,options={}){
  const o={...defaults,...options};
  const uid=String(o.uid||'badge').replace(/[^a-zA-Z0-9_-]/g,'');
  const amp=Math.max(0,Math.min(1.5,Number(o.strength)));
  const duration=Math.max(1.5,Number(o.duration)||3),offset=Number(o.offset)||0;
  const fixed=Number.isFinite(o.phase),phase=fixed?Math.max(0,Math.min(1,o.phase)):0;
  const rules=[],keyframes=[];
  const scaled=v=>({...v,x:v.x*amp,y:v.y*amp,r:v.r*amp,s:Math.max(.2,1+(v.s-1)*amp)});
  const transform=(v,css,ox,oy)=>css?`translate(${v.x}px,${v.y}px) rotate(${v.r}deg) scale(${v.sx*v.s},${v.sy*v.s})`:`translate(${ox+v.x} ${oy+v.y}) rotate(${v.r}) scale(${v.sx*v.s} ${v.sy*v.s}) translate(${-ox} ${-oy})`;
  function group(name,content,points,origin=[10,10],scaleStrength=true){
   const values=points.map(v=>{const z=scaleStrength?scaled(v):v;return{...z,sx:z.sx*z.s,sy:z.sy*z.s,s:1};});
   const [ox,oy]=origin;
   if(fixed){const v=sample(values,phase);return `<g data-motion="${name}" transform="${transform(v,false,ox,oy)}" opacity="${v.a}">${content}</g>`;}
   const v=values[0],cls=uid+'-'+name;
   rules.push(`.${cls}{transform-origin:${ox}px ${oy}px;transform:${transform(v,true,ox,oy)};opacity:${v.a};animation-name:${cls}}`);
   keyframes.push(`@keyframes ${cls}{${values.map(v=>`${+(v.p*100).toFixed(4)}%{transform:${transform(v,true,ox,oy)};opacity:${v.a}}`).join('')}}`);
   return `<g class="motion ${cls}" data-motion="${name}">${content}</g>`;
  }
  let raw=item.svg.replace(/^<svg[^>]*>/,'').replace(/<\/svg>\s*$/,'');
  const defs=raw.match(/<defs>([\s\S]*?)<\/defs>/)[1];raw=raw.replace(/<defs>[\s\S]*?<\/defs>/,'');
  let emblem='';
  if(item.n||item.emblem){const at=raw.lastIndexOf('<path d=');emblem=raw.slice(at);raw=raw.slice(0,at);}
  const shineGroup=group('shine','<path d="M0-5h7L-5 25h-7Z" fill="url(#sheen)"/>',shine,[0,0],false);
  const surface=`${raw}<g clip-path="url(#silhouette)">${shineGroup}</g><g class="emblem">${emblem}</g>`;
  let content='';
  if(concept.id==='donor-coin'){
   const edge=tracks.coin.map(v=>({...v,sx:1,a:Math.abs(v.sx)<.1?1:0}));
   content=group('coin-edge','<rect x="9.4" y="2" width="1.2" height="16" rx=".6" fill="url(#gold)"/>',edge)+group('coin-turn',surface,tracks.coin);
  }
  if(concept.id==='support-card'){
   const edge=tracks.card.map(v=>({...v,sy:1,a:Math.abs(v.sy)<.1?1:0}));
   content=group('card-edge','<rect x="1.7" y="9.4" width="16.6" height="1.2" rx=".6" fill="url(#gold)"/>',edge)+group('card-flip',surface,tracks.card);
  }
  if(concept.id==='money-bag'){
   const particle=(name,x,y,direction)=>group(name,`<circle cx="${x}" cy="${y}" r=".9" fill="#ffc800"/><path d="M${x} ${y-.5}v1" stroke="#9c6100" stroke-width=".35"/>`,[frame(0,{a:0,s:.3}),frame(.12,{a:0,s:.3}),frame(.22,{x:direction*.6,y:-1,a:1,s:1}),frame(.34,{x:direction*1.1,y:.5,a:1,s:.7}),frame(.43,{x:direction*.6,y:2,a:0,s:.3}),frame(1,{a:0,s:.3})],[x,y]);
   content=particle('gold-left',3,6,-1)+particle('gold-right',16.5,5,1)+group('bag-jump',surface,tracks.bag);
  }
  if(concept.id==='qr-patron'){
   const corner=(name,x,y,dx,dy,rot)=>group(name,`<path d="M${x} ${y}h5v5h-5ZM${x+1} ${y+1}v3h3v-3Z" fill="url(#gold)" fill-rule="evenodd"/><rect x="${x+2}" y="${y+2}" width="1" height="1" fill="url(#gold)"/>`,cornerTrack(dx,dy,rot),[x+2.5,y+2.5]);
   const pieces=corner('qr-tl',1,1,-3,-2.4,-100)+corner('qr-tr',14,1,3,-2.4,100)+corner('qr-bl',1,14,-3,2.5,-150);
   const dots=group('qr-pixels','<path d="M8 2h2v2H8ZM2 8h2v2H2ZM17 17h2v2h-2Z" fill="url(#gold)"/>',[frame(0),frame(.07),frame(.2,{r:90,s:.7}),frame(.38,{r:180,s:.7}),frame(.57,{r:360,s:.7}),frame(.65,{r:360}),frame(1,{r:360})],[10,10],false);
   const pulse=group('heart-beat',`<g class="emblem">${emblem}</g>`,tracks.heart,[11,11.5]);
   content=group('qr-burst',`<rect width="20" height="20" rx="2" fill="#19191e"/>${pieces}${dots}${pulse}`,tracks.qr);
  }
  const style=fixed?'':`<style>.motion{animation-duration:${duration}s;animation-iteration-count:${o.once?'1':'infinite'};animation-delay:${-offset}s;animation-timing-function:linear}${rules.join('')}${keyframes.join('')}@media(prefers-reduced-motion:reduce){.motion{animation:none!important}}</style>`;
  const result=`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" role="img" aria-label="Podporovatel · ${concept.name}">${style}<defs>${defs}<clipPath id="silhouette">${silhouettes[concept.id]||''}</clipPath><linearGradient id="sheen"><stop stop-color="#fffbea" stop-opacity="0"/><stop offset=".47" stop-color="#fffbea" stop-opacity=".25"/><stop offset=".52" stop-color="#fffbea" stop-opacity="1"/><stop offset="1" stop-color="#fffbea" stop-opacity="0"/></linearGradient></defs>${content}</svg>`;
  return result.replace(/id="(gold|silhouette|sheen)"/g,(_,id)=>`id="${uid}-${id}"`).replace(/url\(#(gold|silhouette|sheen)\)/g,(_,id)=>`url(#${uid}-${id})`);
 }
 const exportFrames=Array.from({length:55},(_,i)=>({phase:i/72,delay:i===54?750:[42,42,41][i%3]}));

/** SVG s animací (nebo statický snímek při `phase`) pro variantu `id`. */
export function motionSvg(id, options = {}) {
  const concept = CONCEPTS[id] || CONCEPTS['donor-coin'];
  return svg(concept, { svg: DONOR_BADGE_SVG[concept.id], emblem: true, n: 0 }, options);
}
export const MOTION_DEFAULTS = defaults;
export const MOTION_DESCRIPTIONS = descriptions;
