/**
 * 题库扩充生成器（构建期工具，不参与运行时）
 * 运行：node _test/tools/gen_expand.mjs [--write]
 *
 * 职责：
 *   1. 装载「候选扩充内容」（人工撰写，见下方 NEW_* 常量）
 *   2. 用真实引擎逐一校验：拼音可拆分 / 无大写 / 字数对应 / 无重复 / 短文用字全覆盖
 *   3. 加 --write 时，把合法内容以既有格式写入 src/data/pinyin.js
 *
 * 设计原则：宁可少收，不可收错。任何一条校验不过就整体失败，不产出半成品。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitSyllable } from '../../src/core/scheme.js';
import { ALL_CHARS, PHRASES, PASSAGES, CHAR_TIERS } from '../../src/data/pinyin.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = resolve(root, 'src/data/pinyin.js');
const WRITE = process.argv.includes('--write');

/* ============================================================
   A. 新增单字（全部经去重校验，与既有字表零重叠）
   ============================================================ */
export const NEW_CHARS = {
  // --- 生活场景 ---
  "早": "zao", "六": "liu", "午": "wu", "夜": "ye", "楼": "lou", "街": "jie", "房": "fang",
  "饭": "fan", "菜": "cai", "汤": "tang", "锅": "guo", "灶": "zao", "台": "tai", "厨": "chu",
  "亲": "qin", "孩": "hai", "园": "yuan", "椅": "yi", "树": "shu", "叶": "ye", "珠": "zhu",
  "帘": "lian", "灯": "deng", "盏": "zhan", "套": "tao", "扇": "shan", "袋": "dai", "罐": "guan",
  "响": "xiang", "闹": "nao", "掉": "diao", "拉": "la", "推": "tui", "挂": "gua", "撑": "cheng",
  "脚": "jiao", "腰": "yao", "肩": "jian", "脸": "lian", "嘴": "zui", "眉": "mei",
  "切": "qie", "倒": "dao", "洗": "xi", "擦": "ca", "煮": "zhu", "蒸": "zheng", "烤": "kao",
  "冒": "mao", "飘": "piao", "腾": "teng", "散": "san", "聚": "ju", "拢": "long", "洒": "sa",
  // --- 动作 / 状态 ---
  "写": "xie", "读": "du", "忘": "wang", "答": "da", "追": "zhui", "翻": "fan", "丢": "diu",
  "舍": "she", "留": "liu", "占": "zhan", "碰": "peng", "填": "tian", "排": "pai", "序": "xu",
  "组": "zu", "取": "qu", "退": "tui", "弃": "qi", "消": "xiao", "耗": "hao", "费": "fei",
  "流": "liu", "馈": "kui", "骗": "pian", "遗": "yi", "漏": "lou", "刻": "ke", "埋": "mai",
  "芽": "ya", "奏": "zou", "带": "dai", "绪": "xu", "存": "cun", "顺": "shun", "旦": "dan",
  "繁": "fan", "频": "pin", "注": "zhu", "暖": "nuan", "紧": "jin", "呼": "hu", "吸": "xi",
  "炖": "dun", "怕": "pa", "怎": "zen", "须": "xu", "底": "di", "算": "suan", "曲": "qu",
  "线": "xian", "似": "si", "偶": "ou", "晚": "wan", "质": "zhi", "例": "li", "执": "zhi",
  // --- 书面 / 抽象 ---
  "维": "wei", "惯": "guan", "念": "nian", "塑": "su", "造": "zao", "容": "rong", "楚": "chu",
  "志": "zhi", "愿": "yuan", "望": "wang", "辨": "bian", "判": "pan", "断": "duan", "衡": "heng",
  "测": "ce", "评": "ping", "估": "gu", "筹": "chou", "划": "hua", "策": "ce", "践": "jian",
  "调": "tiao", "优": "you", "劣": "lie", "减": "jian", "积": "ji", "梯": "ti", "势": "shi",
  "躺": "tang", "蹲": "dun", "弯": "wan", "斜": "xie", "摇": "yao", "摆": "bai", "滚": "gun",
  // --- 补齐短文用字 ---
  "蓝": "lan", "铺": "pu", "啦": "la", "漉": "lu",
  "咳": "ke", "潦": "liao", "埋": "mai", "绪": "xu", "频": "pin",
  "盏": "zhan", "裹": "guo", "炖": "dun", "倦": "juan", "燥": "zao", "躁": "zao",
  "糊": "hu", "默": "mo", "惯": "guan",
  "遗": "yi", "骗": "pian", "忽": "hu", "扇": "shan",
  // --- 补齐短文用字（第 2 批） ---
  "附": "fu", "棋": "qi", "筝": "zheng", "影": "ying", "碌": "lu", "汽": "qi",
  "沿": "yan", "河": "he", "圈": "quan", "映": "ying", "聊": "liao", "混": "hun",
  "图": "tu", "馆": "guan", "照": "zhao", "木": "mu", "沙": "sha", "傍": "bang",
  "院": "yuan", "玩": "wan", "衣": "yi", "服": "fu", "片": "pian", "搬": "ban",
  "块": "kuai", "瓜": "gua", "吃": "chi", "骑": "qi", "车": "che", "摔": "shuai",
  "膝": "xi", "盖": "gai", "掌": "zhang", "红": "hong", "父": "fu", "扶": "fu",
  "爬": "pa", "米": "mi", "草": "cao", "失": "shi", "土": "tu", "突": "tu",
  "候": "hou", "黑": "hei", "久": "jiu", "属": "shu", "艺": "yi", "枯": "ku",
  "够": "gou", "拿": "na", "半": "ban", "途": "tu", "废": "fei", "讲": "jiang",
  "摊": "tan", "青": "qing", "买": "mai", "挑": "tiao", "砍": "kan", "价": "jia",
  "踏": "ta", "满": "man", "妨": "fang", "举": "ju", "延": "yan", "团": "tuan",
  "模": "mo", "否": "fou", "懂": "dong", "梳": "shu", "替": "ti", "津": "jin",
  "操": "cao", "独": "du", "矛": "mao", "盾": "dun", "待": "dai", "校": "xiao",
  "偏": "pian", "近": "jin", "背": "bei", "迁": "qian", "移": "yi"
};

