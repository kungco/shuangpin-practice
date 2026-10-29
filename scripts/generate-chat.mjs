import {readFileSync,writeFileSync} from 'node:fs';
import {pinyin} from 'pinyin-pro';
import {chatScenes} from './chat-source.mjs';
import {ALL_CHARS} from '../src/data/pinyin.js';
import {splitSyllable} from '../src/core/scheme.js';
const scenes=chatScenes.map(scene=>({...scene,turns:scene.turns.map(([incoming,reply])=>{
 const readings=pinyin(reply,{toneType:'none',type:'array'}).map(py=>py.replaceAll('ü','v'));
 if(readings.length!==Array.from(reply).length)throw Error('Unaligned reply');
 Array.from(reply).forEach((ch,i)=>{if(!ALL_CHARS[ch]||!splitSyllable(readings[i]).length)throw Error('Unknown reply character: '+ch);});
 return {incoming,reply,p:readings};
})}));
const target=new URL('../src/data/chat-scenes.js',import.meta.url);
const output='// Original, scripted conversations. Static reviewed pinyin; no network or AI service.\nexport const CHAT_SCENES = '+JSON.stringify(scenes,null,2)+';\n';
if(process.argv.includes('--check')){if(readFileSync(target,'utf8').replaceAll('\r\n','\n')!==output)throw Error('聊天材料与原文不一致，请重新生成并复核。');}
else writeFileSync(target,output);
console.log('Generated 3 conversations / 15 replies.');
