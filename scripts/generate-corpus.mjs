import {readFileSync,writeFileSync} from 'node:fs';
import {corpusSource} from './corpus-source.mjs';
import {correctContextReadings} from '../src/core/reading-fixes.js';
const check=process.argv.includes('--check');
const make=item=>Object.fromEntries(Object.entries(item).map(([k,v])=>{
  if(k!=='reading')return [k,v];
  const text=item.t||item.w, values=v.split(' ');
  if(values.length!==Array.from(text).length)throw Error('注音未与原文对齐：'+(item.title||text));
  return ['p',correctContextReadings(text,values)];
}));
const phrases=corpusSource.phrases.map(make),passages=corpusSource.passages.map(make);
const output='/** Generated from scripts/corpus-source.mjs and reviewed context readings.\n * Regenerate: npm run corpus:generate. Runtime has no pinyin dependency. */\n'
  +'export const EXPANSION_CHARS = '+JSON.stringify(corpusSource.characters,null,2)+';\n'
  +'export const EXPANSION_PHRASES = '+JSON.stringify(phrases,null,2)+';\n'
  +'export const EXPANSION_PASSAGES = '+JSON.stringify(passages,null,2)+';\n';
const target=new URL('../src/data/practice-expansion.js',import.meta.url);
if(check){if(readFileSync(target,'utf8').replaceAll('\r\n','\n')!==output)throw Error('题库与原始材料不一致，请运行 npm run corpus:generate');}
else writeFileSync(target,output);
const rows=[];
for(const p of [...phrases,...passages]){
  const text=p.t||p.w;
  for(let i=0;i<text.length;i++)if('地得着还重长行薄'.includes(text[i]))
    rows.push(`| ${p.title||text} | ${text.slice(Math.max(0,i-8),i+9)} | ${text[i]} → ${p.p[i]} |`);
}
const audit='# 材料语境读音复核表\n\n由已复核原文和语境规则生成，便于逐条检查；合法音节检查不能替代语境校对。\n\n| 材料 | 上下文 | 最终读音 |\n|---|---|---|\n'+rows.join('\n')+'\n';
const auditTarget=new URL('../docs/CORPUS-READING-AUDIT.md',import.meta.url);
if(check){if(readFileSync(auditTarget,'utf8').replaceAll('\r\n','\n')!==audit)throw Error('读音复核表需要重新生成');}
else writeFileSync(auditTarget,audit);
console.log(`Corpus ${check?'verified':'generated'}: ${phrases.length} phrases, ${passages.length} passages.`);
