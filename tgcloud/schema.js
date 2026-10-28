import { table, integer, text, uniqueIndex } from 'sdk/db';

// ---- дерево чата (xref-идентичность, как в гедкоме; с 2026-10-21) ----
// Источник истины — indi/fam/chil/edges: свадьба всегда привязана к xref'ам
// супругов, «Имя Д» и «Имя+Имя Д» — производные виды (lib/bot.js).
// Импорт = замена (очистка чата + вставка); поисков «по первому имени» нет.

// персона чата; birtD NULL — заглушка-половина свадьбы (имя без даты)
export const indi = table('indi', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  xref: text('xref').notNull(),   // из файла («I1») либо синтез («P1»/«S1»)
  name: text('name').notNull(),
  birtD: text('birt_d'),          // 'YYYY-MM-DD' (МСК); null у заглушек
  birtH: integer('birt_h'),       // МСК-время (из триггера)
  birtM: integer('birt_m'),
  srcH: integer('src_h'),         // исходное местное время рождения (2 TIME)
  srcM: integer('src_m'),
  deatD: text('deat_d'),
  deatH: integer('deat_h'), deatM: integer('deat_m'),
  dsrcH: integer('dsrc_h'), dsrcM: integer('dsrc_m'),
  sex: text('sex'),               // 'M'|'F'|null
  plac: text('plac'),             // город из скобок (BIRT PLAC)
  deatPlac: text('deat_plac'),    // место смерти/похорон (DEAT/BURI PLAC)
  note: text('note'),             // примечание (хвост строки целиком; 1 NOTE)
}, (t) => ({
  uq: uniqueIndex('uq_indi_xref').on(t.chatId, t.xref),
}));

// пара: husb/wife — xref'ы indi (null допустим); свадьба/развод живут здесь
// (adHoc — интерактивная семья «на ребёнка», у импортных fam — xref файла)
export const fam = table('fam', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  xref: text('xref').notNull(),   // из файла («F1») либо синтез («L1»/«W1»)
  adhoc: integer('adhoc', { mode: 'boolean' }).default(false),
  husb: text('husb'), wife: text('wife'),
  marrD: text('marr_d'), marrPlac: text('marr_plac'),
  divD: text('div_d'), divPlac: text('div_plac'),
  note: text('note'),             // примечание строки свадьбы (1 NOTE у FAM)
}, (t) => ({
  uq: uniqueIndex('uq_fam_xref').on(t.chatId, t.xref),
}));

// ребёнок в семье (adopted — 🤱 усыновление)
export const chil = table('chil', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  fam: text('fam').notNull(),     // xref fam
  indi: text('indi').notNull(),   // xref indi
  adopted: integer('adopted', { mode: 'boolean' }).default(false),
}, (t) => ({
  uq: uniqueIndex('uq_chil').on(t.chatId, t.fam, t.indi),
}));

// ребро родитель→ребёнок «Имя Д» + состояние сообщения-связи
// (who/pairCand); famXref — семья, породившая ребро
export const edges = table('edges', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  parent: text('parent').notNull(),
  child: text('child').notNull(),
  who: text('who').notNull(),     // 'p'|'c' — кто пришёл новым триггером
  famXref: text('fam_xref'),      // xref fam (после addLink/confirmPair)
  pairCand: text('pair_cand'),    // JSON: кандидаты-свадьбы {pair, other, wy, fx}
}, (t) => ({
  uq: uniqueIndex('uq_edge').on(t.chatId, t.parent, t.child),
}));

export const settings = table('settings', {
  chatId: integer('chat_id').primaryKey(),
  orth: integer('orth', { mode: 'boolean' }).default(false),
  islam: integer('islam', { mode: 'boolean' }).default(false),
  bud: integer('bud', { mode: 'boolean' }).default(false),
  cath: integer('cath', { mode: 'boolean' }).default(false),
  jud: integer('jud', { mode: 'boolean' }).default(false),
  bell: integer('bell', { mode: 'boolean' }).default(true), // подписка 🔔 (история; подписки больше нет, дамп всегда)
});

// дропнутый в чат .ged-файл: ждёт «Да/Нет» на вопрос об импорте
// (stateless-окружение — текст файла живёт в БД; последний дроп выигрывает)
export const gedDrops = table('ged_drops', {
  chatId: integer('chat_id').primaryKey(),
  fromId: integer('from_id').notNull(),  // кто дропнул (кнопки — только ему)
  fileName: text('file_name').notNull(),
  content: text('content').notNull(),    // сырой текст .ged (UTF-8)
  ts: integer('ts').notNull(),           // epoch ms; старше часа — «файл не найден»
});

// фокус-сообщение («/» ответом на триггер): персона и текущий радиус родни;
// callback_data короткий, ключ персоны живёт здесь (по сообщению с кнопками)
export const focusView = table('focus_view', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  messageId: integer('message_id').notNull(), // сообщение-фокус (бота)
  pkey: text('pkey').notNull(),               // «Имя ГГГГ-ММ-ДД»
  radius: integer('radius').notNull(),        // 1..5
  ts: integer('ts').notNull(),                // epoch ms; чистка старше 7 суток
}, (t) => ({
  uq: uniqueIndex('uq_focus_msg').on(t.chatId, t.messageId),
}));
