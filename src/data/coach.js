/** Every example is typed through the same scheme engine as normal practice. */
export const COACH_RULES = [
  { id: 'u-v', title: 'U / V：u、ü 和 ui', role: 'yun', parts: ['u','v','ui'],
    keys: { u:'U', v:'V', ui:'V' },
    explanation: '第二键表示韵母：u 用 U；ü 在拼音输入中写成 v，用 V；ui 也在 V。先分清读音，再选韵母键。',
    samples: [['路','lu'],['绿','lv'],['水','shui']] },
  { id: 'zh-ch-sh', title: 'zh / ch / sh：声母只占一键', role: 'sheng', parts: ['zh','ch','sh'],
    keys: { zh:'V', ch:'I', sh:'U' },
    explanation: '第一键表示声母：zh→V、ch→I、sh→U。三个声母各用一个键，不需要再补 H；第二键才是韵母。',
    samples: [['猪','zhu'],['吃','chi'],['书','shu']] },
  { id: 'an-ang', title: 'an / ang：前后鼻音', role: 'yun', parts: ['an','ang'], keys:{ an:'J', ang:'H' },
    explanation: '看清拼音有没有 g：an 在 J，ang 在 H。这里比较的是韵母键；零声母保留拼写的情况另外处理。',
    samples: [['山','shan'],['上','shang']] },
  { id: 'en-eng', title: 'en / eng：F 和 G', role: 'yun', parts: ['en','eng'], keys:{ en:'F', eng:'G' },
    explanation: '韵母 en 在 F，eng 在 G。先确认末尾有没有 g，再按对应的韵母键。',
    samples: [['真','zhen'],['正','zheng']] },
  { id: 'in-ing', title: 'in / ing：B 和 K', role: 'yun', parts: ['in','ing'], keys:{ in:'B', ing:'K' },
    explanation: '韵母 in 在 B，ing 在 K。两个韵母读音接近，键位不同；注意拼音末尾的 g。',
    samples: [['金','jin'],['井','jing']] },
  { id: 'ui-iu', title: 'ui / iu：字母顺序不同', role: 'yun', parts: ['ui','iu'], keys:{ ui:'V', iu:'Q' },
    explanation: 'ui 在 V，iu 在 Q。拼音里的字母顺序决定韵母，两个字母不能倒着记。',
    samples: [['对','dui'],['酒','jiu']] }
];
export const COACH_MAP = Object.fromEntries(COACH_RULES.map(r => [r.id,r]));
// Curated, common characters keep transfer checks away from rare or ambiguous readings.
export const COACH_CHAR_POOL = {
  u:[['努','nu'],['读','du'],['图','tu'],['湖','hu'],['苦','ku'],['服','fu']],
  v:[['女','nv'],['旅','lv'],['律','lv'],['虑','lv'],['屡','lv'],['滤','lv']],
  ui:[['回','hui'],['队','dui'],['追','zhui'],['退','tui'],['嘴','zui'],['吹','chui']],
  zh:[['知','zhi'],['中','zhong'],['张','zhang'],['真','zhen'],['主','zhu'],['找','zhao']],
  ch:[['车','che'],['出','chu'],['春','chun'],['长','chang'],['床','chuang'],['成','cheng']],
  sh:[['是','shi'],['山','shan'],['说','shuo'],['手','shou'],['少','shao'],['生','sheng']],
  an:[['三','san'],['看','kan'],['南','nan'],['反','fan'],['感','gan'],['难','nan']],
  ang:[['方','fang'],['忙','mang'],['王','wang'],['张','zhang'],['刚','gang'],['让','rang']],
  en:[['人','ren'],['门','men'],['本','ben'],['分','fen'],['深','shen'],['神','shen']],
  eng:[['生','sheng'],['灯','deng'],['风','feng'],['城','cheng'],['能','neng'],['冷','leng']],
  in:[['心','xin'],['新','xin'],['音','yin'],['品','pin'],['今','jin'],['近','jin']],
  ing:[['明','ming'],['听','ting'],['星','xing'],['平','ping'],['情','qing'],['定','ding']],
  iu:[['牛','niu'],['秋','qiu'],['久','jiu'],['球','qiu'],['留','liu'],['六','liu']]
};
