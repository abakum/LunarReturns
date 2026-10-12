import { table, integer, text, uniqueIndex } from 'sdk/db';

export const events = table('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  name: text('name').notNull(),
  date: text('date').notNull(), // 'YYYY-MM-DD' (МСК)
  hour: integer('hour'),        // null = без времени
  minute: integer('minute'),
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
});
