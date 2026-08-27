import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import * as db from './src/db.js';
import {
  byCode, tasksFor, unitsFor, trackOf, TRACK_NAME, TRACKS, formatOf,
} from './src/catalog.js';
import * as P from './src/progress.js';

if (!process.env.BOT_TOKEN) {
  console.error('Нет переменной BOT_TOKEN. Добавь её в Railway → Variables.');
  process.exit(1);
}
if (!process.env.ADMIN_IDS) {
  console.error('Нет переменной ADMIN_IDS.');
  process.exit(1);
}

const bot = new Bot(process.env.BOT_TOKEN);

const ADMIN_IDS = process.env.ADMIN_IDS.split(',').map((s) => s.trim()).filter(Boolean);
const STAFF_IDS = (process.env.STAFF_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

const isAdmin = (id) => ADMIN_IDS.includes(String(id));
const isStaff = (id) => isAdmin(id) || STAFF_IDS.includes(String(id));

// Доступ строго по списку — это данные о людях в реабилитации.
bot.use(async (ctx, next) => {
  if (!isStaff(ctx.from?.id)) {
    const msg = `Доступ только для персонала.\nВаш ID: ${ctx.from?.id}`;
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: 'Нет доступа' });
    else await ctx.reply(msg);
    return;
  }
  await next();
});

const bar = (done, total, w = 10) => {
  const f = total ? Math.round((done / total) * w) : 0;
  return '▓'.repeat(f) + '░'.repeat(Math.max(0, w - f));
};

// ============================ ПОМОЩЬ ============================

const HELP = `<b>Учёт заданий резидентов</b>

/spisok — список резидентов, отметить сдачу
/svodka — кто отстаёт, кто спешит
/kartochka — карточка резидента

<b>Только руководитель:</b>
/add — добавить резидентов
/data — поправить даты
/vypisat — выписать резидента

<b>Как добавить резидентов</b>
Одним сообщением, по строке на человека:

<code>/add
Умид 13.03
Шерзодбек 14.03
Дилшод 12.08 срыв</code>

Дата — это заезд. Год можно не писать.
Выписка ставится через 6 месяцев автоматически.
Слово <code>срыв</code> в конце — если человек на программе срыва.`;

bot.command(['start', 'help'], (ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));

// ============================ ДОБАВЛЕНИЕ ============================

bot.command('add', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Добавлять резидентов может только руководитель.');

  const body = (ctx.message.text || '').split('\n').slice(1).join('\n').trim()
    || (ctx.match || '').trim();
  if (!body) return ctx.reply(HELP, { parse_mode: 'HTML' });

  const added = [], failed = [];
  for (const line of body.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const parts = line.split(/\s+/);
    let track = 'main';
    if (/^срыв$/i.test(parts.at(-1))) { track = 'sryv'; parts.pop(); }

    const dateStr = parts.at(-1);
    let started = P.parseDate(dateStr);
    // без года — подставляем текущий, а если дата в будущем, то прошлый
    if (!started && /^\d{1,2}[.\-/]\d{1,2}$/.test(dateStr || '')) {
      const y = new Date().getFullYear();
      started = P.parseDate(`${dateStr}.${y}`);
      if (started && started > P.today()) started = P.parseDate(`${dateStr}.${y - 1}`);
    }
    if (!started) { failed.push(line); continue; }

    const name = parts.slice(0, -1).join(' ');
    if (!name) { failed.push(line); continue; }

    const months = track === 'sryv' ? 1 : 6;
    const r = db.addResident({ name, startedAt: started, dischargeAt: P.addMonths(started, months) });
    r.track = track;
    added.push(r);
  }
  db.flush();

  let t = added.length ? `Добавлено: ${added.length}\n\n` : '';
  for (const r of added) {
    t += `${r.name} — заезд ${P.fmtDate(r.startedAt)}, выписка ${P.fmtDate(r.dischargeAt)}`;
    t += r.track === 'sryv' ? ' · срыв\n' : '\n';
  }
  if (failed.length) t += `\nНе разобрал:\n${failed.map((f) => '· ' + f).join('\n')}`;
  await ctx.reply(t || 'Ничего не добавлено.');
});

// ============================ СПИСОК ============================

function listKeyboard() {
  const kb = new InlineKeyboard();
  const rows = db.residents()
    .map((r) => ({ r, s: P.status(r) }))
    .sort((a, b) => a.s.diff - b.s.diff);      // сначала самые отстающие

  for (const { r, s } of rows) {
    const cur = P.currentTask(r);
    let tail;
    if (cur) {
      const tp = P.taskProgress(r, cur.code);
      tail = `${cur.short} ${tp.done}/${tp.total}`;
    } else {
      const nt = P.nextTask(r);
      tail = nt ? `нет задания` : `программа пройдена`;
    }
    kb.text(`${s.icon} ${r.name} · ${tail} · ${s.percent}%`, `r:${r.id}`).row();
  }
  return kb;
}