/* ============================================================
   B. 新增词组
   ============================================================ */
export const NEW_PHRASES = [
  // ---- 双字：工作学习 ----
  { w: "加班", p: ["jia", "ban"] }, { w: "面试", p: ["mian", "shi"] }, { w: "简历", p: ["jian", "li"] },
  { w: "同事", p: ["tong", "shi"] }, { w: "汇报", p: ["hui", "bao"] }, { w: "会议", p: ["hui", "yi"] },
  { w: "项目", p: ["xiang", "mu"] }, { w: "客户", p: ["ke", "hu"] }, { w: "需求", p: ["xu", "qiu"] },
  { w: "反馈", p: ["fan", "kui"] }, { w: "版本", p: ["ban", "ben"] }, { w: "测试", p: ["ce", "shi"] },
  { w: "部署", p: ["bu", "shu"] }, { w: "运维", p: ["yun", "wei"] }, { w: "架构", p: ["jia", "gou"] },
  { w: "模块", p: ["mo", "kuai"] }, { w: "接口", p: ["jie", "kou"] }, { w: "算法", p: ["suan", "fa"] },
  { w: "代码", p: ["dai", "ma"] }, { w: "调试", p: ["tiao", "shi"] }, { w: "编译", p: ["bian", "yi"] },
  { w: "运行", p: ["yun", "xing"] }, { w: "性能", p: ["xing", "neng"] }, { w: "内存", p: ["nei", "cun"] },
  { w: "线程", p: ["xian", "cheng"] }, { w: "进程", p: ["jin", "cheng"] }, { w: "缓存", p: ["huan", "cun"] },
  { w: "索引", p: ["suo", "yin"] }, { w: "查询", p: ["cha", "xun"] }, { w: "备份", p: ["bei", "fen"] },
  { w: "迁移", p: ["qian", "yi"] }, { w: "升级", p: ["sheng", "ji"] }, { w: "权限", p: ["quan", "xian"] },
  { w: "密码", p: ["mi", "ma"] }, { w: "账号", p: ["zhang", "hao"] }, { w: "注册", p: ["zhu", "ce"] },
  { w: "加密", p: ["jia", "mi"] }, { w: "签名", p: ["qian", "ming"] }, { w: "协议", p: ["xie", "yi"] },
  { w: "端口", p: ["duan", "kou"] }, { w: "带宽", p: ["dai", "kuan"] }, { w: "延迟", p: ["yan", "chi"] },
  { w: "并发", p: ["bing", "fa"] }, { w: "集群", p: ["ji", "qun"] }, { w: "负载", p: ["fu", "zai"] },
  // ---- 双字：日常生活 ----
  { w: "起床", p: ["qi", "chuang"] }, { w: "刷牙", p: ["shua", "ya"] }, { w: "洗脸", p: ["xi", "lian"] },
  { w: "早饭", p: ["zao", "fan"] }, { w: "午饭", p: ["wu", "fan"] }, { w: "晚饭", p: ["wan", "fan"] },
  { w: "做饭", p: ["zuo", "fan"] }, { w: "洗碗", p: ["xi", "wan"] }, { w: "扫地", p: ["sao", "di"] },
  { w: "购物", p: ["gou", "wu"] }, { w: "超市", p: ["chao", "shi"] }, { w: "排队", p: ["pai", "dui"] },
  { w: "付款", p: ["fu", "kuan"] }, { w: "快递", p: ["kuai", "di"] }, { w: "包裹", p: ["bao", "guo"] },
  { w: "外卖", p: ["wai", "mai"] }, { w: "餐厅", p: ["can", "ting"] }, { w: "菜单", p: ["cai", "dan"] },
  { w: "结账", p: ["jie", "zhang"] }, { w: "打折", p: ["da", "zhe"] }, { w: "优惠", p: ["you", "hui"] },
  { w: "公交", p: ["gong", "jiao"] }, { w: "地铁", p: ["di", "tie"] }, { w: "火车", p: ["huo", "che"] },
  { w: "航班", p: ["hang", "ban"] }, { w: "机场", p: ["ji", "chang"] }, { w: "车站", p: ["che", "zhan"] },
  { w: "导航", p: ["dao", "hang"] }, { w: "路线", p: ["lu", "xian"] }, { w: "旅行", p: ["lv", "xing"] },
  { w: "行李", p: ["xing", "li"] }, { w: "酒店", p: ["jiu", "dian"] }, { w: "景点", p: ["jing", "dian"] },
  { w: "门票", p: ["men", "piao"] }, { w: "拍照", p: ["pai", "zhao"] }, { w: "相册", p: ["xiang", "ce"] },
  { w: "聊天", p: ["liao", "tian"] }, { w: "散步", p: ["san", "bu"] }, { w: "逛街", p: ["guang", "jie"] },
  // ---- 双字：情绪感受 ----
  { w: "开心", p: ["kai", "xin"] }, { w: "难过", p: ["nan", "guo"] }, { w: "紧张", p: ["jin", "zhang"] },
  { w: "放松", p: ["fang", "song"] }, { w: "焦虑", p: ["jiao", "lv"] }, { w: "平静", p: ["ping", "jing"] },
  { w: "兴奋", p: ["xing", "fen"] }, { w: "失望", p: ["shi", "wang"] }, { w: "期待", p: ["qi", "dai"] },
  { w: "感动", p: ["gan", "dong"] }, { w: "温暖", p: ["wen", "nuan"] }, { w: "孤独", p: ["gu", "du"] },
  { w: "骄傲", p: ["jiao", "ao"] }, { w: "谦虚", p: ["qian", "xu"] }, { w: "幽默", p: ["you", "mo"] },
  { w: "认真", p: ["ren", "zhen"] }, { w: "仔细", p: ["zi", "xi"] }, { w: "粗心", p: ["cu", "xin"] },
  { w: "耐心", p: ["nai", "xin"] }, { w: "果断", p: ["guo", "duan"] }, { w: "犹豫", p: ["you", "lv"] },
  // ---- 双字：身体 / 健康 ----
  { w: "睡眠", p: ["shui", "mian"] }, { w: "营养", p: ["ying", "yang"] }, { w: "蔬菜", p: ["shu", "cai"] },
  { w: "水果", p: ["shui", "guo"] }, { w: "牛奶", p: ["niu", "nai"] }, { w: "面包", p: ["mian", "bao"] },
  { w: "鸡蛋", p: ["ji", "dan"] }, { w: "味觉", p: ["wei", "jue"] }, { w: "嗅觉", p: ["xiu", "jue"] },
  { w: "视觉", p: ["shi", "jue"] }, { w: "听觉", p: ["ting", "jue"] }, { w: "呼吸", p: ["hu", "xi"] },
  { w: "循环", p: ["xun", "huan"] }, { w: "消化", p: ["xiao", "hua"] }, { w: "免疫", p: ["mian", "yi"] },
  { w: "疫苗", p: ["yi", "miao"] }, { w: "锻炼", p: ["duan", "lian"] }, { w: "跑步", p: ["pao", "bu"] },
  { w: "游泳", p: ["you", "yong"] }, { w: "瑜伽", p: ["yu", "jia"] }, { w: "太极", p: ["tai", "ji"] },
  { w: "篮球", p: ["lan", "qiu"] }, { w: "足球", p: ["zu", "qiu"] }, { w: "乒乓", p: ["ping", "pang"] },
  // ---- 双字：进阶难键（zhuang/chuang/shuang/xiong/qiong/nv/nve/lve 等） ---- { w: "汹涌", p: ["xiong", "yong"] }, { w: "苍穹", p: ["cang", "qiong"] },
  { w: "女装", p: ["nv", "zhuang"] }, { w: "虐待", p: ["nve", "dai"] }, { w: "掠夺", p: ["lve", "duo"] },
  { w: "旋律", p: ["xuan", "lv"] }, { w: "效率", p: ["xiao", "lv"] }, { w: "捐躯", p: ["juan", "qu"] },
  // ---- 三字词 ----
  { w: "输入法", p: ["shu", "ru", "fa"] }, { w: "文件夹", p: ["wen", "jian", "jia"] },
  { w: "浏览器", p: ["liu", "lan", "qi"] }, { w: "交换机", p: ["jiao", "huan", "ji"] },
  { w: "打印机", p: ["da", "yin", "ji"] }, { w: "显示屏", p: ["xian", "shi", "ping"] },
  { w: "摄像头", p: ["she", "xiang", "tou"] }, { w: "麦克风", p: ["mai", "ke", "feng"] },
  { w: "充电器", p: ["chong", "dian", "qi"] }, { w: "公交车", p: ["gong", "jiao", "che"] },
  { w: "电影院", p: ["dian", "ying", "yuan"] }, { w: "图书馆", p: ["tu", "shu", "guan"] },
  { w: "实验室", p: ["shi", "yan", "shi"] }, { w: "观察力", p: ["guan", "cha", "li"] },
  { w: "记忆力", p: ["ji", "yi", "li"] }, { w: "想象力", p: ["xiang", "xiang", "li"] },
  { w: "创造力", p: ["chuang", "zao", "li"] }, { w: "注意力", p: ["zhu", "yi", "li"] },
  // ---- 四字成语 / 常用语 ----
  { w: "专心致志", p: ["zhuan", "xin", "zhi", "zhi"] }, { w: "持之以恒", p: ["chi", "zhi", "yi", "heng"] },
  { w: "锲而不舍", p: ["qie", "er", "bu", "she"] }, { w: "循序渐进", p: ["xun", "xu", "jian", "jin"] },
  { w: "举一反三", p: ["ju", "yi", "fan", "san"] }, { w: "融会贯通", p: ["rong", "hui", "guan", "tong"] },
  { w: "温故知新", p: ["wen", "gu", "zhi", "xin"] }, { w: "学以致用", p: ["xue", "yi", "zhi", "yong"] },
  { w: "勤能补拙", p: ["qin", "neng", "bu", "zhuo"] }, { w: "精益求精", p: ["jing", "yi", "qiu", "jing"] },
  { w: "一丝不苟", p: ["yi", "si", "bu", "gou"] }, { w: "各抒己见", p: ["ge", "shu", "ji", "jian"] },
  { w: "集思广益", p: ["ji", "si", "guang", "yi"] }, { w: "身体力行", p: ["shen", "ti", "li", "xing"] },
  { w: "心平气和", p: ["xin", "ping", "qi", "he"] }, { w: "从容不迫", p: ["cong", "rong", "bu", "po"] },
  { w: "井井有条", p: ["jing", "jing", "you", "tiao"] }, { w: "有条不紊", p: ["you", "tiao", "bu", "wen"] },
  { w: "恰到好处", p: ["qia", "dao", "hao", "chu"] }, { w: "炉火纯青", p: ["lu", "huo", "chun", "qing"] },
  { w: "登峰造极", p: ["deng", "feng", "zao", "ji"] }, { w: "博大精深", p: ["bo", "da", "jing", "shen"] },
  { w: "源远流长", p: ["yuan", "yuan", "liu", "chang"] }, { w: "厚积薄发", p: ["hou", "ji", "bo", "fa"] },
  { w: "水落石出", p: ["shui", "luo", "shi", "chu"] }, { w: "门庭若市", p: ["men", "ting", "ruo", "shi"] },
  { w: "百发百中", p: ["bai", "fa", "bai", "zhong"] }, { w: "众所周知", p: ["zhong", "suo", "zhou", "zhi"] },
  { w: "一鼓作气", p: ["yi", "gu", "zuo", "qi"] }, { w: "马到成功", p: ["ma", "dao", "cheng", "gong"] }
];

