/**
 * 拼音数据模块
 * ------------------------------------------------------------
 * 内置：
 *   1. 常用汉字 → 拼音（无声调）映射表，按常用度近似排序
 *   2. 常用词组 / 成语
 *   3. 短文段落（含标点）
 *   4. 声母表 / 韵母表 / 合法音节表
 *
 * 内置静态字词及原创短文，应用运行时不需要依赖或网络。
 * 其中第 7 组字表专门用于补齐词组语料——确保词组里出现的每个字
 * 都能在单字模式下单独练到。
 */

import { EXTRA_CHARS, EXTRA_PHRASES, EXTRA_PASSAGES } from './practice-extra.js';

/* ============================================================
   一、单字拼音表
   格式："汉字": "拼音（小写、无声调）"
   按大致的常用度分组排序，供分级抽题使用。
   ============================================================ */

/* --- 第 1 组：最高频字（覆盖日常文本约 30%） --- */
export const CHARS_TIER1 = {
  "的": "de", "一": "yi", "是": "shi", "不": "bu", "了": "le", "在": "zai", "人": "ren", "有": "you",
  "我": "wo", "他": "ta", "这": "zhe", "个": "ge", "们": "men", "中": "zhong", "来": "lai", "上": "shang",
  "大": "da", "为": "wei", "和": "he", "国": "guo", "地": "di", "到": "dao", "以": "yi", "说": "shuo",
  "时": "shi", "要": "yao", "就": "jiu", "出": "chu", "会": "hui", "可": "ke", "也": "ye", "你": "ni",
  "对": "dui", "生": "sheng", "能": "neng", "而": "er", "子": "zi", "那": "na", "得": "de", "于": "yu",
  "着": "zhe", "下": "xia", "自": "zi", "之": "zhi", "年": "nian", "过": "guo", "发": "fa", "后": "hou",
  "作": "zuo", "里": "li", "用": "yong", "道": "dao", "行": "xing", "所": "suo", "然": "ran", "家": "jia",
  "种": "zhong", "事": "shi", "成": "cheng", "方": "fang", "多": "duo", "经": "jing", "么": "me", "去": "qu",
  "法": "fa", "学": "xue", "如": "ru", "都": "dou", "同": "tong", "现": "xian", "当": "dang", "没": "mei",
  "动": "dong", "面": "mian", "起": "qi", "看": "kan", "定": "ding", "天": "tian", "分": "fen", "还": "hai",
  "进": "jin", "好": "hao", "小": "xiao", "部": "bu", "其": "qi", "些": "xie", "主": "zhu", "样": "yang",
  "理": "li", "心": "xin", "她": "ta", "本": "ben", "前": "qian", "开": "kai", "但": "dan", "因": "yin",
  "只": "zhi", "从": "cong", "想": "xiang", "实": "shi", "日": "ri", "军": "jun", "者": "zhe", "意": "yi",
  "无": "wu", "力": "li", "它": "ta", "与": "yu", "长": "chang", "把": "ba", "机": "ji", "十": "shi",
  "第": "di", "公": "gong", "此": "ci", "已": "yi", "工": "gong", "使": "shi", "情": "qing", "明": "ming",
  "性": "xing", "知": "zhi", "全": "quan", "三": "san", "又": "you", "关": "guan", "点": "dian", "正": "zheng",
  "业": "ye", "外": "wai", "将": "jiang", "两": "liang", "高": "gao", "间": "jian", "由": "you", "问": "wen",
  "很": "hen", "最": "zui", "重": "zhong", "并": "bing", "物": "wu", "手": "shou", "应": "ying", "战": "zhan",
  "向": "xiang", "头": "tou", "文": "wen", "体": "ti", "政": "zheng", "美": "mei", "相": "xiang", "见": "jian",
  "被": "bei", "利": "li", "什": "shen", "二": "er", "等": "deng", "产": "chan", "或": "huo", "新": "xin"
};

/* --- 第 2 组：高频常用字 --- */
export const CHARS_TIER2 = {
  "己": "ji", "制": "zhi", "身": "shen", "果": "guo", "加": "jia", "西": "xi", "斯": "si", "月": "yue",
  "话": "hua", "合": "he", "回": "hui", "特": "te", "代": "dai", "内": "nei", "信": "xin", "表": "biao",
  "化": "hua", "老": "lao", "给": "gei", "世": "shi", "位": "wei", "次": "ci", "度": "du", "门": "men",
  "任": "ren", "常": "chang", "先": "xian", "海": "hai", "通": "tong", "教": "jiao", "儿": "er", "原": "yuan",
  "东": "dong", "声": "sheng", "提": "ti", "立": "li", "及": "ji", "比": "bi", "员": "yuan", "解": "jie",
  "水": "shui", "名": "ming", "真": "zhen", "论": "lun", "处": "chu", "走": "zou", "义": "yi", "各": "ge",
  "入": "ru", "几": "ji", "口": "kou", "认": "ren", "条": "tiao", "平": "ping", "系": "xi", "气": "qi",
  "题": "ti", "活": "huo", "尔": "er", "更": "geng", "别": "bie", "打": "da", "女": "nv", "变": "bian",
  "四": "si", "神": "shen", "总": "zong", "何": "he", "电": "dian", "数": "shu", "安": "an", "少": "shao",
  "报": "bao", "才": "cai", "结": "jie", "反": "fan", "受": "shou", "目": "mu", "太": "tai", "量": "liang",
  "再": "zai", "感": "gan", "建": "jian", "务": "wu", "做": "zuo", "接": "jie", "必": "bi", "场": "chang",
  "件": "jian", "计": "ji", "管": "guan", "期": "qi", "市": "shi", "直": "zhi", "德": "de", "资": "zi",
  "命": "ming", "山": "shan", "金": "jin", "指": "zhi", "克": "ke", "许": "xu", "统": "tong", "区": "qu",
  "保": "bao", "至": "zhi", "队": "dui", "形": "xing", "社": "she", "便": "bian", "空": "kong", "决": "jue",
  "治": "zhi", "展": "zhan", "马": "ma", "科": "ke", "司": "si", "五": "wu", "基": "ji", "眼": "yan",
  "书": "shu", "非": "fei", "则": "ze", "听": "ting", "白": "bai", "却": "que", "界": "jie", "达": "da",
  "光": "guang", "放": "fang", "强": "qiang", "即": "ji", "像": "xiang", "难": "nan", "且": "qie", "权": "quan",
  "思": "si", "王": "wang", "象": "xiang", "完": "wan", "设": "she", "式": "shi", "色": "se", "路": "lu",
  "记": "ji", "南": "nan", "品": "pin", "住": "zhu", "告": "gao", "类": "lei", "求": "qiu", "据": "ju",
  "程": "cheng", "北": "bei", "边": "bian", "死": "si", "张": "zhang", "该": "gai", "交": "jiao", "规": "gui"
};

