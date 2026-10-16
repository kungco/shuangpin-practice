// Small, bounded lessons. Every item is covered before a round repeats it.
const keyLesson = (id, title, parts, legacy = ['c1-yun']) => ({
  id, title, mode: 'keymap', role: 'yun', parts, legacy,
  goal: `只练 ${parts.join(' / ')}，把这一小组的位置记牢。`
});
export const LEARNING_CHAPTERS = [
  { id: 'start', title: '认识双拼', goal: '理解两键一个音节，先认识最常见的例外。', lessons: [
    { id: 'two-keys', title: '一字两键', mode: 'char', samples: [['你','ni'],['好','hao'],['大','da'],['吗','ma']],
      legacy: ['c3-split','c4-char'], goal: '先按声母，再按韵母。每个音节只需两键。' },
    { id: 'special-sheng', title: 'zh / ch / sh', mode: 'keymap', role: 'sheng', parts: ['zh','ch','sh'],
      legacy: ['c2-sheng'], goal: '三个特殊声母各占一个键：zh→V、ch→I、sh→U。' },
    { id: 'zero-sheng', title: '零声母也按两键', mode: 'char', samples: [['啊','a'],['安','an'],['昂','ang'],['爱','ai']],
      legacy: ['c3-split'], goal: '单字母重复（a→AA），两字母保留拼写（an→AN），三字母用首字母加韵母键（ang→AH）。' }
  ]},
  { id: 'keys', title: '记住韵母', goal: '每关加入一小组；容易混淆的韵母放在一起比较。', lessons: [
    keyLesson('vowels-a', 'a / o / e', ['a','o','e']),
    keyLesson('vowels-i', 'i / u / ü', ['i','u','v']),
    keyLesson('an-ang', '分清 an / ang', ['an','ang']),
    keyLesson('en-eng-ing', '分清 en / eng / ing', ['en','eng','ing']),
    keyLesson('ai-ou', 'ai / ei / ao / ou', ['ai','ei','ao','ou']),
    keyLesson('ia-ie', 'ia / ua / ie / üe', ['ia','ua','ie','ve','ue']),
    keyLesson('in-ian-iao', 'in / ian / iao', ['in','ian','iao']),
    keyLesson('iang-uan', 'iang / uang / uan', ['iang','uang','uan']),
    keyLesson('ui-uo', 'ui / un / iu / uo', ['ui','un','iu','uo']),
    keyLesson('ong-er', 'ong / iong / uai / er', ['ong','iong','uai','er'])
  ]},
  { id: 'words', title: '连字成词', goal: '用已经认识的键位，练习连续输入。', lessons: [
    { id: 'common-chars', title: '常用单字', mode: 'char', legacy: ['c4-char'],
      samples: [['的','de'],['是','shi'],['我','wo'],['们','men'],['中','zhong'],['国','guo']],
      goal: '从常用字开始，保持声母、韵母交替的节奏。' },
    { id: 'common-words', title: '二字词组', mode: 'phrase', legacy: ['c5-phrase'],
      samples: [['你好','ni hao'],['我们','wo men'],['今天','jin tian'],['工作','gong zuo']],
      goal: '把两个音节连起来，先按准，不急着追速度。' }
  ]},
  { id: 'sentences', title: '连词成句', goal: '在短句里保持节奏，再去练自己的文章。', lessons: [
    { id: 'short-sentences', title: '一句话练习', mode: 'phrase', legacy: ['c6-speed'],
      samples: [['今天我们一起学习','jin tian wo men yi qi xue xi'],['每天进步一点','mei tian jin bu yi dian'],['先练准确再练速度','xian lian zhun que zai lian su du']],
      goal: '用几句短句检查独立输入。初学阶段不设速度门槛。' }
  ]}
];
export const LEARNING_LESSONS = LEARNING_CHAPTERS.flatMap((c, chapter) =>
  c.lessons.map((l, index) => ({ ...l, chapter, chapterTitle: c.title, number: index + 1 })));
export const LEARNING_MAP = Object.fromEntries(LEARNING_LESSONS.map(l => [l.id, l]));