/* ============================================================
   C. 新增短文（60–140 字，覆盖「，。、；：？！「」」）
   ============================================================ */
export const NEW_PASSAGES = [
  // ---------- 难度 1 ----------
  { t: "早晨六点，闹钟响了。我关掉它，拉开窗帘，天边刚泛起一点淡蓝。楼下的早点铺已经开门，热气从蒸笼里冒出来，飘得很远。", d: 1 },
  { t: "周末的下午，我常去附近的公园走走。老人下棋，孩子追着风筝跑，长椅上有人看书。树影落在地上，风一吹就散开，又慢慢聚拢。", d: 1 },
  { t: "厨房里飘出饭菜的香味，母亲在灶台前忙碌。她把切好的菜倒进锅里，滋啦一声，白汽腾起。我站在门口看着，忽然觉得这样的画面最让人安心。", d: 1 },
  { t: "雨下了整整一夜。早上推开门，空气湿漉漉的，路边的叶子挂着水珠。行人撑起伞，脚步比平时慢了许多，整条街都安静了下来。", d: 1 },
  { t: "晚饭后，我习惯沿着河边走一圈。水面映着路灯，一圈圈地晃动。有小孩在岸边追跑，也有老人坐在椅子上聊天，声音很轻，混在风里。", d: 1 },
  { t: "图书馆的下午总是很安静。阳光从高窗照进来，落在长长的木桌上。翻书的声音、写字的沙沙声，还有偶尔的一声轻咳，就是这里的全部动静。", d: 1 },
  { t: "夏天的傍晚，天还很亮。孩子们在院子里玩水，衣服湿了一大片也不在乎。大人搬出小桌，切一块西瓜，边吃边聊，直到天色完全暗下来。", d: 1 },
  { t: "第一次学骑车时，我摔了好几回。膝盖破了，手掌也擦红了。父亲没有扶我，只是站在几步之外说：「再来一次。」于是我又爬上去，慢慢骑了三米。", d: 1 },
  // ---------- 难度 2 ----------
  { t: "写字这件事，看上去简单，其实很考验耐性。一笔一画都要稳，急不得；写快了容易潦草，写慢了又失了气韵。练字的过程，也是在练心。", d: 2 },
  { t: "读书的好处不会立刻显现，它像往土里埋种子，看不见动静，却在某个时刻突然发芽。你读过的句子会变成自己的语言，藏在说话和思考的方式里。", d: 2 },
  { t: "一个人走路的时候，脑子往往最清醒。脚步的节奏会带着思绪往前走，许多白天想不通的问题，常常在这样的时候忽然有了答案。", d: 2 },
  { t: "好的工具能让人忘记工具的存在。用起来顺手，就不会再想起它；一旦频繁出问题，注意力便全被拖走。软件如此，键盘如此，生活里许多东西也如此。", d: 2 },
  { t: "北方的冬天，天黑得早。四点多钟，天色就暗下来，路灯一盏盏亮起。行人裹紧外套，呼出的白气很快散在风里。屋里却是暖的，锅里炖着热汤。", d: 2 },
  { t: "把一件复杂的事拆开，往往就没有那么可怕了。先看它由哪几部分组成，再想每一部分该怎么做，最后排个先后顺序。真正难的是拆之前的那一步：动手。", d: 2 },
  { t: "整理房间的时候，我总会翻出一些很久没用的东西。丢掉舍不得，留着又占地方。后来学会一个办法：如果一年都没碰过，就说明它已经不属于现在的生活。", d: 2 },
  { t: "学一门手艺，头几天最有意思，样样新鲜；过了一周就开始枯燥，动作重复，进步也慢。许多人在这里停下。其实再往前走一段，手感就会自己长出来。", d: 2 },
  { t: "写日记不必求长。每天三五句，记下当天最想说的一件事就够了。日子久了回看，你会发现那些当时觉得平淡的片段，反而最经得起反复读。", d: 2 },
  { t: "饭要一口一口吃，路要一步一步走。道理听上去老套，却很少有人真正做到。我们总想跳过过程直接拿到结果，于是急、于是躁，于是半途而废。", d: 2 },
  { t: "和人说话时，先听完再回答，比急着表达自己更有用。多数误会不是因为谁说得不够清楚，而是因为谁都没有等对方把话讲完。", d: 2 },
  { t: "菜市场的早晨最热闹。摊主把青菜摆成整齐的一排，水珠还挂在叶子上；买菜的人提着袋子，一边挑一边砍价。声音混在一起，却让人觉得踏实。", d: 2 },
  // ---------- 难度 3 ----------
  { t: "「这个键到底在哪儿？」新手常这样问。答案其实不在键盘上，而在手指的记忆里。当你不再需要低头去找，输入才算真正变成了本能。", d: 3 },
  { t: "所有技能的成长曲线都相似：起初进步很快，中间会有一段漫长的平台期，看不出变化，甚至偶尔倒退。多数人在这里放弃，而越过它的人，往往只是多坚持了几周。", d: 3 },
  { t: "效率不是把每一分钟都填满。恰恰相反，它是知道哪些事可以不做，哪些事可以晚一点做，哪些事必须现在就做。取舍的能力，比努力更稀缺。", d: 3 },
  { t: "语言塑造思维。你习惯用哪些词，就会更容易注意到哪些细节；你缺少某个概念，就可能长久地忽略某种感受。学习新词，有时是在为自己打开一扇窗。", d: 3 },
  { t: "清晨、午后、深夜——一天里最安静的几个时刻，思考的质量往往最高。不是因为那时更聪明，而是因为外界的干扰少，注意力终于能完整地停留在同一件事上。", d: 3 },
  { t: "习惯的力量在于它几乎不需要消耗意志。决定一旦变成惯例，执行就不再费力。所以改变自己的关键，不是下更大的决心，而是设计一个更容易坚持的流程。", d: 3 },
  { t: "「熟能生巧」四个字里，藏着一个容易被忽略的前提：每次练习都要有反馈。重复本身不会带来进步，只有知道哪里错了、并且下一次改过来，才算真正的重复。", d: 3 },
  { t: "记忆是会骗人的。我们总以为自己记得很清楚，可一旦要复述细节，才发现遗漏了许多。所以重要的事应当写下来——不是为了记住，而是为了看清自己记错了什么。", d: 3 },
  { t: "衡量一段学习的质量，不妨问自己三个问题：能不能用自己的话说清楚？能不能举出一个反例？能不能在新的场景里用出来？三问都答得上，才算真的学会了。", d: 3 },
  { t: "拖延往往不是因为懒，而是因为任务在脑子里是一团模糊的东西。把它写成一张清单，每一条都具体到「下一步做什么」，那团雾就会散去，手也就动得起来了。", d: 3 },
  { t: "判断一个人是否真的懂了某件事，最直接的办法是让他讲给外行听。如果对方听明白了，说明自己也梳理清楚了；如果越讲越绕，那多半是中间还有没想通的地方。", d: 3 },
  { t: "技术的更替越来越快，今天熟练的工具，几年后可能无人问津。比记住某个具体操作更重要的，是理解它背后的思路——思路会迁移，操作却会过期。", d: 3 },
  { t: "独处与合群并不矛盾。一个人待着的时候，你整理自己的判断；和别人相处的时候，你校正自己的判断。两边都要有，缺了哪一边都容易走偏。", d: 3 }
];