/* --- 第 3 组：中频字 --- */
export const CHARS_TIER3 = {
  "跑": "pao", "跳": "tiao", "飞": "fei", "游": "you", "唱": "chang", "笑": "xiao", "哭": "ku", "睡": "shui",
  "醒": "xing", "累": "lei", "忙": "mang", "闲": "xian", "静": "jing", "吵": "chao", "热": "re", "冷": "leng",
  "甜": "tian", "苦": "ku", "酸": "suan", "辣": "la", "咸": "xian", "香": "xiang", "臭": "chou", "软": "ruan",
  "硬": "ying", "轻": "qing", "厚": "hou", "薄": "bao", "深": "shen", "浅": "qian", "宽": "kuan", "窄": "zhai",
  "圆": "yuan", "尖": "jian", "滑": "hua", "粗": "cu", "细": "xi", "密": "mi", "稀": "xi", "亮": "liang",
  "暗": "an", "干": "gan", "湿": "shi", "净": "jing", "脏": "zang", "乱": "luan", "齐": "qi", "整": "zheng",
  "破": "po", "旧": "jiu", "鲜": "xian", "熟": "shu", "嫩": "nen", "胖": "pang", "瘦": "shou", "矮": "ai",
  "壮": "zhuang", "弱": "ruo", "聪": "cong", "笨": "ben", "懒": "lan", "勤": "qin", "巧": "qiao", "妙": "miao",
  "奇": "qi", "怪": "guai", "丑": "chou", "俊": "jun", "雅": "ya", "精": "jing", "准": "zhun", "稳": "wen",
  "险": "xian", "危": "wei", "急": "ji"
};

/* --- 第 4 组：双拼进阶字（含 zh/ch/sh、鼻韵母、ü 类，专练易错键） --- */
export const CHARS_TIER4 = {
  "春": "chun", "纯": "chun", "唇": "chun", "蠢": "chun", "窗": "chuang", "床": "chuang", "闯": "chuang", "创": "chuang",
  "疮": "chuang", "双": "shuang", "爽": "shuang", "霜": "shuang", "孀": "shuang", "装": "zhuang", "庄": "zhuang", "桩": "zhuang",
  "状": "zhuang", "撞": "zhuang", "黄": "huang", "皇": "huang", "慌": "huang", "荒": "huang", "谎": "huang", "晃": "huang",
  "广": "guang", "逛": "guang", "熊": "xiong", "雄": "xiong", "胸": "xiong", "凶": "xiong", "兄": "xiong", "穷": "qiong",
  "琼": "qiong", "穹": "qiong", "永": "yong", "勇": "yong", "涌": "yong", "泳": "yong", "拥": "yong", "均": "jun",
  "君": "jun", "菌": "jun", "郡": "jun", "群": "qun", "裙": "qun", "云": "yun", "运": "yun", "晕": "yun",
  "允": "yun", "孕": "yun", "韵": "yun", "寻": "xun", "训": "xun", "迅": "xun", "巡": "xun", "询": "xun",
  "循": "xun", "绿": "lv", "律": "lv", "率": "lv", "旅": "lv", "屡": "lv", "滤": "lv", "钕": "nv",
  "略": "lve", "掠": "lve", "虐": "nve", "疟": "nve", "越": "yue", "跃": "yue", "阅": "yue", "岳": "yue",
  "悦": "yue", "雪": "xue", "血": "xue", "穴": "xue", "削": "xue", "缺": "que", "确": "que", "雀": "que",
  "鹊": "que", "觉": "jue", "绝": "jue", "角": "jue", "掘": "jue", "倔": "jue", "镇": "zhen", "阵": "zhen",
  "震": "zhen", "诊": "zhen", "振": "zhen", "陈": "chen", "沉": "chen", "尘": "chen", "晨": "chen", "衬": "chen",
  "审": "shen", "伸": "shen", "甚": "shen", "增": "zeng", "层": "ceng", "僧": "seng", "争": "zheng", "证": "zheng",
  "挣": "zheng", "城": "cheng", "诚": "cheng", "承": "cheng", "升": "sheng", "绳": "sheng", "省": "sheng", "饶": "rao",
  "绕": "rao", "扰": "rao", "惹": "re", "肉": "rou", "柔": "rou", "赞": "zan", "灿": "can", "伞": "san",
  "咱": "zan", "暂": "zan", "藏": "cang", "桑": "sang", "嗓": "sang", "滋": "zi", "丝": "si", "紫": "zi",
  "瓷": "ci", "寺": "si", "恩": "en", "摁": "en", "昂": "ang", "肮": "ang", "翁": "weng", "嗡": "weng",
  "诶": "ei", "欸": "ei", "哦": "o", "噢": "o", "喔": "o", "耳": "er", "饵": "er", "案": "an",
  "按": "an", "岸": "an", "鞍": "an"
};

/* --- 第 5 组：短文常用字（补齐短文语料覆盖，含常见书面表达） --- */
export const CHARS_TIER5 = {
  "拼": "pin", "输": "shu", "每": "mei", "母": "mu", "盘": "pan", "显": "xian", "速": "su", "习": "xi",
  "牢": "lao", "刚": "gang", "始": "shi", "练": "lian", "降": "jiang", "历": "li", "阶": "jie", "段": "duan",
  "坚": "jian", "持": "chi", "钟": "zhong", "周": "zhou", "左": "zuo", "右": "you", "超": "chao", "清": "qing",
  "阳": "yang", "穿": "chuan", "户": "hu", "落": "luo", "桌": "zhuo", "泡": "pao", "杯": "bei", "茶": "cha",
  "脑": "nao", "雨": "yu", "屋": "wu", "檐": "yan", "让": "rang", "格": "ge", "句": "ju", "适": "shi",
  "忆": "yi", "复": "fu", "考": "kao", "某": "mou", "哪": "na", "师": "shi", "需": "xu", "屏": "ping",
  "幕": "mu", "坐": "zuo", "姿": "zi", "休": "xiu", "息": "xi", "隔": "ge", "站": "zhan", "远": "yuan",
  "风": "feng", "景": "jing", "效": "xiao", "缓": "huan", "睛": "jing", "颈": "jing", "椎": "zhui", "疲": "pi",
  "劳": "lao", "秋": "qiu", "田": "tian", "野": "ye", "幅": "fu", "画": "hua", "稻": "dao", "穗": "sui",
  "低": "di", "垂": "chui", "吹": "chui", "泛": "fan", "波": "bo", "浪": "lang", "雾": "wu", "笼": "long",
  "轮": "lun", "廓": "kuo", "谁": "shui", "淡": "dan", "墨": "mo", "扫": "sao", "笔": "bi", "堆": "dui",
  "杂": "za", "找": "zhao", "办": "ban", "耐": "nai", "今": "jin", "吗": "ma", "昨": "zuo", "百": "bai",
  "步": "bu", "往": "wang", "错": "cuo", "误": "wu", "遍": "bian", "末": "mo", "易": "yi", "微": "wei",
  "努": "nu", "叠": "die", "网": "wang", "络": "luo", "极": "ji", "快": "kuai", "具": "ju", "技": "ji",
  "演": "yan", "连": "lian", "终": "zhong", "依": "yi", "赖": "lai", "晰": "xi", "夏": "xia", "冬": "dong",
  "季": "ji", "转": "zhuan", "味": "wei", "验": "yan", "语": "yu", "言": "yan", "描": "miao", "述": "shu",
  "仍": "reng", "恰": "qia", "词": "ci", "概": "gai", "漫": "man", "瓶": "ping", "乎": "hu", "遇": "yu",
  "倍": "bei", "停": "ting", "析": "xi", "究": "jiu", "竟": "jing", "环": "huan", "拖": "tuo", "慢": "man",
  "专": "zhuan", "攻": "gong", "初": "chu", "改": "gai", "简": "jian", "单": "dan", "逐": "zhu", "渐": "jian",
  "汉": "han", "字": "zi", "音": "yin", "节": "jie", "拆": "chai", "键": "jian", "朋": "peng", "友": "you",
  "术": "shu"
};

