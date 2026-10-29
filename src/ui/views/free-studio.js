import {ZEN_PRESETS,PLAYLIST_TRACKS,DEFAULT_QUEUE,CHAT_SCENES,cleanQueue,buildExperience,normalizeExperience} from '../../core/experiences.js';
import {loadPlaylist,savePlaylist,loadRecent,storageModeName} from '../../core/storage.js';

const escape=value=>String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const countChars=questions=>questions.reduce((sum,q)=>sum+(q.chars||[]).filter(c=>!c.punct&&c.syl).length,0);
export function createFreeStudio({start,isBusy,toast}){
 const host=document.querySelector('#freeStudio');
 if(!host)return {render(){}};
 const $=s=>host.querySelector(s);
 let kind='zen',zen='ease',scene='weekend',queue=DEFAULT_QUEUE.slice(),title='下班后的练习',randomOrder=false,prepared=null,consumed=false;
 const saved=loadPlaylist();
 if(saved){queue=saved.tracks;title=saved.title;randomOrder=saved.randomOrder;}
 host.innerHTML=`<div class="studio-heading"><div><span class="studio-eyebrow">一点时间，一点进步</span><h2>今天，想怎么练？</h2><p>选一个心情，从第一下按键开始。</p></div><span class="studio-mark" aria-hidden="true">自由<br>练习</span></div>
 <div class="studio-tabs" role="group" aria-label="自由练习玩法"><button type="button" data-studio-tab="zen" aria-pressed="true"><span>01</span> 一页留白</button><button type="button" data-studio-tab="playlist" aria-pressed="false"><span>02</span> 练习歌单</button><button type="button" data-studio-tab="chat" aria-pressed="false"><span>03</span> 聊天剧场</button></div>
 <section data-studio-pane="zen" aria-label="一页留白"><div class="studio-presets">${ZEN_PRESETS.map(p=>`<button type="button" data-zen="${p.id}" aria-pressed="${p.id===zen}"><strong>${p.name}</strong><span>${p.caption}</span><small>${p.detail}</small></button>`).join('')}</div></section>
 <section data-studio-pane="playlist" aria-label="练习歌单" hidden><div class="studio-playlist-head"><div><span class="studio-eyebrow">你的训练，有自己的顺序</span><label class="studio-title-label">歌单名称<input id="studioPlaylistTitle" maxlength="24" value="${escape(title)}" autocomplete="off"></label></div><button type="button" class="btn btn-ghost btn-sm" id="studioSavePlaylist">保存歌单</button></div><ol id="studioQueue" class="studio-queue"></ol><div id="studioTrackLibrary" class="studio-track-library"></div><label class="studio-shuffle"><input id="studioShuffle" type="checkbox"> 随机播放顺序</label><p class="studio-small" id="studioPlaylistStatus" role="status">完成一首自动进入下一首；暂停、进度保存和统计照常可用。</p></section>
 <section data-studio-pane="chat" aria-label="聊天剧场" hidden><p class="studio-small">三段有剧情的文字对话。按给定回复练双拼，打完一句，对方就会接着聊。</p><div class="studio-scenes">${CHAT_SCENES.map(s=>`<button type="button" data-scene="${s.id}" aria-pressed="${s.id===scene}"><span class="studio-avatar" aria-hidden="true">${s.badge}</span><strong>${s.title}</strong><span>${s.person} · ${s.turns.length} 轮对话</span><small>${s.intro}</small></button>`).join('')}</div></section>
 <div class="studio-preview"><div><span id="studioPreviewLabel" class="studio-eyebrow">本轮预览</span><p id="studioPreviewText"></p><small id="studioPreviewMeta"></small></div><button id="studioStart" class="btn btn-primary btn-lg" type="button">开始轻松练 →</button></div><p class="studio-footnote">聊天剧场为预设对话；歌单和练习记录保存在当前浏览器。</p>`;
 const session=document.createElement('section');session.id='studioSession';session.hidden=true;session.className='studio-session';session.setAttribute('aria-label','本轮训练场景');
 document.querySelector('#stage').before(session);
 function refreshPreview(){
  const raw=kind==='zen'?{kind,id:zen}:kind==='chat'?{kind,id:scene}:{kind,tracks:queue,title};
  if(kind==='playlist'&&!queue.length){prepared=null;$('#studioPreviewText').textContent='添加一首练习，放进你的歌单。';$('#studioPreviewMeta').textContent='歌单还没有内容';$('#studioStart').disabled=true;return;}
  prepared=buildExperience(raw,{randomOrder,recentByMode:Object.fromEntries(['char','phrase','passage'].map(m=>[m,loadRecent(m)]))});
  consumed=false;
  $('#studioStart').disabled=false;
  const first=prepared.questions[0];
  $('#studioPreviewLabel').textContent=kind==='chat'?'对方先说':kind==='playlist'?'播放顺序 · '+prepared.experience.tracks.map(id=>PLAYLIST_TRACKS.find(t=>t.id===id).name).join(' → '):'本轮文字预览';
  $('#studioPreviewText').textContent=kind==='chat'?CHAT_SCENES.find(s=>s.id===scene).turns[0].incoming:prepared.questions.slice(0,kind==='zen'&&zen==='ease'?12:1).map(q=>q.text||q.promptText).join('　');
  $('#studioPreviewMeta').textContent=`共 ${countChars(prepared.questions)} 个汉字 · ${kind==='chat'?'5 轮对话':kind==='playlist'?queue.length+' 首练习':ZEN_PRESETS.find(p=>p.id===zen).caption}`;
  $('#studioStart').textContent=kind==='chat'?'开始这段对话 →':kind==='playlist'?'播放我的歌单 →':`开始${ZEN_PRESETS.find(p=>p.id===zen).name} →`;
 }
 function renderQueue(){
  $('#studioQueue').innerHTML=queue.map((id,i)=>{
   const t=PLAYLIST_TRACKS.find(t=>t.id===id);
   return `<li><span class="studio-track-number">${String(i+1).padStart(2,'0')}</span><div><strong>${t.name}</strong><small>${t.note}</small></div><div class="studio-track-actions"><button type="button" data-move="${id}:up" aria-label="上移${t.name}" ${i===0?'disabled':''}>↑</button><button type="button" data-move="${id}:down" aria-label="下移${t.name}" ${i===queue.length-1?'disabled':''}>↓</button><button type="button" data-remove="${id}" aria-label="移除${t.name}">×</button></div></li>`;
  }).join('')||'<li class="studio-empty">歌单空了，添加一首喜欢的练习吧。</li>';
  $('#studioTrackLibrary').innerHTML=PLAYLIST_TRACKS.map(t=>`<button class="btn btn-ghost btn-sm" type="button" data-add="${t.id}" ${queue.includes(t.id)?'disabled':''}>${queue.includes(t.id)?'✓':'+'} ${t.name}</button>`).join('');
 }
 host.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button)return;
  if(button.dataset.studioTab){kind=button.dataset.studioTab;for(const b of host.querySelectorAll('[data-studio-tab]'))b.setAttribute('aria-pressed',String(b===button));for(const pane of host.querySelectorAll('[data-studio-pane]'))pane.hidden=pane.dataset.studioPane!==kind;}
  else if(button.dataset.zen){zen=button.dataset.zen;for(const b of host.querySelectorAll('[data-zen]'))b.setAttribute('aria-pressed',String(b===button));}
  else if(button.dataset.scene){scene=button.dataset.scene;for(const b of host.querySelectorAll('[data-scene]'))b.setAttribute('aria-pressed',String(b===button));}
  else if(button.dataset.add){queue=cleanQueue([...queue,button.dataset.add]);renderQueue();$('#studioPlaylistStatus').textContent='歌单已调整，点击保存可在下次继续使用。';}
  else if(button.dataset.remove){queue=queue.filter(id=>id!==button.dataset.remove);renderQueue();$('#studioPlaylistStatus').textContent='歌单已调整，点击保存可在下次继续使用。';}
  else if(button.dataset.move){const [id,dir]=button.dataset.move.split(':'),at=queue.indexOf(id),next=at+(dir==='up'?-1:1);if(next>=0&&next<queue.length){[queue[at],queue[next]]=[queue[next],queue[at]];renderQueue();$('#studioPlaylistStatus').textContent='播放顺序已调整，点击保存可在下次继续使用。';host.querySelector(`[data-move="${id}:${dir}"]`)?.focus();}}
  else if(button.id==='studioSavePlaylist'){
   savePlaylist({title,tracks:queue,randomOrder});
   $('#studioPlaylistStatus').textContent=storageModeName()==='persistent'?'歌单已保存，并纳入完整数据备份。':'歌单已保存到当前会话；请导出数据备份。';return;
  }
  else if(button.id==='studioStart'){
   if(isBusy()){toast('请先结束或保存当前练习');return;}
   if(prepared){consumed=true;start(prepared.questions,prepared.mode,{...prepared.options,studio:prepared.experience});}return;
  }else return;
  refreshPreview();
 });
 $('#studioPlaylistTitle').addEventListener('input',e=>{title=e.target.value.slice(0,24);if(prepared?.experience.kind==='playlist')prepared.experience.title=title||'我的练习歌单';});
 $('#studioShuffle').addEventListener('change',e=>{randomOrder=e.target.checked;refreshPreview();});
 $('#studioShuffle').checked=randomOrder;
 renderQueue();refreshPreview();
 let lastKey='';
 function render(engine,raw){
  const context=normalizeExperience(raw);
  document.body.classList.toggle('studio-zen',context?.kind==='zen');
  document.body.classList.toggle('studio-chat',context?.kind==='chat');
  session.hidden=!context;
  if(!context){session.replaceChildren();lastKey='';if(consumed)refreshPreview();return;}
  consumed=true;
  const key=JSON.stringify([context,engine?.index]);if(key===lastKey)return;lastKey=key;
  if(context.kind==='zen'){
   const preset=ZEN_PRESETS.find(p=>p.id===context.id);
   session.innerHTML=`<div class="studio-session-heading"><span class="studio-eyebrow">一页留白 / ${preset.name}</span><span>${preset.durationSec?'最多两分钟，按自己的节奏':'不赶时间，按自己的节奏'}</span></div>`;
  }else if(context.kind==='playlist'){
   const q=engine?.currentQuestion(),at=q?.meta?.studioTrack??context.tracks.length;
   session.innerHTML=`<div class="studio-session-heading"><strong>${escape(context.title)}</strong><span>第 ${Math.min(at+1,context.tracks.length)} / ${context.tracks.length} 首</span></div><ol class="studio-now-playing">${context.tracks.map((id,i)=>`<li class="${i===at?'is-current':i<at?'is-done':''}"><span>${i<at?'✓':String(i+1).padStart(2,'0')}</span>${PLAYLIST_TRACKS.find(t=>t.id===id).name}${i===at?'<small>正在练习</small>':''}</li>`).join('')}</ol>`;
  }else{
   const s=CHAT_SCENES.find(s=>s.id===context.id),at=Math.min(engine?.index||0,s.turns.length-1);
   const completed=s.turns.slice(Math.max(0,at-2),at);
   session.innerHTML=`<div class="studio-session-heading"><div class="studio-contact"><span class="studio-avatar" aria-hidden="true">${s.badge}</span><div><strong>${s.person}</strong><small>${s.title}</small></div></div><span>回复 ${at+1} / ${s.turns.length}</span></div><div class="studio-conversation" aria-label="已发生的对话">${completed.map(t=>`<div class="studio-message">${escape(t.incoming)}</div><div class="studio-message is-mine">${escape(t.reply)}</div>`).join('')}<div class="studio-message is-latest">${escape(s.turns[at].incoming)}</div></div><p class="studio-reply-label">你的回复 · 按下方文字输入双拼，完成后继续对话</p>`;
   const conversation=session.querySelector('.studio-conversation');
   conversation.scrollTop=conversation.scrollHeight;
  }
 }
 function syncPlaylist(){const saved=loadPlaylist();if(saved){queue=saved.tracks;title=saved.title;randomOrder=saved.randomOrder;}else{queue=DEFAULT_QUEUE.slice();title='下班后的练习';randomOrder=false;}
   $('#studioPlaylistTitle').value=title;$('#studioShuffle').checked=randomOrder;renderQueue();refreshPreview();}
 return {render,syncPlaylist};
}