/* ============================================================
   校验
   ============================================================ */
const errs = [];
const note = (m) => errs.push(m);

/* --- 单字 --- */
{
  const existing = new Set(Object.keys(ALL_CHARS));
  const seen = new Set();
  for (const [ch, py] of Object.entries(NEW_CHARS)) {
    if (seen.has(ch)) note(`[单字] 表内重复: ${ch}`);
    seen.add(ch);
    if (existing.has(ch)) note(`[单字] 与既有字表重复: ${ch}`);
    if (!/^[a-z]+$/.test(py)) note(`[单字] 拼音含非小写字母: ${ch}=${py}`);
    if (!splitSyllable(py).length) note(`[单字] 无法拆分: ${ch}=${py}`);
  }
}

/* --- 词组 --- */
{
  const seen = new Set();
  const existW = new Set(PHRASES.map(p => p.w));
  for (const p of NEW_PHRASES) {
    if (seen.has(p.w)) note(`[词组] 表内重复: ${p.w}`);
    seen.add(p.w);
    if (existW.has(p.w)) note(`[词组] 与既有重复: ${p.w}`);
    if (p.w.length !== p.p.length) note(`[词组] 字数不符: ${p.w} ${p.w.length}≠${p.p.length}`);
    p.p.forEach((py, i) => {
      if (!/^[a-z]+$/.test(py)) note(`[词组] 拼音非法: ${p.w}[${i}]=${py}`);
      if (!splitSyllable(py).length) note(`[词组] 无法拆分: ${p.w}[${i}]=${py}`);
    });
  }
}