/* --- 第 6 组：扩充常用字（生活、动作、书面表达，补齐短文语料） --- */
export const CHARS_TIER6 = {
  "早": "zao", "六": "liu", "午": "wu", "夜": "ye", "楼": "lou", "街": "jie", "房": "fang", "饭": "fan",
  "菜": "cai", "汤": "tang", "锅": "guo", "灶": "zao", "台": "tai", "厨": "chu", "亲": "qin", "孩": "hai",
  "园": "yuan", "椅": "yi", "树": "shu", "叶": "ye", "珠": "zhu", "帘": "lian", "灯": "deng", "盏": "zhan",
  "套": "tao", "扇": "shan", "袋": "dai", "罐": "guan", "响": "xiang", "闹": "nao", "掉": "diao", "拉": "la",
  "推": "tui", "挂": "gua", "撑": "cheng", "脚": "jiao", "腰": "yao", "肩": "jian", "脸": "lian", "嘴": "zui",
  "眉": "mei", "切": "qie", "倒": "dao", "洗": "xi", "擦": "ca", "煮": "zhu", "蒸": "zheng", "烤": "kao",
  "冒": "mao", "飘": "piao", "腾": "teng", "散": "san", "聚": "ju", "拢": "long", "洒": "sa", "写": "xie",
  "读": "du", "忘": "wang", "答": "da", "追": "zhui", "翻": "fan", "丢": "diu", "舍": "she", "留": "liu",
  "占": "zhan", "碰": "peng", "填": "tian", "排": "pai", "序": "xu", "组": "zu", "取": "qu", "退": "tui",
  "弃": "qi", "消": "xiao", "耗": "hao", "费": "fei", "流": "liu", "馈": "kui", "骗": "pian", "遗": "yi",
  "漏": "lou", "刻": "ke", "埋": "mai", "芽": "ya", "奏": "zou", "带": "dai", "绪": "xu", "存": "cun",
  "顺": "shun", "旦": "dan", "繁": "fan", "频": "pin", "注": "zhu", "暖": "nuan", "紧": "jin", "呼": "hu",
  "吸": "xi", "炖": "dun", "怕": "pa", "怎": "zen", "须": "xu", "底": "di", "算": "suan", "曲": "qu",
  "线": "xian", "似": "si", "偶": "ou", "晚": "wan", "质": "zhi", "例": "li", "执": "zhi", "维": "wei",
  "惯": "guan", "念": "nian", "塑": "su", "造": "zao", "容": "rong", "楚": "chu", "志": "zhi", "愿": "yuan",
  "望": "wang", "辨": "bian", "判": "pan", "断": "duan", "衡": "heng", "测": "ce", "评": "ping", "估": "gu",
  "筹": "chou", "划": "hua", "策": "ce", "践": "jian", "调": "tiao", "优": "you", "劣": "lie", "减": "jian",
  "积": "ji", "梯": "ti", "势": "shi", "躺": "tang", "蹲": "dun", "弯": "wan", "斜": "xie", "摇": "yao",
  "摆": "bai", "滚": "gun", "蓝": "lan", "铺": "pu", "啦": "la", "漉": "lu", "咳": "ke", "潦": "liao",
  "裹": "guo", "倦": "juan", "燥": "zao", "躁": "zao", "糊": "hu", "默": "mo", "忽": "hu", "附": "fu",
  "棋": "qi", "筝": "zheng", "影": "ying", "碌": "lu", "汽": "qi", "沿": "yan", "河": "he", "圈": "quan",
  "映": "ying", "聊": "liao", "混": "hun", "图": "tu", "馆": "guan", "照": "zhao", "木": "mu", "沙": "sha",
  "傍": "bang", "院": "yuan", "玩": "wan", "衣": "yi", "服": "fu", "片": "pian", "搬": "ban", "块": "kuai",
  "瓜": "gua", "吃": "chi", "骑": "qi", "车": "che", "摔": "shuai", "膝": "xi", "盖": "gai", "掌": "zhang",
  "红": "hong", "父": "fu", "扶": "fu", "爬": "pa", "米": "mi", "草": "cao", "失": "shi", "土": "tu",
  "突": "tu", "候": "hou", "黑": "hei", "久": "jiu", "属": "shu", "艺": "yi", "枯": "ku", "够": "gou",
  "拿": "na", "半": "ban", "途": "tu", "废": "fei", "讲": "jiang", "摊": "tan", "青": "qing", "买": "mai",
  "挑": "tiao", "砍": "kan", "价": "jia", "踏": "ta", "满": "man", "妨": "fang", "举": "ju", "延": "yan",
  "团": "tuan", "模": "mo", "否": "fou", "懂": "dong", "梳": "shu", "替": "ti", "津": "jin", "操": "cao",
  "独": "du", "矛": "mao", "盾": "dun", "待": "dai", "校": "xiao", "偏": "pian", "近": "jin", "背": "bei",
  "迁": "qian", "移": "yi"
};

/* --- 第 7 组：词组配套字（补齐词组语料，使「词组的每个字都能在单字模式练到」）---
   这些字原先只出现在词组里（如「喜欢」「选择」「健康」「备份」），
   单字模式却练不到，属于数据层的不一致。此处按主题分组补入，
   拼音取自词组数据本身，已逐字复核（含多音字：打折 zhe / 负载 zai /
   账号 hao / 选择 ze / 瑜伽 jia / 锲而不舍 qie）。 */
export const CHARS_TIER7 = {
  // 情感与态度
  "喜": "xi", "欢": "huan", "希": "xi", "爱": "ai", "焦": "jiao", "虑": "lv", "兴": "xing", "奋": "fen",
  "孤": "gu", "骄": "jiao", "傲": "ao", "谦": "qian", "虚": "xu", "幽": "you", "犹": "you", "豫": "lv",
  "若": "ruo", "苟": "gou", "迫": "po", "致": "zhi", "恒": "heng", "锲": "qie", "紊": "wen",
  // 健康与身体
  "健": "jian", "康": "kang", "眠": "mian", "免": "mian", "疫": "yi", "苗": "miao", "锻": "duan", "炼": "lian",
  "瑜": "yu", "伽": "jia", "篮": "lan", "球": "qiu", "足": "zu", "乒": "ping", "乓": "pang", "旋": "xuan",
  "捐": "juan", "躯": "qu", "夹": "jia", "察": "cha", "视": "shi",
  // 饮食与起居
  "奶": "nai", "鸡": "ji", "蛋": "dan", "蔬": "shu", "餐": "can", "厅": "ting", "碗": "wan", "刷": "shua",
  "牙": "ya", "酒": "jiu", "店": "dian", "火": "huo", "炉": "lu", "麦": "mai", "牛": "niu", "嗅": "xiu",
  // 出行与消费
  "购": "gou", "付": "fu", "款": "kuan", "递": "di", "包": "bao", "卖": "mai", "折": "zhe", "惠": "hui",
  "票": "piao", "拍": "pai", "航": "hang", "导": "dao", "铁": "tie", "李": "li", "览": "lan", "浏": "liu",
  // 技术与办公
  "器": "qi", "库": "ku", "码": "ma", "编": "bian", "译": "yi", "索": "suo", "引": "yin", "查": "cha",
  "份": "fen", "级": "ji", "限": "xian", "账": "zhang", "号": "hao", "册": "ce", "签": "qian", "协": "xie",
  "端": "duan", "迟": "chi", "集": "ji", "负": "fu", "载": "zai", "架": "jia", "构": "gou", "版": "ban",
  "署": "shu", "试": "shi", "项": "xiang", "客": "ke", "汇": "hui", "议": "yi",
  // 表达与书面
  "参": "can", "选": "xuan", "择": "ze", "备": "bei", "帮": "bang", "助": "zhu", "育": "yu", "济": "ji",
  "境": "jing", "标": "biao", "况": "kuang", "众": "zhong", "妇": "fu", "烂": "lan", "养": "yang", "童": "tong",
  "鹰": "ying", "互": "hu", "联": "lian", "星": "xing", "普": "pu", "功": "gong", "异": "yi", "渠": "qu",
  "井": "jing", "万": "wan", "竹": "zhu", "乍": "zha", "泄": "xie", "班": "ban", "印": "yin", "示": "shi",
  "摄": "she", "充": "chong", "室": "shi", "观": "guan", "融": "rong", "贯": "guan", "故": "gu", "补": "bu",
  "拙": "zhuo", "益": "yi", "抒": "shu", "登": "deng", "峰": "feng", "博": "bo", "源": "yuan", "石": "shi",
  "庭": "ting", "鼓": "gu", "松": "song", "温": "wen", "仔": "zi", "营": "ying", "夺": "duo", "换": "huan"
};