const LEGEND = '🟢 идёт нормально · 🟡 отстаёт · 🔴 сильно отстаёт';

bot.command(['spisok', 'list', 'residents'], async (ctx) => {
  const kb = listKeyboard();
  if (!kb.inline_keyboard.length) {
    return ctx.reply('Резидентов пока нет.\n\n' + HELP, { parse_mode: 'HTML' });
  }
  await ctx.reply(`${LEGEND}\n\nКого отмечаем?`, { reply_markup: kb });
});

bot.callbackQuery('list', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(`${LEGEND}\n\nКого отмечаем?`, {
    reply_markup: listKeyboard(),
  });
});

// ============================ ЭКРАН РЕЗИДЕНТА ============================

bot.callbackQuery(/^r:(\w+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showResident(ctx, db.resident(ctx.match[1]));
});

async function showResident(ctx, r) {
  const s = P.status(r);
  const list = tasksFor(r);
  const kb = new InlineKeyboard();

  list.forEach((task, i) => {
    const tp = P.taskProgress(r, task.code);
    const mark = tp.complete ? '✅' : tp.started ? '▶️' : '⬜';
    const num = tp.started && !tp.complete ? ` ${tp.done}/${tp.total}` : '';
    kb.text(`${mark} ${task.short}${num}`, `t:${r.id}:${i}`).row();
  });
  kb.text('✅ Готово', 'list').text('Карточка', `c:${r.id}`);

  const text =
    `<b>${r.name}</b> · ${TRACK_NAME[trackOf(r)]}\n` +
    `Заезд ${P.fmtDate(r.startedAt)} · выписка ${P.fmtDate(r.dischargeAt)}\n` +
    `День ${P.dayOfProgram(r)} из ${P.totalDays(r)}\n\n` +
    `${bar(s.done, s.total)} ${s.percent}% (${s.done}/${s.total})\n` +
    `${s.icon} ${statusLine(s)}\n\n` +
    `Какое задание отмечаем?`;

  await edit(ctx, text, kb);
}

function statusLine(s) {
  if (s.state === 'bad') return `Сильно отстаёт — минус ${-s.diff} ед. от графика`;
  if (s.state === 'late') return `Отстаёт на ${-s.diff} ед. от графика`;
  if (s.diff > 0) return `Идёт нормально, на ${s.diff} ед. впереди графика`;
  return 'Идёт нормально, по графику';
}

// ============================ ЗАДАНИЕ → СФЕРЫ ============================

bot.callbackQuery(/^t:(\w+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const r = db.resident(ctx.match[1]);
  const ti = +ctx.match[2];
  const task = tasksFor(r)[ti];
  const tp = P.taskProgress(r, task.code);

  const kb = new InlineKeyboard();
  task.groups.forEach((g, gi) => {
    const gp = P.groupProgress(r, task.code, gi);
    const mark = gp.done === gp.total ? '✅' : gp.done ? '▶️' : '⬜';
    kb.text(`${mark} ${gp.done}/${gp.total} · ${g.name}`, `g:${r.id}:${ti}:${gi}`).row();
  });
  kb.text('✅ Готово', 'list').text('« К резиденту', `r:${r.id}`);

  const f = formatOf(task);
  const fmt = f.steps.length ? `\n\n<i>Формат:</i>\n${f.steps.map((x) => '• ' + x).join('\n')}` : '';
  const norm = task.days_to_submit ? `\nНорматив: ${task.days_to_submit} дн.` : '';
  const note = task.notes ? `\n\n<i>${task.notes}</i>` : '';

  await edit(ctx,
    `<b>${task.name}</b>\n${r.name} — ${tp.done}/${tp.total}${norm}${fmt}${note}`, kb);
});

// ============================ СФЕРА → ПРИМЕРЫ ============================

bot.callbackQuery(/^g:(\w+):(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showGroup(ctx, db.resident(ctx.match[1]), +ctx.match[2], +ctx.match[3]);
});

