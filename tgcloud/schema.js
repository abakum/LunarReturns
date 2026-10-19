import { table, integer, text, uniqueIndex } from 'sdk/db';

export const events = table('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  name: text('name').notNull(),
  date: text('date').notNull(), // 'YYYY-MM-DD' (МСК)
  hour: integer('hour'),        // null = без времени
  minute: integer('minute'),
  sex: text('sex'),             // 'M'|'F' — для гедком
  deathDate: text('death_date'),// хвост смерти/развода (для гедком)
  plac: text('plac'),           // город из скобок (PLAC)
  plac2: text('plac2'),         // город хвоста (место развода)
  srcH: integer('src_h'),       // исходное местное время рождения (2 TIME)
  srcM: integer('src_m'),
  dsrcH: integer('dsrc_h'),     // исходное время смерти/развода (2 TIME)
  dsrcM: integer('dsrc_m'),
}, (t) => ({
  uq: uniqueIndex('uq_event').on(t.chatId, t.name, t.date),
}));

export const settings = table('settings', {
  chatId: integer('chat_id').primaryKey(),
  orth: integer('orth', { mode: 'boolean' }).default(false),
  islam: integer('islam', { mode: 'boolean' }).default(false),
  bud: integer('bud', { mode: 'boolean' }).default(false),
  cath: integer('cath', { mode: 'boolean' }).default(false),
  jud: integer('jud', { mode: 'boolean' }).default(false),
  bell: integer('bell', { mode: 'boolean' }).default(true), // подписка списка 🔔: вкл — ММ-ДД, выкл — ГГГГ-ММ-ДД
});

// связь родитель→ребёнок из ответа триггером на триггер;
// parent/child — «Имя ГГГГ-ММ-ДД», дерево в рамках чата
export const links = table('links', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  parent: text('parent').notNull(),
  child: text('child').notNull(),
  who: text('who').notNull(),   // 'p'|'c' — кто пришёл новым триггером
  famId: integer('fam_id'),     // семья (после ensureFam/confirmPair)
  pairCand: text('pair_cand'),  // JSON: кандидаты-свадьбы «Иван+Мария ГГГГ-ММ-ДД»
  adopted: integer('adopted', { mode: 'boolean' }).default(false), // 🤱 усыновление
}, (t) => ({
  uq: uniqueIndex('uq_link').on(t.chatId, t.parent, t.child),
}));

// семья: подтверждённая пара родителей (2 родителя ребёнка) + свадьба/развод
export const fams = table('fams', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  parents: text('parents').notNull(),   // JSON: массив ключей «Имя ГГГГ-ММ-ДД»
  children: text('children').notNull(), // JSON
  marrD: text('marr_d'), marrPlac: text('marr_plac'),
  divD: text('div_d'), divPlac: text('div_plac'),
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
