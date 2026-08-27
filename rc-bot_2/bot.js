import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import * as db from './src/db.js';
import { byCode, ORDERED, formatOf, TOTAL_UNITS } from './src/catalog.js';
import * as P from './src/progress.js';

// Проверки при старте — чтобы в логах Railway было видно причину,
// а не молчаливое падение.
if (!process.env.BOT_TOKEN) {
  console.error('Нет переменной BOT_TOKEN. Добавь её в Railway → Variables.');
  process.exit(1);
}
if (!process.env.ADMIN_IDS) {
  console.error('Нет переменной ADMIN_IDS. Без неё некому добавлять резидентов.');
  process.exit(1);
}

const bot = new Bot(process.env.BOT_TOKEN);

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const STAFF_IDS = (process.env.STAFF_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const isStaff = (id) => STAFF_IDS.includes(String(id)) || ADMIN_IDS.includes(String(id));
const isAdmin = (id) => ADMIN_IDS.includes(String(id));

// Доступ строго по списку. Данные о людях в реабилитации — не то,
// что должно открываться по ссылке-приглашению.
bot.use(async (ctx, next) => {
  const id = ctx.from?.id;
  if (!isStaff(id)) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: 'Нет доступа' });
    else await ctx.reply(`Доступ только для персонала. Ваш ID: ${id}`);
    return;
  }
  await next();
});

// контекст приёмки: кто где принимает прямо сейчас
const session = new Map(); // userId -> { context: 'mg'|'ks'|'ind' }
const ctxOf = (id) => session.get(String(id))?.context || 'mg';
const CTX_LABEL = { mg: 'МГ', ks: 'КС', ind: 'индивидуально' };

const bar = (done, total, width = 10) => {
  const filled = total ? Math.round((done / total) * width) : 0;
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
};

// ============================ СТАРТ ============================

bot.command('start', async (ctx) => {
  await ctx.reply(
    `Учёт заданий резидентов.\n\n` +
    `/mg — приёмка примеров\n` +
    `/today — сводка на смену\n` +
    `/card — карточка резидента\n` +
    `/mgday — отметить, прошла ли МГ\n` +
    `/stats — реальные цифры по дому\n` +
    (isAdmin(ctx.from.id) ? `/add Имя — добавить резидента\n` : '') +
    `\nПервый месяц бот только измеряет. Ничего не оценивает и никого не сравнивает.`
  );
});

// ============================ РЕЗИДЕНТЫ ============================

bot.command('add', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Добавлять резидентов может только руководитель.');
  const name = ctx.match?.trim();
  if (!name) return ctx.reply('Формат: /add Имя');
  const r = db.addResident({ name });
  db.save();
  await ctx.reply(`Добавлен: ${r.name}\nЗаход ${r.startedAt}, выписка ${r.dischargeAt}`);
});

// ============================ ПРИЁМКА ============================

bot.command('mg', async (ctx) => {
  const c = ctxOf(ctx.from.id);
  const kb = new InlineKeyboard();
  for (const r of db.residents()) {
    const o = P.overall(r);
    const active = r.activeTask ? byCode[r.activeTask].short : '— нет задания';
    kb.text(`${r.name} · ${o.percent}% · ${active}`, `r:${r.id}`).row();
  }
  if (!kb.inline_keyboard.length) return ctx.reply('Резидентов пока нет. /add Имя');
  kb.text(`Контекст: ${CTX_LABEL[c]} — сменить`, 'ctxsw');
  await ctx.reply('Кого разбираем?', { reply_markup: kb });
});

bot.callbackQuery('ctxsw', async (ctx) => {
  const kb = new InlineKeyboard()
    .text('МГ', 'ctx:mg').text('КС', 'ctx:ks').text('Индивидуально', 'ctx:ind');
  await ctx.editMessageText('Где принимаешь задания сейчас?', { reply_markup: kb });
});

bot.callbackQuery(/^ctx:(\w+)$/, async (ctx) => {
  const c = ctx.match[1];
  session.set(String(ctx.from.id), { context: c });
  await ctx.answerCallbackQuery({ text: `Контекст: ${CTX_LABEL[c]}` });
  await ctx.editMessageText(`Контекст приёмки: ${CTX_LABEL[c]}. Открой /mg`);
});