async function showGroup(ctx, r, ti, gi) {
  const task = tasksFor(r)[ti];
  const gp = P.groupProgress(r, task.code, gi);
  const kb = new InlineKeyboard();

  const wide = !!gp.group.labels;
  for (let i = 0; i < gp.total; i++) {
    const label = gp.group.labels
      ? `${gp.arr[i] ? '✅' : '⬜'} ${gp.group.labels[i].slice(0, 28)}`
      : `${gp.arr[i] ? '✅' : '⬜'} ${i + 1}`;
    kb.text(label, `u:${r.id}:${ti}:${gi}:${i}`);
    if (wide || (i + 1) % 5 === 0) kb.row();
  }
  kb.row();
  if (gp.done < gp.total) kb.text('Отметить все', `all:${r.id}:${ti}:${gi}`).row();
  kb.text('✅ Готово', 'list').text('« К заданию', `t:${r.id}:${ti}`).row();

  const warn = gp.group.where === 'малая группа' ? '\n⚠️ Закрывается только на МГ.' : '';
  await edit(ctx,
    `<b>${task.name}</b>\n${r.name}\n\n${gp.group.name} — ${gp.done}/${gp.total}${warn}\n\n` +
    `Нажми на номера принятых примеров.`, kb);
}

bot.callbackQuery(/^u:(\w+):(\d+):(\d+):(\d+)$/, async (ctx) => {
  const r = db.resident(ctx.match[1]);
  const [ti, gi, ui] = [+ctx.match[2], +ctx.match[3], +ctx.match[4]];
  const task = tasksFor(r)[ti];
  const now = P.toggleUnit(r, task.code, gi, ui);
  db.logEntry({
    action: now ? 'accept' : 'undo', residentId: r.id, taskCode: task.code,
    groupIdx: gi, unitIdx: ui, by: ctx.from.id, byName: ctx.from.first_name,
  });
  db.save();

  const tp = P.taskProgress(r, task.code);
  await ctx.answerCallbackQuery({ text: now ? `Принято · ${tp.done}/${tp.total}` : 'Снято' });

  if (now && tp.complete) {
    const nt = P.nextTask(r);
    const kb = new InlineKeyboard();
    if (nt) kb.text(`Открыть: ${nt.short}`, `t:${r.id}:${tasksFor(r).indexOf(nt)}`).row();
    kb.text('✅ Готово', 'list').text('« К резиденту', `r:${r.id}`);
    return edit(ctx,
      `✅ <b>${r.name}</b>\nЗадание «${task.name}» закрыто полностью.\n\n` +
      `Следующее: ${nt ? nt.name : 'программа пройдена'}`, kb);
  }
  await showGroup(ctx, r, ti, gi);
});

bot.callbackQuery(/^all:(\w+):(\d+):(\d+)$/, async (ctx) => {
  const r = db.resident(ctx.match[1]);
  const [ti, gi] = [+ctx.match[2], +ctx.match[3]];
  const task = tasksFor(r)[ti];
  const gp = P.groupProgress(r, task.code, gi);
  for (let i = 0; i < gp.total; i++) {
    if (!gp.arr[i]) {
      P.toggleUnit(r, task.code, gi, i);
      db.logEntry({ action: 'accept', residentId: r.id, taskCode: task.code,
        groupIdx: gi, unitIdx: i, by: ctx.from.id, byName: ctx.from.first_name });
    }
  }
  db.save();
  await ctx.answerCallbackQuery({ text: 'Отмечено' });
  await showGroup(ctx, r, ti, gi);
});

// ============================ СВОДКА ============================

bot.command(['svodka', 'today'], async (ctx) => {
  const rows = db.residents().map((r) => ({ r, s: P.status(r) }));
  if (!rows.length) return ctx.reply('Резидентов пока нет.');

  const bad = rows.filter((x) => x.s.state === 'bad').sort((a, b) => a.s.diff - b.s.diff);
  const late = rows.filter((x) => x.s.state === 'late').sort((a, b) => a.s.diff - b.s.diff);
  const ok = rows.filter((x) => x.s.state === 'ok');
  const idle = rows.filter((x) => !P.currentTask(x.r) && P.nextTask(x.r));

  const line = (x) => {
    const cur = P.currentTask(x.r);
    return `${x.r.name} — ${x.s.percent}%, минус ${-x.s.diff} ед.` +
           `\n   ${cur ? cur.short : 'нет задания'} · до выписки ${x.s.daysLeft} дн.`;
  };

  let t = `<b>Сводка</b> · ${P.fmtDate(P.today())}\nРезидентов: ${rows.length}\n\n`;

  t += `<b>🔴 Сильно отстают — ${bad.length}</b>\n`;
  t += bad.length ? bad.map(line).join('\n') + '\n' : 'нет\n';

  t += `\n<b>🟡 Отстают — ${late.length}</b>\n`;
  t += late.length ? late.map(line).join('\n') + '\n' : 'нет\n';

  t += `\n<b>🟢 Идут нормально — ${ok.length}</b>\n`;
  t += ok.length ? ok.map((x) => x.r.name).join(', ') + '\n' : 'нет\n';

  if (idle.length) {
    t += `\n<b>⚠️ Без активного задания — ${idle.length}</b>\n`;
    t += idle.map((x) => `${x.r.name} — открыть ${P.nextTask(x.r).short}`).join('\n');
  }

  await ctx.reply(t, { parse_mode: 'HTML' });
});