// 扩充语料所需字收入第七档，不改变前六档的学习范围。
Object.assign(CHARS_TIER7, EXTRA_CHARS);

/* 合并后的全量单字表 */
export const ALL_CHARS = Object.assign({}, CHARS_TIER1, CHARS_TIER2, CHARS_TIER3, CHARS_TIER4, CHARS_TIER5, CHARS_TIER6, CHARS_TIER7);

/* 供练习引擎使用的分层字表（数组形式，保持声明顺序即近似常用度顺序） */
export const CHAR_TIERS = [
  { id: 1, name: "高频字",   data: CHARS_TIER1 },
  { id: 2, name: "常用字",   data: CHARS_TIER2 },
  { id: 3, name: "中频字",   data: CHARS_TIER3 },
  { id: 4, name: "进阶字",   data: CHARS_TIER4 },
  { id: 5, name: "书面字",   data: CHARS_TIER5 },
  { id: 6, name: "扩充字",   data: CHARS_TIER6 },
  { id: 7, name: "词组配套", data: CHARS_TIER7 }
];

/* ============================================================
   二、常用词组（双字 / 三字 / 四字）
   格式：[汉字词组, 拼音, ...] 拼音与汉字一一对应
   用空白分隔连续拼音，便于阅读
   ============================================================ */

