import assert from 'node:assert/strict';
import {ZEN_PRESETS,PLAYLIST_TRACKS,CHAT_SCENES,buildExperience,normalizeExperience,cleanQueue} from '../src/core/experiences.js';
import {PracticeEngine,STATE} from '../src/core/engine.js';
import * as S from '../src/core/storage.js';
const memory=new Map();
globalThis.window={setInterval,clearInterval,localStorage:{getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)}};
const valid=questions=>questions.forEach(q=>{assert(q.chars.length);assert(q.chars.every(c=>c.punct||c.syl),q.text);});
const complete=eng=>{
 let guard=10000;
 while(eng.state===STATE.RUNNING&&guard--){
  const target=eng.currentTarget();assert(target);
  const result=eng.pressKey(String(target.keys[target.pos]).toLowerCase());assert(result.correct);
 }
 assert(guard>0);assert(eng.summary().completed);assert.equal(eng.summary().accuracy,100);
 eng.destroy();
};
for(const preset of ZEN_PRESETS){
 const run=buildExperience({kind:'zen',id:preset.id},{seed:19});valid(run.questions);
 const eng=new PracticeEngine({questions:run.questions,mode:run.mode,...run.options});eng.start();complete(eng);
}
for(const scene of CHAT_SCENES){
 const run=buildExperience({kind:'chat',id:scene.id});valid(run.questions);
 assert.deepEqual(run.questions.map(q=>q.text),scene.turns.map(t=>t.reply));
 for(let i=0;i<scene.turns.length;i++)assert.equal(run.questions[i].meta.studioTurn,i);
 const eng=new PracticeEngine({questions:run.questions,mode:run.mode,...run.options});eng.start();
 // Save after the first key of the second reply, then restore the exact conversation and input position.
 while(eng.index===0){const t=eng.currentTarget();eng.pressKey(t.keys[t.pos]);}
 const t=eng.currentTarget();eng.pressKey(t.keys[t.pos]);eng.pause();
 const saved=eng.exportResume();saved.studio=run.experience;S.saveResume(saved);
 const stored=S.loadResume();assert.deepEqual(normalizeExperience(stored.studio),run.experience);
 assert.equal(stored.index,1);assert.equal(stored.keyIndex,1);
 const resumed=PracticeEngine.restore(stored);assert(resumed);eng.destroy();resumed.start();
 if(resumed.state===STATE.PAUSED)resumed.resume();complete(resumed);
}
const queue=PLAYLIST_TRACKS.map(t=>t.id);
const playlist=buildExperience({kind:'playlist',tracks:queue,title:'测试歌单'},{seed:41});valid(playlist.questions);
assert.equal(playlist.questions.length,19);
assert.deepEqual([...new Set(playlist.questions.map(q=>q.meta.studioTrackId))],queue);
assert.deepEqual(playlist.questions.slice(10,14).map(q=>q.meta.category),Array(4).fill('chat'));
assert.deepEqual(playlist.questions.slice(14,18).map(q=>q.meta.category),Array(4).fill('office-sentence'));
assert.equal(playlist.questions.at(-1).kind,'passage');
const eng=new PracticeEngine({questions:playlist.questions,mode:playlist.mode,...playlist.options});
eng.start();complete(eng);
const randomized=buildExperience({kind:'playlist',tracks:queue},{seed:41,randomOrder:true});
assert.deepEqual(randomized.experience.tracks.slice().sort(),queue.slice().sort());
assert.deepEqual(cleanQueue(['chat','chat','<bad>','reading']),['chat','reading']);
assert.equal(normalizeExperience({kind:'playlist',tracks:[]}),null);
assert.equal(normalizeExperience({kind:'chat',id:'missing'}),null);
assert.equal(normalizeExperience({kind:'zen',id:'missing'}),null);
assert.throws(()=>buildExperience({kind:'playlist',tracks:[]}));
assert.deepEqual(CHAT_SCENES[0].turns[1].p.slice(0,2),['xian','qu']);
console.log('Experience checks passed: 3 zen presets, 3 complete chat scenes with mid-reply resume, ordered/shuffled mixed playlists, input validation and 100% engine completion.');
