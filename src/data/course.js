/**
 * 新手引导课程（纯数据）
 * ------------------------------------------------------------
 * 为什么单独一个文件：课程内容是**数据**，不是界面代码。
 * 改课程顺序、加一课、调晋级条件，都不该有人去翻 main.js。
 * main.js 只负责把它画出来、把练习跑起来 —— 课程「是什么」全在这里。
 *
 * 每一课复用一种已有的练习模式（LEVELS 里的 id），加一份参数与晋级条件：
 *   id        稳定标识（进度按它记，改名不断档）
 *   mode      对应 LEVELS 里的模式 id，startSession(modeOverride) 直接用
 *   params    传给 generateQuestions 的参数（题量 / 档位 / 词组筛选等）
 *   goal      这一课练什么（给学员看的一句话）
 *   check     晋级条件（全部满足才放行）：
 *               minAccuracy      本课正确率下限（%）
 *               minIndependent   独立正确率下限（%，不含提示辅助的作答）
 *               minSpeed         速度下限（字/分；速度课才有）
 *               minChars         至少完成多少字（拦「随便按两下就过关」）
 *   reason    为什么设这个门槛（给「未过关」提示用，让人服气）
 *
 * 【minIndependent 为什么存在】基础课允许开提示 —— 那是教学。
 * 但毕业课不行：全程靠提示把字「看」完，表面正确率 100%，
 * 独立正确率却是 0% —— 那不叫掌握，叫跟着读。毕业线必须同时
 * 卡独立正确率，否则「提示开着」就能把文凭混到手。
 *
 * 顺序就是课程顺序：先韵母（韵母是「看见→按键」，负担最小），
 * 再声母（引入 zh/ch/sh 各占一键的特例），然后拆分、单字、词组、提速。
 */
export const COURSE = [
  {
    id: 'c1-yun',
    title: '第 1 课 · 认韵母键',
    mode: 'yun',
    params: { count: 20 },
    goal: '看见韵母，能按出它所在的键。这是整套双拼里负担最小的一步。',
    check: { minAccuracy: 90, minChars: 15 },
    reason: '韵母键是后面一切的地基：拆分、单字、词组都要先按对韵母。错得多的键会一直拖累后面的每一课。'
  },
  {
    id: 'c2-sheng',
    title: '第 2 课 · 认声母键',
    mode: 'sheng',
    params: { count: 20 },
    goal: '记住全部声母键，包括 zh→V、ch→I、sh→U 这三个「一键代表两个字」的特例。',
    check: { minAccuracy: 90, minChars: 15 },
    reason: 'zh/ch/sh 各占一键是小鹤最反直觉的地方，单独一课专门记，混在单字里练会记不牢。'
  },
  {
    id: 'c3-split',
    title: '第 3 课 · 声韵拆分',
    mode: 'split',
    params: { count: 20 },
    goal: '把一个音节拆成「声母 + 韵母」两键，按出完整编码。',
    check: { minAccuracy: 92, minChars: 15 },
    reason: '拆分是双拼的核心动作。这里不熟，后面单字永远慢——每打一个字都要想一遍怎么拆。'
  },
  {
    id: 'c4-char',
    title: '第 4 课 · 单字跟打',
    mode: 'char',
    params: { count: 20, charTier: 'progressive' },
    goal: '连续打单字，从高频字开始，练到不假思索。',
    check: { minAccuracy: 92, minChars: 15 },
    reason: '单字是词组的原料。自适应档位会自动挑你还生疏的字，比你手工挑快。'
  },
  {
    id: 'c5-phrase',
    title: '第 5 课 · 词组跟打',
    mode: 'phrase',
    params: { count: 15 },
    goal: '按词输入，练习「一声一韵」的节奏感，这是日常打字的主要形态。',
    check: { minAccuracy: 90, minChars: 20 },
    reason: '词组的编码节奏和单字不同（声母 + 韵母交替），需要单独建立手感。'
  },
  {
    id: 'c6-speed',
    title: '第 6 课 · 提速巩固',
    mode: 'char',
    params: { count: 30, charTier: 'progressive' },
    goal: '在保持正确率的前提下把速度提到 30 字/分 —— 毕业线。',
    check: { minSpeed: 30, minAccuracy: 90, minIndependent: 85, minChars: 25 },
    reason: '速度是最后才来的东西：先准后快。正确率不够时追求速度只会把错误练熟。' +
      '毕业线同时卡**独立正确率**——全程靠提示看完的不算数，那是跟着读，不是会了。'
  }
];

/** 按课程顺序找「当前该上的课」：第一门不在 completed 里的课 */
export function currentLesson(progress) {
  const done = new Set((progress && progress.completed) || []);
  return COURSE.find(l => !done.has(l.id)) || null;
}

/** 全部完成后返回 null —— 毕业了 */
export function courseFinished(progress) {
  return currentLesson(progress) === null;
}