/* --- 短文 --- */
{
  const seen = new Set();
  const existT = new Set(PASSAGES.map(p => p.t));
  const charPool = new Set([...Object.keys(ALL_CHARS), ...Object.keys(NEW_CHARS)]);
  for (const p of NEW_PASSAGES) {
    if (seen.has(p.t)) note(`[短文] 表内重复: ${p.t.slice(0, 16)}…`);
    seen.add(p.t);
    if (existT.has(p.t)) note(`[短文] 与既有重复: ${p.t.slice(0, 16)}…`);
    if (!(p.d >= 1 && p.d <= 3)) note(`[短文] 难度非法: ${p.d}`);
    const miss = [...new Set(Array.from(p.t).filter(ch => /[\u4e00-\u9fa5]/.test(ch) && !charPool.has(ch)))];
    if (miss.length) note(`[短文] 未收录字: ${miss.join('')}`);
  }
}

console.log('=== 候选扩充内容 ===');
console.log(`  新增单字 ${Object.keys(NEW_CHARS).length} 个`);
console.log(`  新增词组 ${NEW_PHRASES.length} 条`);
console.log(`  新增短文 ${NEW_PASSAGES.length} 篇`);
console.log(`\n=== 校验结果 ===`);
if (errs.length) {
  console.log(`  ✗ ${errs.length} 项未通过：`);
  errs.slice(0, 30).forEach(e => console.log('    ' + e));
  process.exit(1);
}
console.log('  ✅ 全部校验通过');