// Экран резидента
bot.callbackQuery(/^r:(\w+)$/, async (ctx) => {
  const r = db.resident(ctx.match[1]);
  if (!r) return ctx.answerCallbackQuery({ text: 'Не найден' });
  await ctx.answerCallbackQuery();
  await showResident(ctx, r, true);
});

async function showResident(ctx, r, edit = false) {
  const o = P.overall(r);
  const kb = new InlineKeyboard();
  let text = `<b>${r.name}</b>\nДень ${P.dayOfProgram(r)} · до выписки ${P.daysLeft(r)} дн.\n` +
             `Программа: ${bar(o.done, o.total)} ${o.percent}% (${o.done}/${o.total})\n\n`;

  if (r.activeTask) {
    const tp = P.taskProgress(r, r.activeTask);
    text += `В работе: <b>${tp.task.name}</b> — ${tp.done}/${tp.total}\n`;
    text += `Формат: ${formatOf(tp.task).name}\n`;
    for (let i = 0; i < tp.task.groups.length; i++) {
      const g = P.groupProgress(r, r.activeTask, i);
      kb.text(`${g.done}/${g.total} · ${g.group.name}`, `g:${r.id}:${i}`).row();
    }
    if (tp.complete) kb.text('✅ Закрыть задание', `close:${r.id}`).row();
  } else {
    const nt = P.nextTask(r);
    text += `<i>Активного задания нет.</i>\n`;
    if (nt) kb.text(`Вынести: ${nt.name}`, `issue:${r.id}:${nt.code}`).row();
  }

  kb.text('Карточка', `card:${r.id}`).text('« Назад', 'back');

  const opts = { reply_markup: kb, parse_mode: 'HTML' };
  if (edit) await ctx.editMessageText(text, opts);
  else await ctx.reply(text, opts);
}

// Сферы / группы
bot.callbackQuery(/^g:(\w+):(\d+)$/, async (ctx) => {
  const r = db.resident(ctx.match[1]);
  await ctx.answerCallbackQuery();
  await showGroup(ctx, r, +ctx.match[2]);
});

async function showGroup(ctx, r, gi) {
  const code = r.activeTask;
  const task = byCode[code];
  const g = P.groupProgress(r, code, gi);

  const kb = new InlineKeyboard();
  for (let i = 0; i < g.total; i++) {
    kb.text(`${g.arr[i] ? '✅' : '⬜'} ${g.group.labels ? g.group.labels[i].slice(0, 22) : 'пр. ' + (i + 1)}`,
      `u:${r.id}:${gi}:${i}`);
    if ((i + 1) % 4 === 0) kb.row();
  }
  kb.row().text('« К заданию', `r:${r.id}`);

  const f = formatOf(task);
  const steps = f.steps.length ? '\n\nЧек-лист формата:\n' + f.steps.map((s) => `• ${s}`).join('\n') : '';
  const note = g.group.where === 'малая группа' ? '\n\n⚠️ Закрывается только на МГ.' : '';

  await ctx.editMessageText(
    `<b>${task.name}</b>\n${g.group.name} — ${g.done}/${g.total}${note}${steps}`,
    { reply_markup: kb, parse_mode: 'HTML' }
  ).catch(() => {});
}

// Отметка примера
bot.callbackQuery(/^u:(\w+):(\d+):(\d+)$/, async (ctx) => {
  const r = db.resident(ctx.match[1]);
  const gi = +ctx.match[2], ui = +ctx.match[3];
  const code = r.activeTask;
  const now = P.toggleUnit(r, code, gi, ui);
  db.logEntry({
    action: now ? 'accept' : 'undo',
    residentId: r.id, taskCode: code, groupIdx: gi, unitIdx: ui,
    by: ctx.from.id, byName: ctx.from.first_name,
    context: ctxOf(ctx.from.id),
  });
  db.save();

  const tp = P.taskProgress(r, code);
  await ctx.answerCallbackQuery({ text: now ? 'Принято' : 'Снято' });

  if (tp.complete && now) {
    const nt = P.nextTask(r);
    const kb = new InlineKeyboard();
    if (nt) kb.text(`Вынести следующее: ${nt.name}`, `issue:${r.id}:${nt.code}`).row();
    kb.text('Позже', `r:${r.id}`);
    return ctx.editMessageText(
      `<b>${r.name}</b>\nЗадание «${tp.task.name}» закрыто полностью.\n\n` +
      `Вынести следующее прямо сейчас? Пауза между заданиями — самая частая потеря времени.`,
      { reply_markup: kb, parse_mode: 'HTML' }
    );
  }
  await showGroup(ctx, r, gi);
});