export const PHRASES = [
  ...EXTRA_PHRASES,
  // ---- 双字常用词（难度低） ----
  { w: "工作", p: ["gong", "zuo"], c: "office" }, { w: "时间", p: ["shi", "jian"], c: "daily" },
  { w: "问题", p: ["wen", "ti"], c: "daily" },   { w: "开始", p: ["kai", "shi"], c: "daily" },
  { w: "一起", p: ["yi", "qi"], c: "daily" },    { w: "现在", p: ["xian", "zai"], c: "daily" },
  { w: "什么", p: ["shen", "me"], c: "daily" },  { w: "可以", p: ["ke", "yi"], c: "daily" },
  { w: "生活", p: ["sheng", "huo"], c: "daily" },{ w: "中国", p: ["zhong", "guo"], c: "daily" },
  { w: "朋友", p: ["peng", "you"], c: "daily" }, { w: "孩子", p: ["hai", "zi"], c: "daily" },
  { w: "老师", p: ["lao", "shi"], c: "daily" },  { w: "学生", p: ["xue", "sheng"], c: "daily" },
  { w: "方法", p: ["fang", "fa"], c: "office" },  { w: "地方", p: ["di", "fang"], c: "daily" },
  { w: "意思", p: ["yi", "si"], c: "daily" },    { w: "事情", p: ["shi", "qing"], c: "daily" },
  { w: "喜欢", p: ["xi", "huan"], c: "daily" },  { w: "需要", p: ["xu", "yao"], c: "daily" },
  { w: "应该", p: ["ying", "gai"], c: "daily" }, { w: "知道", p: ["zhi", "dao"], c: "daily" },
  { w: "觉得", p: ["jue", "de"], c: "daily" },   { w: "希望", p: ["xi", "wang"], c: "daily" },
  { w: "发现", p: ["fa", "xian"], c: "daily" },  { w: "了解", p: ["liao", "jie"], c: "daily" },
  { w: "参加", p: ["can", "jia"], c: "daily" },  { w: "选择", p: ["xuan", "ze"], c: "daily" },
  { w: "准备", p: ["zhun", "bei"], c: "daily" }, { w: "决定", p: ["jue", "ding"], c: "daily" },
  { w: "完成", p: ["wan", "cheng"], c: "daily" },{ w: "提高", p: ["ti", "gao"], c: "daily" },
  { w: "理解", p: ["li", "jie"], c: "daily" },   { w: "帮助", p: ["bang", "zhu"], c: "daily" },
  { w: "影响", p: ["ying", "xiang"], c: "daily" },{ w: "关系", p: ["guan", "xi"], c: "daily" },
  { w: "发展", p: ["fa", "zhan"], c: "daily" },  { w: "教育", p: ["jiao", "yu"], c: "daily" },
  { w: "经济", p: ["jing", "ji"], c: "daily" },  { w: "社会", p: ["she", "hui"], c: "daily" },
  { w: "环境", p: ["huan", "jing"], c: "daily" },{ w: "健康", p: ["jian", "kang"], c: "daily" },
  { w: "技术", p: ["ji", "shu"], c: "office" },   { w: "系统", p: ["xi", "tong"], c: "office" },
  { w: "数据", p: ["shu", "ju"], c: "office" },   { w: "信息", p: ["xin", "xi"], c: "office" },
  { w: "网络", p: ["wang", "luo"], c: "office" }, { w: "内容", p: ["nei", "rong"], c: "office" },
  { w: "计划", p: ["ji", "hua"], c: "office" },   { w: "目标", p: ["mu", "biao"], c: "office" },
  { w: "结果", p: ["jie", "guo"], c: "office" },  { w: "原因", p: ["yuan", "yin"], c: "daily" },
  { w: "条件", p: ["tiao", "jian"], c: "office" },{ w: "过程", p: ["guo", "cheng"], c: "office" },

  // ---- 双字进阶词（含难键） ----
  { w: "状况", p: ["zhuang", "kuang"], c: "office" }, { w: "创造", p: ["chuang", "zao"], c: "daily" },
  { w: "双方", p: ["shuang", "fang"], c: "daily" },  { w: "黄色", p: ["huang", "se"], c: "daily" },
  { w: "阳光", p: ["yang", "guang"], c: "daily" },   { w: "永远", p: ["yong", "yuan"], c: "daily" },
  { w: "军队", p: ["jun", "dui"], c: "daily" },      { w: "群众", p: ["qun", "zhong"], c: "daily" },
  { w: "运动", p: ["yun", "dong"], c: "daily" },     { w: "寻找", p: ["xun", "zhao"], c: "daily" },
  { w: "绿色", p: ["lv", "se"], c: "daily" },        { w: "妇女", p: ["fu", "nv"], c: "daily" },
  { w: "月亮", p: ["yue", "liang"], c: "daily" },    { w: "学习", p: ["xue", "xi"], c: "daily" },
  { w: "确实", p: ["que", "shi"], c: "daily" },      { w: "绝对", p: ["jue", "dui"], c: "daily" },
  { w: "真实", p: ["zhen", "shi"], c: "daily" },     { w: "沉默", p: ["chen", "mo"], c: "daily" },
  { w: "深处", p: ["shen", "chu"], c: "daily" },     { w: "增长", p: ["zeng", "zhang"], c: "daily" },
  { w: "层次", p: ["ceng", "ci"], c: "daily" },      { w: "争论", p: ["zheng", "lun"], c: "daily" },
  { w: "城市", p: ["cheng", "shi"], c: "travel" },    { w: "声音", p: ["sheng", "yin"], c: "daily" },
  { w: "热爱", p: ["re", "ai"], c: "daily" },        { w: "柔软", p: ["rou", "ruan"], c: "daily" },
  { w: "赞美", p: ["zan", "mei"], c: "daily" },      { w: "灿烂", p: ["can", "lan"], c: "daily" },
  { w: "西藏", p: ["xi", "cang"], c: "travel" },      { w: "滋养", p: ["zi", "yang"], c: "daily" },
  { w: "恩情", p: ["en", "qing"], c: "daily" },      { w: "儿童", p: ["er", "tong"], c: "daily" },
  { w: "方案", p: ["fang", "an"], c: "office" },      { w: "雄鹰", p: ["xiong", "ying"], c: "daily" },

  // ---- 三字词 ----
  { w: "计算机", p: ["ji", "suan", "ji"], c: "office" },   { w: "互联网", p: ["hu", "lian", "wang"], c: "office" },
  { w: "服务器", p: ["fu", "wu", "qi"], c: "office" },     { w: "数据库", p: ["shu", "ju", "ku"], c: "office" },
  { w: "工程师", p: ["gong", "cheng", "shi"], c: "office" },{ w: "大学生", p: ["da", "xue", "sheng"], c: "daily" },
  { w: "星期天", p: ["xing", "qi", "tian"], c: "daily" }, { w: "普通话", p: ["pu", "tong", "hua"], c: "daily" },
  { w: "理解力", p: ["li", "jie", "li"], c: "daily" },    { w: "新时代", p: ["xin", "shi", "dai"], c: "daily" },
  { w: "双拼法", p: ["shuang", "pin", "fa"], c: "daily" },{ w: "键盘上", p: ["jian", "pan", "shang"], c: "daily" },

  // ---- 四字成语 ----
  { w: "一举两得", p: ["yi", "ju", "liang", "de"], c: "idiom" },
  { w: "事半功倍", p: ["shi", "ban", "gong", "bei"], c: "idiom" },
  { w: "熟能生巧", p: ["shu", "neng", "sheng", "qiao"], c: "idiom" },
  { w: "脚踏实地", p: ["jiao", "ta", "shi", "di"], c: "idiom" },
  { w: "全心全意", p: ["quan", "xin", "quan", "yi"], c: "idiom" },
  { w: "实事求是", p: ["shi", "shi", "qiu", "shi"], c: "idiom" },
  { w: "日新月异", p: ["ri", "xin", "yue", "yi"], c: "idiom" },
  { w: "水到渠成", p: ["shui", "dao", "qu", "cheng"], c: "idiom" },
  { w: "长年累月", p: ["chang", "nian", "lei", "yue"], c: "idiom" },
  { w: "力所能及", p: ["li", "suo", "neng", "ji"], c: "idiom" },
  { w: "井然有序", p: ["jing", "ran", "you", "xu"], c: "idiom" },
  { w: "万象更新", p: ["wan", "xiang", "geng", "xin"], c: "idiom" },
  { w: "胸有成竹", p: ["xiong", "you", "cheng", "zhu"], c: "idiom" },
  { w: "绿色出行", p: ["lv", "se", "chu", "xing"], c: "travel" },
  { w: "群策群力", p: ["qun", "ce", "qun", "li"], c: "idiom" },
  { w: "春光乍泄", p: ["chun", "guang", "zha", "xie"], c: "idiom" },

  // ---- 扩充词组 ----
  { w: "加班", p: ["jia", "ban"], c: "office" },
  { w: "面试", p: ["mian", "shi"], c: "office" },
  { w: "简历", p: ["jian", "li"], c: "office" },
  { w: "同事", p: ["tong", "shi"], c: "office" },
  { w: "汇报", p: ["hui", "bao"], c: "office" },
  { w: "会议", p: ["hui", "yi"], c: "office" },
  { w: "项目", p: ["xiang", "mu"], c: "office" },
  { w: "客户", p: ["ke", "hu"], c: "office" },
  { w: "需求", p: ["xu", "qiu"], c: "office" },
  { w: "反馈", p: ["fan", "kui"], c: "office" },
  { w: "版本", p: ["ban", "ben"], c: "office" },
  { w: "测试", p: ["ce", "shi"], c: "office" },
  { w: "部署", p: ["bu", "shu"], c: "office" },
  { w: "运维", p: ["yun", "wei"], c: "office" },
  { w: "架构", p: ["jia", "gou"], c: "office" },
  { w: "模块", p: ["mo", "kuai"], c: "office" },
  { w: "接口", p: ["jie", "kou"], c: "office" },
  { w: "算法", p: ["suan", "fa"], c: "office" },
  { w: "代码", p: ["dai", "ma"], c: "office" },
  { w: "调试", p: ["tiao", "shi"], c: "office" },
  { w: "编译", p: ["bian", "yi"], c: "office" },
  { w: "运行", p: ["yun", "xing"], c: "office" },
  { w: "性能", p: ["xing", "neng"], c: "office" },
  { w: "内存", p: ["nei", "cun"], c: "office" },
  { w: "线程", p: ["xian", "cheng"], c: "office" },
  { w: "进程", p: ["jin", "cheng"], c: "office" },
  { w: "缓存", p: ["huan", "cun"], c: "office" },
  { w: "索引", p: ["suo", "yin"], c: "office" },
  { w: "查询", p: ["cha", "xun"], c: "office" },
  { w: "备份", p: ["bei", "fen"], c: "office" },
  { w: "迁移", p: ["qian", "yi"], c: "office" },
  { w: "升级", p: ["sheng", "ji"], c: "office" },
  { w: "权限", p: ["quan", "xian"], c: "office" },
  { w: "密码", p: ["mi", "ma"], c: "office" },
  { w: "账号", p: ["zhang", "hao"], c: "office" },
  { w: "注册", p: ["zhu", "ce"], c: "office" },
  { w: "加密", p: ["jia", "mi"], c: "office" },
  { w: "签名", p: ["qian", "ming"], c: "office" },
  { w: "协议", p: ["xie", "yi"], c: "office" },
  { w: "端口", p: ["duan", "kou"], c: "office" },
  { w: "带宽", p: ["dai", "kuan"], c: "office" },
  { w: "延迟", p: ["yan", "chi"], c: "office" },
  { w: "并发", p: ["bing", "fa"], c: "office" },
  { w: "集群", p: ["ji", "qun"], c: "office" },
  { w: "负载", p: ["fu", "zai"], c: "office" },
  { w: "起床", p: ["qi", "chuang"], c: "daily" },
  { w: "刷牙", p: ["shua", "ya"], c: "daily" },
  { w: "洗脸", p: ["xi", "lian"], c: "daily" },
  { w: "早饭", p: ["zao", "fan"], c: "daily" },
  { w: "午饭", p: ["wu", "fan"], c: "daily" },
  { w: "晚饭", p: ["wan", "fan"], c: "daily" },
  { w: "做饭", p: ["zuo", "fan"], c: "daily" },
  { w: "洗碗", p: ["xi", "wan"], c: "daily" },
  { w: "扫地", p: ["sao", "di"], c: "daily" },
  { w: "购物", p: ["gou", "wu"], c: "daily" },
  { w: "超市", p: ["chao", "shi"], c: "daily" },
  { w: "排队", p: ["pai", "dui"], c: "daily" },
  { w: "付款", p: ["fu", "kuan"], c: "daily" },
  { w: "快递", p: ["kuai", "di"], c: "daily" },
  { w: "包裹", p: ["bao", "guo"], c: "daily" },
  { w: "外卖", p: ["wai", "mai"], c: "daily" },
  { w: "餐厅", p: ["can", "ting"], c: "daily" },
  { w: "菜单", p: ["cai", "dan"], c: "daily" },
  { w: "结账", p: ["jie", "zhang"], c: "daily" },
  { w: "打折", p: ["da", "zhe"], c: "daily" },
  { w: "优惠", p: ["you", "hui"], c: "daily" },
  { w: "公交", p: ["gong", "jiao"], c: "travel" },
  { w: "地铁", p: ["di", "tie"], c: "travel" },
  { w: "火车", p: ["huo", "che"], c: "travel" },
  { w: "航班", p: ["hang", "ban"], c: "travel" },
  { w: "机场", p: ["ji", "chang"], c: "travel" },
  { w: "车站", p: ["che", "zhan"], c: "travel" },
  { w: "导航", p: ["dao", "hang"], c: "travel" },
  { w: "路线", p: ["lu", "xian"], c: "travel" },
  { w: "旅行", p: ["lv", "xing"], c: "travel" },
  { w: "行李", p: ["xing", "li"], c: "travel" },
  { w: "酒店", p: ["jiu", "dian"], c: "travel" },
  { w: "景点", p: ["jing", "dian"], c: "travel" },
  { w: "门票", p: ["men", "piao"], c: "travel" },
  { w: "拍照", p: ["pai", "zhao"], c: "travel" },
  { w: "相册", p: ["xiang", "ce"], c: "daily" },
  { w: "聊天", p: ["liao", "tian"], c: "daily" },
  { w: "散步", p: ["san", "bu"], c: "daily" },
  { w: "逛街", p: ["guang", "jie"], c: "daily" },
  { w: "开心", p: ["kai", "xin"], c: "daily" },
  { w: "难过", p: ["nan", "guo"], c: "daily" },
  { w: "紧张", p: ["jin", "zhang"], c: "daily" },
  { w: "放松", p: ["fang", "song"], c: "daily" },
  { w: "焦虑", p: ["jiao", "lv"], c: "daily" },
  { w: "平静", p: ["ping", "jing"], c: "daily" },
  { w: "兴奋", p: ["xing", "fen"], c: "daily" },
  { w: "失望", p: ["shi", "wang"], c: "daily" },
  { w: "期待", p: ["qi", "dai"], c: "daily" },
  { w: "感动", p: ["gan", "dong"], c: "daily" },
  { w: "温暖", p: ["wen", "nuan"], c: "daily" },
  { w: "孤独", p: ["gu", "du"], c: "daily" },
  { w: "骄傲", p: ["jiao", "ao"], c: "daily" },
  { w: "谦虚", p: ["qian", "xu"], c: "daily" },
  { w: "幽默", p: ["you", "mo"], c: "daily" },
  { w: "认真", p: ["ren", "zhen"], c: "daily" },
  { w: "仔细", p: ["zi", "xi"], c: "daily" },
  { w: "粗心", p: ["cu", "xin"], c: "daily" },
  { w: "耐心", p: ["nai", "xin"], c: "daily" },
  { w: "果断", p: ["guo", "duan"], c: "daily" },
  { w: "犹豫", p: ["you", "lv"], c: "daily" },
  { w: "睡眠", p: ["shui", "mian"], c: "daily" },
  { w: "营养", p: ["ying", "yang"], c: "daily" },
  { w: "蔬菜", p: ["shu", "cai"], c: "daily" },
  { w: "水果", p: ["shui", "guo"], c: "daily" },
  { w: "牛奶", p: ["niu", "nai"], c: "daily" },
  { w: "面包", p: ["mian", "bao"], c: "daily" },
  { w: "鸡蛋", p: ["ji", "dan"], c: "daily" },
  { w: "味觉", p: ["wei", "jue"], c: "daily" },
  { w: "嗅觉", p: ["xiu", "jue"], c: "daily" },
  { w: "视觉", p: ["shi", "jue"], c: "daily" },
  { w: "听觉", p: ["ting", "jue"], c: "daily" },
  { w: "呼吸", p: ["hu", "xi"], c: "daily" },
  { w: "循环", p: ["xun", "huan"], c: "daily" },
  { w: "消化", p: ["xiao", "hua"], c: "daily" },
  { w: "免疫", p: ["mian", "yi"], c: "daily" },
  { w: "疫苗", p: ["yi", "miao"], c: "daily" },
  { w: "锻炼", p: ["duan", "lian"], c: "daily" },
  { w: "跑步", p: ["pao", "bu"], c: "daily" },
  { w: "游泳", p: ["you", "yong"], c: "daily" },
  { w: "瑜伽", p: ["yu", "jia"], c: "daily" },
  { w: "太极", p: ["tai", "ji"], c: "daily" },
  { w: "篮球", p: ["lan", "qiu"], c: "daily" },
  { w: "足球", p: ["zu", "qiu"], c: "daily" },
  { w: "乒乓", p: ["ping", "pang"], c: "daily" },
  { w: "女装", p: ["nv", "zhuang"], c: "daily" },
  { w: "虐待", p: ["nve", "dai"], c: "daily" },
  { w: "掠夺", p: ["lve", "duo"], c: "daily" },
  { w: "旋律", p: ["xuan", "lv"], c: "daily" },
  { w: "效率", p: ["xiao", "lv"], c: "office" },
  { w: "捐躯", p: ["juan", "qu"], c: "daily" },
  { w: "输入法", p: ["shu", "ru", "fa"], c: "office" },
  { w: "文件夹", p: ["wen", "jian", "jia"], c: "office" },
  { w: "浏览器", p: ["liu", "lan", "qi"], c: "office" },
  { w: "交换机", p: ["jiao", "huan", "ji"], c: "office" },
  { w: "打印机", p: ["da", "yin", "ji"], c: "office" },
  { w: "显示屏", p: ["xian", "shi", "ping"], c: "office" },
  { w: "摄像头", p: ["she", "xiang", "tou"], c: "office" },
  { w: "麦克风", p: ["mai", "ke", "feng"], c: "office" },
  { w: "充电器", p: ["chong", "dian", "qi"], c: "office" },
  { w: "公交车", p: ["gong", "jiao", "che"], c: "travel" },
  { w: "电影院", p: ["dian", "ying", "yuan"], c: "daily" },
  { w: "图书馆", p: ["tu", "shu", "guan"], c: "daily" },
  { w: "实验室", p: ["shi", "yan", "shi"], c: "daily" },
  { w: "观察力", p: ["guan", "cha", "li"], c: "daily" },
  { w: "记忆力", p: ["ji", "yi", "li"], c: "daily" },
  { w: "想象力", p: ["xiang", "xiang", "li"], c: "daily" },
  { w: "创造力", p: ["chuang", "zao", "li"], c: "daily" },
  { w: "注意力", p: ["zhu", "yi", "li"], c: "daily" },
  { w: "专心致志", p: ["zhuan", "xin", "zhi", "zhi"], c: "idiom" },
  { w: "持之以恒", p: ["chi", "zhi", "yi", "heng"], c: "idiom" },
  { w: "锲而不舍", p: ["qie", "er", "bu", "she"], c: "idiom" },
  { w: "循序渐进", p: ["xun", "xu", "jian", "jin"], c: "idiom" },
  { w: "举一反三", p: ["ju", "yi", "fan", "san"], c: "idiom" },
  { w: "融会贯通", p: ["rong", "hui", "guan", "tong"], c: "idiom" },
  { w: "温故知新", p: ["wen", "gu", "zhi", "xin"], c: "idiom" },
  { w: "学以致用", p: ["xue", "yi", "zhi", "yong"], c: "idiom" },
  { w: "勤能补拙", p: ["qin", "neng", "bu", "zhuo"], c: "idiom" },
  { w: "精益求精", p: ["jing", "yi", "qiu", "jing"], c: "idiom" },
  { w: "一丝不苟", p: ["yi", "si", "bu", "gou"], c: "idiom" },
  { w: "各抒己见", p: ["ge", "shu", "ji", "jian"], c: "idiom" },
  { w: "集思广益", p: ["ji", "si", "guang", "yi"], c: "idiom" },
  { w: "身体力行", p: ["shen", "ti", "li", "xing"], c: "idiom" },
  { w: "心平气和", p: ["xin", "ping", "qi", "he"], c: "idiom" },
  { w: "从容不迫", p: ["cong", "rong", "bu", "po"], c: "idiom" },
  { w: "井井有条", p: ["jing", "jing", "you", "tiao"], c: "idiom" },
  { w: "有条不紊", p: ["you", "tiao", "bu", "wen"], c: "idiom" },
  { w: "恰到好处", p: ["qia", "dao", "hao", "chu"], c: "idiom" },
  { w: "炉火纯青", p: ["lu", "huo", "chun", "qing"], c: "idiom" },
  { w: "登峰造极", p: ["deng", "feng", "zao", "ji"], c: "idiom" },
  { w: "博大精深", p: ["bo", "da", "jing", "shen"], c: "idiom" },
  { w: "源远流长", p: ["yuan", "yuan", "liu", "chang"], c: "idiom" },
  { w: "厚积薄发", p: ["hou", "ji", "bo", "fa"], c: "idiom" },
  { w: "水落石出", p: ["shui", "luo", "shi", "chu"], c: "idiom" },
  { w: "门庭若市", p: ["men", "ting", "ruo", "shi"], c: "idiom" },
  { w: "百发百中", p: ["bai", "fa", "bai", "zhong"], c: "idiom" },
  { w: "众所周知", p: ["zhong", "suo", "zhou", "zhi"], c: "idiom" },
  { w: "一鼓作气", p: ["yi", "gu", "zuo", "qi"], c: "idiom" },
  { w: "马到成功", p: ["ma", "dao", "cheng", "gong"], c: "idiom" }
];

