export const PLAYLIST_IDS=['warmup','chat','office','reading'];
export const DEFAULT_QUEUE=['warmup','chat','reading'];
export function cleanQueue(value){
  return Array.isArray(value)?[...new Set(value)].filter(id=>PLAYLIST_IDS.includes(id)).slice(0,4):DEFAULT_QUEUE.slice();
}
export function normalizePlaylist(raw){
  if(!raw || typeof raw!=='object' || Array.isArray(raw))return null;
  return {title:String(raw.title||'我的练习歌单').slice(0,24),tracks:cleanQueue(raw.tracks),
    randomOrder:raw.randomOrder===true,updatedAt:Math.max(0,Math.min(8640000000000000,Number(raw.updatedAt)||0))};
}
