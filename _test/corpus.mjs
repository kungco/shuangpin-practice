import assert from 'node:assert/strict';
import {ALL_CHARS,PHRASES,PASSAGES} from '../src/data/pinyin.js';
import {EXPANSION_PHRASES,EXPANSION_PASSAGES} from '../src/data/practice-expansion.js';
import {PASSAGE_FOCI} from '../src/data/material-options.js';
import {generateQuestions,annotatePassage,phrasePool,passagePool} from '../src/core/questions.js';
import {primarySplit,splitSyllable} from '../src/core/scheme.js';
import * as S from '../src/core/storage.js';

assert.equal(EXPANSION_PHRASES.length,120);
assert.equal(EXPANSION_PASSAGES.length,40);
assert.equal(new Set(PHRASES.map(p=>p.w)).size,PHRASES.length);
assert.equal(new Set(PASSAGES.map(p=>p.t)).size,PASSAGES.length);
for(const p of PHRASES){
 assert.equal(Array.from(p.w).length,p.p.length,p.w);
 p.p.forEach(py=>assert(splitSyllable(py).length,`${p.w}: ${py}`));
 for(const ch of p.w)assert(ALL_CHARS[ch],`Missing character ${ch}`);
}
for(const p of PASSAGES){
 if(p.p)assert.equal(Array.from(p.t).length,p.p.length,p.title||p.t);
 const raw=annotatePassage(p.t,p.p);
 assert(raw.every(c=>c.punct||c.syl),`Missing reading in ${p.title||p.t}`);
 for(const ch of p.t)if(/\p{Script=Han}/u.test(ch))assert(ALL_CHARS[ch],`Missing passage character ${ch}`);
 if(p.hanCount)assert.equal(raw.filter(c=>!c.punct).length,p.hanCount);
}
for(const category of ['chat','office-sentence']){
 const pool=phrasePool({phraseCategory:category,phraseLength:'5+'});
 assert.equal(pool.length,60);
 const questions=generateQuestions({mode:'phrase',phraseCategory:category,phraseLength:'5+',count:60,seed:42});
 assert.equal(new Set(questions.map(q=>q.text)).size,60);
 assert(questions.every(q=>q.meta.category===category));
}
const medium=passagePool({passageLength:'medium'}),long=passagePool({passageLength:'long'});
assert.equal(medium.length,20);assert.equal(long.length,10);
assert(long.every(p=>p.hanCount>=350));
for(const topic of ['daily','office','travel','learning']){
 const context={};
 for(let batch=0;batch<4;batch++){
  const questions=generateQuestions({mode:'passage',passageTopic:topic,passageLength:'long',count:7,context,seed:batch+1});
  assert.equal(questions.length,7);
  assert(questions.every(q=>q.meta.topic===topic&&q.meta.hanCount>=350));
 }
}
assert.deepEqual(generateQuestions({mode:'passage',passageTopic:'targeted',passageLength:'long',count:3}),[]);
const targets={
 'an-ang':['an','ang'],'en-eng-ing':['en','eng','ing'],'in-ing':['in','ing'],
 'ian-iang':['ian','iang'],'uan-uang':['uan','uang'],'ong-iong':['ong','iong'],'ui-iu-un':['ui','iu','un']
};
for(const [focus] of PASSAGE_FOCI.filter(v=>v[0]!=='all')){
 const pool=passagePool({passageTopic:'targeted',passageFocus:focus});assert.equal(pool.length,1);
 const p=pool[0],parts=p.p.filter(Boolean).map(primarySplit);
 for(const target of targets[focus]||[])assert(parts.filter(s=>s.yun===target).length>=2,`${focus} lacks ${target}`);
 if(focus==='zh-ch-sh')for(const s of ['zh','ch','sh'])assert(parts.filter(p=>p.sheng===s).length>=2);
 if(focus==='zero')assert(parts.filter(p=>p.zero).length>=5);
 if(focus==='umlaut'){assert(parts.some(p=>p.yun==='v'));for(const s of ['j','q','x'])assert(parts.some(p=>p.sheng===s));}
 const q=generateQuestions({mode:'passage',passageTopic:'targeted',passageFocus:focus,count:4,seed:9});
 assert(q.every(item=>item.meta.focus===focus&&item.meta.unknownCount===0));
}
for(const [word,want] of [['重新','chong xin'],['重复','chong fu'],['几行','ji hang'],['行李','xing li'],['长出','zhang chu'],['还书','huan shu'],['薄薄','bao bao'],['出差','chu chai']]){
 const matches=EXPANSION_PASSAGES.filter(p=>p.t.includes(word));assert(matches.length,`Unused reading example ${word}`);
 for(const p of matches){let start=p.t.indexOf(word);while(start>=0){assert.equal(p.p.slice(start,start+word.length).join(' '),want,`${p.title}: ${word}`);start=p.t.indexOf(word,start+word.length);}}
}
const exam=generateQuestions({mode:'exam',count:100,seed:13});
assert(exam.filter(q=>q.meta.examPart==='phrase').every(q=>Array.from(q.text).length<=4));
const stored=new Map();
globalThis.window={localStorage:{getItem:k=>stored.get(k)??null,setItem:(k,v)=>stored.set(k,String(v)),removeItem:k=>stored.delete(k)}};
S.saveSettings({...S.DEFAULT_SETTINGS,phraseCategory:'chat',phraseLength:'5+',passageTopic:'targeted',passageLength:'short',passageFocus:'an-ang'});
let settings=S.loadSettings();assert.equal(settings.phraseCategory,'chat');assert.equal(settings.phraseLength,'5+');assert.equal(settings.passageFocus,'an-ang');
S.saveSettings({...settings,passageTopic:'invalid',passageLength:'invalid',passageFocus:'invalid'});
settings=S.loadSettings();assert.equal(settings.passageTopic,'all');assert.equal(settings.passageLength,'all');assert.equal(settings.passageFocus,'all');
console.log(`Corpus checks passed: ${Object.keys(ALL_CHARS).length} characters, ${PHRASES.length} phrases/sentences, ${PASSAGES.length} passages; 10 focus groups, filters, reading alignment, exhaustion, exam bounds and settings persistence.`);