/* ============================================================
   三、短文（跟打用，含标点）
   每段约 60–140 字，覆盖常见标点：，。、；：？！「」“”
   ============================================================ */

export const PASSAGES = [
  ...EXTRA_PASSAGES,
  {
    t: "双拼是一种汉字输入方法，它把每个音节拆成声母和韵母两部分，分别对应键盘上的两个键。相比全拼，双拼的按键次数更少，长期使用可以明显提高打字速度。",
    d: 1
  },
  {
    t: "学习双拼并不难，难的是把键位记牢。刚开始练习时，速度会明显下降，这是每个人都会经历的阶段。只要坚持每天练习二十分钟，两周左右就能超过原来的全拼速度。",
    d: 1
  },
  {
    t: "清晨的阳光穿过窗户，落在书桌上。我泡了一杯热茶，打开电脑，开始一天的工作。键盘的声音很轻，像是雨点落在屋檐上，让人心里格外安静。",
    d: 1
  },
  {
    t: "熟能生巧，这句话用在打字上再合适不过。手指的记忆来自重复，当你不必再思考某个韵母在哪个键上时，真正的速度才开始出现。",
    d: 2
  },
  {
    t: "工程师们常常需要长时间面对屏幕，因此正确的坐姿和适当的休息非常重要。每隔四十分钟站起来活动一下，看看远处的风景，能有效缓解眼睛和颈椎的疲劳。",
    d: 2
  },
  {
    t: "秋天的田野是一幅金色的画。稻穗低垂着头，风吹过时泛起层层波浪。远处的山被薄雾笼着，轮廓柔和，像是谁用淡墨轻轻扫过一笔。",
    d: 2
  },
  {
    t: "数据不会说谎，但它也不会自己开口。真正的能力，是从一堆杂乱的数字里看出问题所在，并且找到可以落地的解决办法。这需要耐心，也需要一点想象力。",
    d: 2
  },
  {
    t: "「你今天练习了吗？」朋友问我。我点点头，说：「练了三十分钟，正确率比昨天高了两个百分点。」他笑了：「坚持下去，等到某一天你会发现，指尖已经记住了整张键盘。」",
    d: 3
  },
  {
    t: "真正的进步，往往发生在那些不起眼的日常里：每天多练五分钟，每次错误后多回想一遍拆分方式，每个周末把易错的字重新过一遍。时间会把微小的努力叠成厚厚的成果。",
    d: 3
  },
  {
    t: "网络世界变化极快，新的工具层出不穷。但无论技术如何演进，人与信息的连接始终依赖两个基本能力：快速准确地输入，以及清晰有条理地思考。前者是手的事，后者是脑的事。",
    d: 3
  },
  {
    t: "春、夏、秋、冬，四季轮转；酸、甜、苦、辣，百味人生。有些体验无法用语言精确描述，但我们仍然努力寻找最恰当的词——这大概就是表达的意义。",
    d: 3
  },
  {
    t: "在漫长的学习过程中，瓶颈期几乎是必然会遇到的。此时最重要的不是加倍苦练，而是停下来分析：究竟是哪个环节拖慢了你？找出它，专门攻克它，然后你会发现自己又向前走了一大步。",
    d: 3
  },

  // ---- 扩充短文 ----
  {
    t: "早晨六点，闹钟响了。我关掉它，拉开窗帘，天边刚泛起一点淡蓝。楼下的早点铺已经开门，热气从蒸笼里冒出来，飘得很远。",
    d: 1
  },
  {
    t: "周末的下午，我常去附近的公园走走。老人下棋，孩子追着风筝跑，长椅上有人看书。树影落在地上，风一吹就散开，又慢慢聚拢。",
    d: 1
  },
  {
    t: "厨房里飘出饭菜的香味，母亲在灶台前忙碌。她把切好的菜倒进锅里，滋啦一声，白汽腾起。我站在门口看着，忽然觉得这样的画面最让人安心。",
    d: 1
  },
  {
    t: "雨下了整整一夜。早上推开门，空气湿漉漉的，路边的叶子挂着水珠。行人撑起伞，脚步比平时慢了许多，整条街都安静了下来。",
    d: 1
  },
  {
    t: "晚饭后，我习惯沿着河边走一圈。水面映着路灯，一圈圈地晃动。有小孩在岸边追跑，也有老人坐在椅子上聊天，声音很轻，混在风里。",
    d: 1
  },
  {
    t: "图书馆的下午总是很安静。阳光从高窗照进来，落在长长的木桌上。翻书的声音、写字的沙沙声，还有偶尔的一声轻咳，就是这里的全部动静。",
    d: 1
  },
  {
    t: "夏天的傍晚，天还很亮。孩子们在院子里玩水，衣服湿了一大片也不在乎。大人搬出小桌，切一块西瓜，边吃边聊，直到天色完全暗下来。",
    d: 1
  },
  {
    t: "第一次学骑车时，我摔了好几回。膝盖破了，手掌也擦红了。父亲没有扶我，只是站在几步之外说：「再来一次。」于是我又爬上去，慢慢骑了三米。",
    d: 1
  },
  {
    t: "写字这件事，看上去简单，其实很考验耐性。一笔一画都要稳，急不得；写快了容易潦草，写慢了又失了气韵。练字的过程，也是在练心。",
    d: 2
  },
  {
    t: "读书的好处不会立刻显现，它像往土里埋种子，看不见动静，却在某个时刻突然发芽。你读过的句子会变成自己的语言，藏在说话和思考的方式里。",
    d: 2
  },
  {
    t: "一个人走路的时候，脑子往往最清醒。脚步的节奏会带着思绪往前走，许多白天想不通的问题，常常在这样的时候忽然有了答案。",
    d: 2
  },
  {
    t: "好的工具能让人忘记工具的存在。用起来顺手，就不会再想起它；一旦频繁出问题，注意力便全被拖走。软件如此，键盘如此，生活里许多东西也如此。",
    d: 2
  },
  {
    t: "北方的冬天，天黑得早。四点多钟，天色就暗下来，路灯一盏盏亮起。行人裹紧外套，呼出的白气很快散在风里。屋里却是暖的，锅里炖着热汤。",
    d: 2
  },
  {
    t: "把一件复杂的事拆开，往往就没有那么可怕了。先看它由哪几部分组成，再想每一部分该怎么做，最后排个先后顺序。真正难的是拆之前的那一步：动手。",
    d: 2
  },
  {
    t: "整理房间的时候，我总会翻出一些很久没用的东西。丢掉舍不得，留着又占地方。后来学会一个办法：如果一年都没碰过，就说明它已经不属于现在的生活。",
    d: 2
  },
  {
    t: "学一门手艺，头几天最有意思，样样新鲜；过了一周就开始枯燥，动作重复，进步也慢。许多人在这里停下。其实再往前走一段，手感就会自己长出来。",
    d: 2
  },
  {
    t: "写日记不必求长。每天三五句，记下当天最想说的一件事就够了。日子久了回看，你会发现那些当时觉得平淡的片段，反而最经得起反复读。",
    d: 2
  },
  {
    t: "饭要一口一口吃，路要一步一步走。道理听上去老套，却很少有人真正做到。我们总想跳过过程直接拿到结果，于是急、于是躁，于是半途而废。",
    d: 2
  },
  {
    t: "和人说话时，先听完再回答，比急着表达自己更有用。多数误会不是因为谁说得不够清楚，而是因为谁都没有等对方把话讲完。",
    d: 2
  },
  {
    t: "菜市场的早晨最热闹。摊主把青菜摆成整齐的一排，水珠还挂在叶子上；买菜的人提着袋子，一边挑一边砍价。声音混在一起，却让人觉得踏实。",
    d: 2
  },
  {
    t: "「这个键到底在哪儿？」新手常这样问。答案其实不在键盘上，而在手指的记忆里。当你不再需要低头去找，输入才算真正变成了本能。",
    d: 3
  },
  {
    t: "所有技能的成长曲线都相似：起初进步很快，中间会有一段漫长的平台期，看不出变化，甚至偶尔倒退。多数人在这里放弃，而越过它的人，往往只是多坚持了几周。",
    d: 3
  },
  {
    t: "效率不是把每一分钟都填满。恰恰相反，它是知道哪些事可以不做，哪些事可以晚一点做，哪些事必须现在就做。取舍的能力，比努力更稀缺。",
    d: 3
  },
  {
    t: "语言塑造思维。你习惯用哪些词，就会更容易注意到哪些细节；你缺少某个概念，就可能长久地忽略某种感受。学习新词，有时是在为自己打开一扇窗。",
    d: 3
  },
  {
    t: "清晨、午后、深夜——一天里最安静的几个时刻，思考的质量往往最高。不是因为那时更聪明，而是因为外界的干扰少，注意力终于能完整地停留在同一件事上。",
    d: 3
  },
  {
    t: "习惯的力量在于它几乎不需要消耗意志。决定一旦变成惯例，执行就不再费力。所以改变自己的关键，不是下更大的决心，而是设计一个更容易坚持的流程。",
    d: 3
  },
  {
    t: "「熟能生巧」四个字里，藏着一个容易被忽略的前提：每次练习都要有反馈。重复本身不会带来进步，只有知道哪里错了、并且下一次改过来，才算真正的重复。",
    d: 3
  },
  {
    t: "记忆是会骗人的。我们总以为自己记得很清楚，可一旦要复述细节，才发现遗漏了许多。所以重要的事应当写下来——不是为了记住，而是为了看清自己记错了什么。",
    d: 3
  },
  {
    t: "衡量一段学习的质量，不妨问自己三个问题：能不能用自己的话说清楚？能不能举出一个反例？能不能在新的场景里用出来？三问都答得上，才算真的学会了。",
    d: 3
  },
  {
    t: "拖延往往不是因为懒，而是因为任务在脑子里是一团模糊的东西。把它写成一张清单，每一条都具体到「下一步做什么」，那团雾就会散去，手也就动得起来了。",
    d: 3
  },
  {
    t: "判断一个人是否真的懂了某件事，最直接的办法是让他讲给外行听。如果对方听明白了，说明自己也梳理清楚了；如果越讲越绕，那多半是中间还有没想通的地方。",
    d: 3
  },
  {
    t: "技术的更替越来越快，今天熟练的工具，几年后可能无人问津。比记住某个具体操作更重要的，是理解它背后的思路——思路会迁移，操作却会过期。",
    d: 3
  },
  {
    t: "独处与合群并不矛盾。一个人待着的时候，你整理自己的判断；和别人相处的时候，你校正自己的判断。两边都要有，缺了哪一边都容易走偏。",
    d: 3
  }
];