// Вынос задания
bot.callbackQuery(/^issue:(\w+):(\w+)$/, async (ctx) => {
  const r = db.resident(ctx.match[1]);
  const code = ctx.match[2];
  const task = byCode[code];
  const prev = r.activeTask && P.taskProgress(r, r.activeTask);
  if (prev?.complete) r.tasks[r.activeTask].closedAt = P.today();

  r.tasks[code] ||= { issuedAt: P.today(), closedAt: null, progress: {} };
  r.activeTask = code;
  db.logEntry({ action: 'issue', residentId: r.id, taskCode: code, by: ctx.from.id, context: ctxOf(ctx.from.id) });
  db.save();

  await ctx.answerCallbackQuery({ text: 'Вынесено' });
  await showResident(ctx, r, true);
});

bot.callbackQuery(/^close:(\w+)$/, async (ctx) => {
  const r = db.resident(ctx.match[1]);
  r.tasks[r.activeTask].closedAt = P.today();
  const nt = P.nextTask(r);
  r.activeTask = null;
  db.save();
  await ctx.answerCallbackQuery({ text: 'Закрыто' });
  const kb = new InlineKeyboard();
  if (nt) kb.text(`Вынести: ${nt.name}`, `issue:${r.id}:${nt.code}`).row();
  kb.text('« Назад', `r:${r.id}`);
  await ctx.editMessageText(`${r.name}: задание закрыто.`, { reply_markup: kb });
});

bot.callbackQuery('back', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
});

// ============================ КАРТОЧКА ============================

bot.callbackQuery(/^card:(\w+)$/, async (ctx) => {
  const r = db.resident(ctx.match[1]);
  await ctx.answerCallbackQuery();
  await ctx.reply(cardText(r), { parse_mode: 'HTML' });
});

bot.command('card', async (ctx) => {
  const kb = new InlineKeyboard();
  for (const r of db.residents()) kb.text(r.name, `card:${r.id}`).row();
  await ctx.reply('Чью карточку?', { reply_markup: kb });
});

function cardText(r) {
  const o = P.overall(r);
  const f = P.forecast(r);
  let t = `<b>${r.name}</b>\n`;
  t += `Заход ${r.startedAt} · выписка ${r.dischargeAt}\n`;
  t += `День ${P.dayOfProgram(r)} из 180 · осталось ${P.daysLeft(r)} дн.\n`;
  t += `Прогресс ${bar(o.done, o.total)} ${o.percent}% (${o.done}/${o.total})\n\n`;

  if (f.status === 'behind') {
    t += `⚠️ При текущем темпе не успевает ${f.gap} ед.\n`;
    t += `Факт ${f.perDay.toFixed(2)} ед/день, нужно ${f.needPerDay.toFixed(2)}.\n`;
    t += `<i>Это повод зайти на проговор, а не выдать последствие.</i>\n\n`;
  } else if (f.status === 'ok') {
    t += `Темп достаточный: ${f.perDay.toFixed(2)} ед/день при норме ${f.needPerDay.toFixed(2)}.\n\n`;
  } else {
    t += `Данных о темпе пока мало.\n\n`;
  }

  t += `<b>Задания</b>\n`;
  for (const task of ORDERED) {
    const rec = r.tasks[task.code];
    if (!rec) { t += `· ${task.short} — не выносилось\n`; continue; }
    const tp = P.taskProgress(r, task.code);
    const status = rec.closedAt ? `закрыто ${rec.closedAt}` : `${tp.done}/${tp.total}`;
    t += `${rec.closedAt ? '✅' : '▶️'} ${task.short} — вынос ${rec.issuedAt}, ${status}\n`;
  }
  return t;
}

// ============================ СВОДКА НА СМЕНУ ============================