/* ============================================================
   写盘
   ============================================================ */
if (!WRITE) {
  console.log('\n（未加 --write，仅校验，不修改文件）');
  process.exit(0);
}

console.log('\n=== 写入 src/data/pinyin.js ===');
let src = readFileSync(DATA, 'utf8');

/* 1) 追加新的单字档 */
const charLines = [];
const entries = Object.entries(NEW_CHARS);
for (let i = 0; i < entries.length; i += 8) {
  const row = entries.slice(i, i + 8).map(([c, p]) => `"${c}": "${p}"`).join(', ');
  charLines.push('  ' + row + (i + 8 < entries.length ? ',' : ''));
}
const tierBlock = `/* --- 第 6 组：扩充常用字（生活、动作、书面表达，补齐短文语料） --- */\nexport const CHARS_TIER6 = {\n${charLines.join('\n')}\n};\n\n`;
src = src.replace(
  '/* 合并后的全量单字表 */',
  tierBlock + '/* 合并后的全量单字表 */'
);
src = src.replace(
  'Object.assign({}, CHARS_TIER1, CHARS_TIER2, CHARS_TIER3, CHARS_TIER4, CHARS_TIER5)',
  'Object.assign({}, CHARS_TIER1, CHARS_TIER2, CHARS_TIER3, CHARS_TIER4, CHARS_TIER5, CHARS_TIER6)'
);
src = src.replace(
  '  { id: 5, name: "书面字",   data: CHARS_TIER5 }\n];',
  '  { id: 5, name: "书面字",   data: CHARS_TIER5 },\n  { id: 6, name: "扩充字",   data: CHARS_TIER6 }\n];'
);

