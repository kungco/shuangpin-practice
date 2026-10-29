import {generateQuestions,questionFromPhrase,makeRng,shuffle} from './questions.js';
import {CHAT_SCENES} from '../data/chat-scenes.js';
import {cleanQueue,DEFAULT_QUEUE} from './playlist.js';
export {CHAT_SCENES};
export {cleanQueue,DEFAULT_QUEUE};

export const ZEN_PRESETS = [
 {id:'ease',name:'轻松练',caption:'12 个常用字 · 完整提示 · 不限时',detail:'先让手指找到感觉，不用赶时间。',mode:'char',count:12,charTier:'1',durationSec:0,trainingPolicy:'full'},
 {id:'focus',name:'专注练',caption:'一篇短文 · 逐步撤掉提示 · 不限时',detail:'把注意力交给眼前这一段文字。',mode:'passage',count:1,passageLength:'short',durationSec:0,trainingPolicy:'progressive'},
 {id:'challenge',name:'挑战练',caption:'10 条日常词语 · 独立输入 · 最多 2 分钟',detail:'给自己一点挑战；卡住时仍可主动求助。',mode:'phrase',count:10,phraseCategory:'daily',phraseLength:'all',durationSec:120,trainingPolicy:'independent'}
];
export const PLAYLIST_TRACKS = [
 {id:'warmup',name:'指尖热身',type:'单字',note:'10 个常用字，慢慢进入状态',mode:'char',count:10,charTier:'1'},
 {id:'chat',name:'聊点日常',type:'聊天句子',note:'4 条日常表达，练习连续输入',mode:'phrase',count:4,phraseCategory:'chat',phraseLength:'5+'},
 {id:'office',name:'工作小节拍',type:'办公句子',note:'4 条办公表达，让沟通更顺手',mode:'phrase',count:4,phraseCategory:'office-sentence',phraseLength:'5+'},
 {id:'reading',name:'读一小段',type:'短文',note:'一篇短文，让手感连起来',mode:'passage',count:1,passageLength:'short'}
];
export function normalizeExperience(raw){
 if(!raw || typeof raw!=='object')return null;
 if(raw.kind==='zen' && ZEN_PRESETS.some(p=>p.id===raw.id))return {kind:'zen',id:raw.id};
 if(raw.kind==='chat' && CHAT_SCENES.some(p=>p.id===raw.id))return {kind:'chat',id:raw.id};
 if(raw.kind==='playlist' && cleanQueue(raw.tracks).length)return {kind:'playlist',tracks:cleanQueue(raw.tracks),title:String(raw.title||'我的练习歌单').slice(0,24),randomOrder:raw.randomOrder===true};
 return null;
}
const base={weakBoost:false,phraseCategory:'all',phraseLength:'all',passageTopic:'all',passageLength:'all',passageFocus:'all',charTier:'1'};
export function buildExperience(raw, {seed=Date.now(), randomOrder=false, recentByMode={}}={}){
 const experience=normalizeExperience(raw);
 if(!experience)throw Error('请选择可用的训练内容');
 if(experience.kind==='zen'){
  const preset=ZEN_PRESETS.find(p=>p.id===experience.id);
  return {experience,mode:preset.mode,questions:generateQuestions({...base,...preset,seed,recent:recentByMode[preset.mode]}),options:{durationSec:preset.durationSec,trainingPolicy:preset.trainingPolicy,modeName:'一页留白 · '+preset.name}};
 }
 if(experience.kind==='chat'){
  const scene=CHAT_SCENES.find(s=>s.id===experience.id);
  const questions=scene.turns.map((turn,index)=>{
   const q=questionFromPhrase(turn.reply,turn.p);
   if(!q)throw Error('对话材料不可用');
   q.label='你的回复';q.meta={...q.meta,studioTurn:index,studioScene:scene.id};return q;
  });
  return {experience,mode:'phrase',questions,options:{durationSec:0,trainingPolicy:'progressive',modeName:'聊天剧场 · '+scene.title}};
 }
 experience.randomOrder=randomOrder||experience.randomOrder;
 if(experience.randomOrder)experience.tracks=shuffle(experience.tracks,makeRng(seed));
 const questions=experience.tracks.flatMap((id,index)=>{
  const track=PLAYLIST_TRACKS.find(t=>t.id===id);
  return generateQuestions({...base,...track,seed:(Number(seed)+index)>>>0,recent:recentByMode[track.mode]}).map((q,item)=>({...q,meta:{...q.meta,studioMode:track.mode,studioTrack:index,studioTrackId:id,studioTrackItem:item}}));
 });
 return {experience,mode:'mix',questions,options:{durationSec:0,trainingPolicy:'progressive',modeName:'练习歌单 · '+experience.title}};
}