/* ============================================================
   四、声母 / 韵母 / 音节表
   ============================================================ */

/* 双拼（及全拼）中会出现的声母，按长度从长到短排列，用于最长匹配切分 */
export const SHENGMU_LIST = [
  "zh", "ch", "sh",
  "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h",
  "j", "q", "x", "r", "z", "c", "s", "y", "w"
];

export const SHENGMU_SET = new Set(SHENGMU_LIST);

/* 全部合法韵母（不含声母），同样按长度降序用于最长匹配 */
export const YUNMU_LIST = [
  "iang", "iong", "uang", "ueng",
  "ang", "eng", "ing", "ong", "ian", "iao", "iou", "uai", "uan", "uen", "uong",
  "ai", "an", "ao", "ei", "en", "er", "ia", "ie", "in", "iu", "ou",
  "ua", "ue", "ui", "un", "uo", "ve",
  "a", "e", "i", "o", "u", "v"
];

export const YUNMU_SET = new Set(YUNMU_LIST);

/**
 * 声母拼写 → 双拼取键字母
 * 小鹤中 zh/ch/sh 的键位就是 Z/C/S（与单字母声母相同），
 * 因此这里主要用于「显示」，让学习者看到 zh→Z 的对应关系。
 */
export const SHENGMU_KEY_DISPLAY = {
  zh: "Z", ch: "C", sh: "S"
};

/**
 * 韵母拼写 → 小鹤双拼键字母（反向索引，用于「全键盘上带声调韵母」的考试/查询）
 * 注意：同一韵母可能有多个键（见 zuo-luo 分布的 v=zh/ü/ue/ve），此处取规范主键。
 */
export const YUNMU_TO_KEY_DISPLAY = {
  "ong": "S", "iong": "S",
  "iu": "Q", "ei": "W", "e": "E", "uan": "R", "er": "R",
  "ue": "T", "ve": "T", "un": "Y", "uai": "Y", "u": "U",
  "i": "I", "uo": "O", "o": "O", "ie": "P", "ai": "D",
  "en": "F", "eng": "G", "ang": "H", "an": "J", "uang": "L",
  "iang": "L", "ou": "Z", "ua": "X", "ia": "X", "ao": "C",
  "ui": "V", "ing": "K", "in": "B", "iao": "N", "ian": "M",
  "a": "A", "v": "V"
};