bot.command('today', async (ctx) => {
  const list = db.residents();
  const noTask = list.filter((r) => !P.hasActive(r));
  const behind = list
    .map((r) => ({ r, f: P.forecast(r) }))
    .filter((x) => x.f.status === 'behind')
    .sort((a, b) => b.f.gap - a.f.gap);

  let t = `<b>Сводка на смену</b> · ${P.today()}\n\n`;

  t += `<b>Без активного задания: ${noTask.length}</b>\n`;
  t += noTask.length
    ? noTask.map((r) => `· ${r.name}`).join('\n') + '\n'
    : 'нет — все в работе\n';

  t += `\n<b>Отстают по темпу: ${behind.length}</b>\n`;
  t += behind.length
    ? behind.slice(0, 8).map((x) => `· ${x.r.name} — не успевает ${x.f.gap} ед.`).join('\n') + '\n'
    : 'нет\n';

  const s = P.houseStats(7);
  t += `\n<b>За неделю по дому</b>\nразборов ${s.razbory}, закрыто ${s.units} ед. (${s.unitsPerRazbor} за разбор)`;

  await ctx.reply(t, { parse_mode: 'HTML' });
});

// ============================ ОТМЕТКА МГ ============================

bot.command('mgday', async (ctx) => {
  const kb = new InlineKeyboard()
    .text('Прошла', 'mg:held').row()
    .text('Сокращённая / позже начали', 'mg:short').row()
    .text('Отменена', 'mg:cancelled');
  await ctx.reply(`Малая группа сегодня (${P.today()})?`, { reply_markup: kb });
});

bot.callbackQuery(/^mg:(\w+)$/, async (ctx) => {
  db.markMg({ status: ctx.match[1], by: ctx.from.id });
  await ctx.answerCallbackQuery({ text: 'Отмечено' });
  await ctx.editMessageText('Отмечено. Спасибо — это те данные, которых сейчас нет ни у кого.');
});

// ============================ ЦИФРЫ ПО ДОМУ ============================

bot.command('stats', async (ctx) => {
  const s = P.houseStats(30);
  const m = P.mgStats(db.events(), 30);
  const list = db.residents();

  let t = `<b>Реальные цифры за 30 дней</b>\n\n`;
  t += `Резидентов в доме: ${list.length}\n`;
  t += `МГ отмечено: ${m.marked} (прошло ${m.held}, сокращённых ${m.short}, отменено ${m.cancelled})\n`;
  t += `Фактически МГ в неделю: <b>${m.perWeek}</b> из 5 плановых\n\n`;
  t += `Разборов: ${s.razbory}\nЗакрыто единиц: ${s.units}\nЗа один разбор: <b>${s.unitsPerRazbor}</b>\n\n`;

  t += `<b>Где принимаются задания</b>\n`;
  for (const [k, v] of Object.entries(s.byContext)) {
    t += `· ${CTX_LABEL[k] || k}: ${v} ед. (${Math.round((v / s.units) * 100)}%)\n`;
  }

  if (s.razbory && list.length) {
    const razborPerResident = s.razbory / list.length;
    const projected = Math.round(razborPerResident * 6 * s.unitsPerRazbor);
    t += `\n<b>Что это значит</b>\n`;
    t += `На одного резидента ${razborPerResident.toFixed(1)} разбора в месяц.\n`;
    t += `За 6 месяцев такими темпами закроется около ${projected} ед. из ${TOTAL_UNITS} `;
    t += `(${Math.round((projected / TOTAL_UNITS) * 100)}% программы).`;
  }

  await ctx.reply(t, { parse_mode: 'HTML' });
});

// ============================ ЗАПУСК ============================

bot.catch((err) => console.error('Ошибка:', err));

process.once('SIGINT', () => { db.flush(); process.exit(0); });
process.once('SIGTERM', () => { db.flush(); process.exit(0); });

db.load();

bot.start({
  onStart: (info) => {
    console.log(`Бот @${info.username} запущен`);
    console.log(`Руководителей: ${ADMIN_IDS.length}, консультантов: ${STAFF_IDS.length}`);
    console.log(`Резидентов в базе: ${db.residents().length}`);
  },
});