/* 2) 追加词组 */
const phLines = NEW_PHRASES.map(p =>
  `  { w: "${p.w}", p: [${p.p.map(x => `"${x}"`).join(', ')}] }`
).join(',\n');
src = src.replace(
  '  { w: "春光乍泄", p: ["chun", "guang", "zha", "xie"] }\n];',
  '  { w: "春光乍泄", p: ["chun", "guang", "zha", "xie"] },\n\n  // ---- 扩充词组 ----\n' + phLines + '\n];'
);

/* 3) 追加短文 */
const pasLines = NEW_PASSAGES.map(p =>
  `  {\n    t: "${p.t}",\n    d: ${p.d}\n  }`
).join(',\n');
src = src.replace(
  '  {\n    t: "在漫长的学习过程中，瓶颈期几乎是必然会遇到的。此时最重要的不是加倍苦练，而是停下来分析：究竟是哪个环节拖慢了你？找出它，专门攻克它，然后你会发现自己又向前走了一大步。",\n    d: 3\n  }\n];',
  '  {\n    t: "在漫长的学习过程中，瓶颈期几乎是必然会遇到的。此时最重要的不是加倍苦练，而是停下来分析：究竟是哪个环节拖慢了你？找出它，专门攻克它，然后你会发现自己又向前走了一大步。",\n    d: 3\n  },\n\n  // ---- 扩充短文 ----\n' + pasLines + '\n];'
);

/* 4) 更新文件头注释里的规模描述 */
src = src.replace(
  ' * 数据规模刻意保持精简（约 900 字 + 400 词 + 12 段短文），',
  ' * 数据规模刻意保持精简（约 1000 字 + 250 词 + 30 段短文），'
);

writeFileSync(DATA, src, 'utf8');
console.log('  ✅ 已写入');