// ============================ КАРТОЧКА ============================

bot.command(['kartochka', 'card'], async (ctx) => {
  const kb = new InlineKeyboard();
  for (const r of db.residents()) kb.text(r.name, `c:${r.id}`).row();
  if (!kb.inline_keyboard.length) return ctx.reply('Резидентов пока нет.');
  await ctx.reply('Чью карточку?', { reply_markup: kb });
});

bot.callbackQuery(/^c:(\w+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const r = db.resident(ctx.match[1]);
  const s = P.status(r);
  const kb = new InlineKeyboard().text('« К резиденту', `r:${r.id}`);

  let t = `<b>${r.name}</b> · ${TRACK_NAME[trackOf(r)]}\n`;
  t += `Заезд ${P.fmtDate(r.startedAt)} · выписка ${P.fmtDate(r.dischargeAt)}\n`;
  t += `День ${P.dayOfProgram(r)} из ${P.totalDays(r)} · осталось ${s.daysLeft} дн.\n\n`;
  t += `${bar(s.done, s.total)} ${s.percent}% (${s.done}/${s.total})\n`;
  t += `Ожидалось к этому дню: ${s.expectedUnits} ед.\n`;
  t += `${s.icon} ${statusLine(s)}\n`;
  if (s.daysLeft > 0 && s.done < s.total) {
    t += `Чтобы успеть: ${s.needPerDay.toFixed(1)} ед. в день\n`;
  }
  t += `\n<b>Задания</b>\n`;
  for (const task of tasksFor(r)) {
    const tp = P.taskProgress(r, task.code);
    if (!tp.started) { t += `⬜ ${task.short}\n`; continue; }
    t += tp.complete
      ? `✅ ${task.short} — закрыто ${P.fmtDate(tp.rec.closedAt)}\n`
      : `▶️ ${task.short} — ${tp.done}/${tp.total}, открыто ${P.fmtDate(tp.rec.issuedAt)}\n`;
  }
  await edit(ctx, t, kb);
});

// ============================ ДАТЫ И ВЫПИСКА ============================

bot.command('data', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Только руководитель.');
  const arg = (ctx.match || '').trim();
  if (!arg) {
    return ctx.reply(
      'Поправить даты:\n<code>/data Умид 13.03.2026 13.09.2026</code>\n\n' +
      'Первая дата — заезд, вторая — выписка.', { parse_mode: 'HTML' });
  }
  const p = arg.split(/\s+/);
  const dis = P.parseDate(p.at(-1)), st = P.parseDate(p.at(-2));
  const name = p.slice(0, -2).join(' ').toLowerCase();
  if (!st || !dis) return ctx.reply('Не понял даты. Формат: ДД.ММ.ГГГГ');
  const r = db.residents().find((x) => x.name.toLowerCase() === name);
  if (!r) return ctx.reply(`Не нашёл резидента «${name}».`);
  r.startedAt = st; r.dischargeAt = dis;
  db.flush();
  await ctx.reply(`${r.name}: заезд ${P.fmtDate(st)}, выписка ${P.fmtDate(dis)}`);
});

bot.command('vypisat', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Только руководитель.');
  const name = (ctx.match || '').trim().toLowerCase();
  const r = db.residents().find((x) => x.name.toLowerCase() === name);
  if (!r) return ctx.reply('Формат: /vypisat Имя');
  r.active = false;
  db.flush();
  await ctx.reply(`${r.name} выписан. Данные сохранены.`);
});

// ============================ СЛУЖЕБНОЕ ============================

async function edit(ctx, text, kb) {
  const opts = { reply_markup: kb, parse_mode: 'HTML' };
  try { await ctx.editMessageText(text, opts); }
  catch { await ctx.reply(text, opts); }
}

bot.catch((err) => console.error('Ошибка:', err.message));

process.once('SIGINT', () => { db.flush(); process.exit(0); });
process.once('SIGTERM', () => { db.flush(); process.exit(0); });

db.load();
bot.start({
  onStart: (i) => {
    console.log(`Бот @${i.username} запущен`);
    console.log(`Резидентов: ${db.residents().length}`);
  },
});
