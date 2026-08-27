import 'dotenv/config';
import { Bot, InlineKeyboard, Keyboard, InputFile } from 'grammy';
import * as db from './src/db.js';
import {
  byCode, tasksFor, unitsFor, trackOf, TRACK_NAME, TRACKS, formatOf,
} from './src/catalog.js';
import * as P from './src/progress.js';
import { seedDemo } from './src/demo.js';
import { parseReport } from './src/parse.js';

if (!process.env.BOT_TOKEN) {
  console.error('Нет переменной BOT_TOKEN. Добавь её в Railway → Variables.');
  process.exit(1);
}
// DEMO=1 — открытый показ на вымышленных данных.
// Настоящую базу так открывать нельзя: это данные о людях в реабилитации.
const DEMO = process.env.DEMO === '1';

if (!DEMO && !process.env.ADMIN_IDS) {
  console.error('Нет переменной ADMIN_IDS.');
  process.exit(1);
}

db.load();
db.seedStaff();
const fromEnv = db.syncStaffFromEnv(process.env.STAFF);
db.flush();

const bot = new Bot(process.env.BOT_TOKEN);

const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const STAFF_IDS = (process.env.STAFF_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

// В демо-режиме заходит и правит кто угодно — данные всё равно вымышленные.
const isAdmin = (id) => DEMO || ADMIN_IDS.includes(String(id));

// Персонал — это те, чьи ID указаны в STAFF, плюс STAFF_IDS, плюс руководитель.
const isStaff = (id) =>
  DEMO || isAdmin(id) || STAFF_IDS.includes(String(id)) || db.staffTgIds().includes(String(id));

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

// Постоянные кнопки внизу экрана — команды печатать не нужно.
const MENU = new Keyboard()
  .text('📋 Задания').text('🔧 Техничка').row()
  .text('📊 Сводка').text('👥 Смена').row()
  .text('📄 Таблица')
  .resized().persistent();

// Кто сейчас вводит текст: 'tech' — техничка, 'mg' — отчёт МГ
const waiting = new Map();
const pending = new Map();   // разобранный отчёт до подтверждения

const bar = (done, total, w = 10) => {
  const f = total ? Math.round((done / total) * w) : 0;
  return '▓'.repeat(f) + '░'.repeat(Math.max(0, w - f));
};

// ============================ ПОМОЩЬ ============================

const HELP = `<b>Учёт заданий резидентов</b>

Кнопки внизу экрана:
📋 <b>Задания</b> — отметить сданные примеры
🔧 <b>Техничка</b> — записать и закрыть пункты для смены
📊 <b>Сводка</b> — кто отстаёт, кто спешит
👥 <b>Смена</b> — кто сегодня на смене
📄 <b>Таблица</b> — выгрузка в Excel

/kartochka — карточка резидента

<b>Только руководитель:</b>
/add — добавить резидентов
/tek — проставить текущее задание
/data — поправить даты
/backup — скачать копию базы
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

const DEMO_BANNER =
  '🧪 <b>Демо-режим</b>\nВсе резиденты вымышленные, данные ненастоящие. ' +
  'Можно нажимать что угодно.\n\n';

bot.command(['start', 'help'], (ctx) =>
  ctx.reply((DEMO ? DEMO_BANNER : '') + HELP, { parse_mode: 'HTML', reply_markup: MENU }));

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

// ============================ ТЕКУЩЕЕ ЗАДАНИЕ ============================

// Ищем задание по куску названия: «Иллюзии», «+/-», «Тяжёлые», «Срыв 5»
const norm = (x) => String(x).toLowerCase().replace(/ё/g, 'е').replace(/[\s.,]/g, '');

function resolveTask(r, str) {
  const q = norm(str);
  if (!q) return null;
  const list = tasksFor(r);
  const exact = list.find((t) => norm(t.short) === q || norm(t.name) === q);
  if (exact) return exact;
  const hits = list.filter((t) => norm(t.short).includes(q) || norm(t.name).includes(q));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return hits.sort((a, b) => a.short.length - b.short.length)[0];
  return null;
}

bot.command('tek', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Только руководитель.');

  const body = (ctx.message.text || '').split('\n').slice(1).join('\n').trim()
    || (ctx.match || '').trim();
  if (!body) {
    return ctx.reply(
      '<b>Проставить текущее задание</b>\n\n' +
      'По строке на человека: имя, задание, дата выноса (необязательно).\n\n' +
      '<code>/tek\nУмид Бессилие 11.08\nШахзод Иллюзии 11.08\nАзизхон Срыв 5 28.08</code>\n\n' +
      'Все задания до указанного помечаются закрытыми.\n' +
      'Примеры внутри текущего отмечаешь потом руками через /spisok.',
      { parse_mode: 'HTML' });
  }

  const done = [], failed = [];
  for (const line of body.split('\n').map((x) => x.trim()).filter(Boolean)) {
    const parts = line.split(/\s+/);

    // необязательная дата выноса в конце
    let issued = null;
    const last = parts.at(-1);
    if (/^\d{1,2}[.\-/]\d{1,2}([.\-/]\d{2,4})?$/.test(last)) {
      issued = P.parseDate(last) || P.parseDate(`${last}.${new Date().getFullYear()}`);
      if (issued && issued > P.today()) issued = P.parseDate(`${last}.${new Date().getFullYear() - 1}`);
      parts.pop();
    }

    // ищем резидента: имя может быть из нескольких слов («Азиз Х.», «Санжар 1»)
    let r = null, taskStr = '';
    for (let cut = parts.length - 1; cut >= 1; cut--) {
      const cand = parts.slice(0, cut).join(' ');
      const found = db.residents().find((x) => norm(x.name) === norm(cand));
      if (found) { r = found; taskStr = parts.slice(cut).join(' '); break; }
    }
    if (!r) { failed.push(`${line} — не нашёл резидента`); continue; }

    const task = resolveTask(r, taskStr);
    if (!task) { failed.push(`${line} — не понял задание «${taskStr}»`); continue; }

    // всё до текущего — закрыто целиком
    const list = tasksFor(r);
    const idx = list.indexOf(task);
    r.tasks = {};
    for (let i = 0; i < idx; i++) {
      const t = list[i];
      r.tasks[t.code] = {
        issuedAt: r.startedAt, closedAt: issued || P.today(),
        progress: Object.fromEntries(
          t.groups.map((g, gi) => [gi, new Array(g.count).fill(true)])),
      };
    }
    r.tasks[task.code] = { issuedAt: issued || P.today(), closedAt: null, progress: {} };

    const s = P.status(r);
    done.push(`${s.icon} ${r.name} — ${task.short}, закрыто ${idx} заданий (${s.percent}%)`);
  }
  db.flush();

  let t = done.length ? done.join('\n') + '\n' : '';
  if (failed.length) t += `\nНе получилось:\n${failed.map((x) => '· ' + x).join('\n')}`;
  await ctx.reply(t || 'Ничего не изменено.');
});

// ============================ ТЕХНИЧКА ============================

// Возраст пункта — чтобы висящие третью смену было видно
function age(iso) {
  const d = Math.floor((Date.now() - new Date(iso)) / P.DAY);
  if (d === 0) return 'сегодня';
  if (d === 1) return 'вчера';
  return `${d} дн. назад`;
}

function techKeyboard() {
  const kb = new InlineKeyboard();
  const open = db.techOpen().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const it of open) {
    const stale = (Date.now() - new Date(it.createdAt)) / P.DAY >= 2 ? '❗️' : '✅';
    kb.text(`${stale} ${it.text.slice(0, 40)}`, `td:${it.id}`).row();
  }
  kb.text('➕ Добавить', 'tadd').row();
  kb.text('Выполненные', 'tdone');
  return kb;
}

function techText() {
  const open = db.techOpen();
  if (!open.length) {
    return '<b>🔧 Техническая информация</b>\n\nОткрытых пунктов нет.\n\n' +
           'Нажми «Добавить», чтобы записать что-то для следующей смены.';
  }
  let t = `<b>🔧 Техническая информация</b>\nОткрыто: ${open.length}\n\n`;
  for (const it of open.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const days = Math.floor((Date.now() - new Date(it.createdAt)) / P.DAY);
    const warn = days >= 2 ? ' ❗️' : '';
    t += `• ${it.text}\n  <i>${it.byName || 'кто-то'}, ${age(it.createdAt)}${warn}</i>\n`;
  }
  t += '\nНажми на пункт, чтобы отметить выполненным.';
  return t;
}

async function showTech(ctx, edit = false) {
  const opts = { reply_markup: techKeyboard(), parse_mode: 'HTML' };
  if (edit) { try { return await ctx.editMessageText(techText(), opts); } catch {} }
  await ctx.reply(techText(), opts);
}

bot.hears('🔧 Техничка', async (ctx) => {
  if (await askWhoIfNeeded(ctx)) return;
  await showTech(ctx);
});
bot.command('inf', (ctx) => showTech(ctx));

bot.callbackQuery('tech', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showTech(ctx, true);
});

bot.callbackQuery('tadd', async (ctx) => {
  waiting.set(String(ctx.from.id), 'tech');
  await ctx.answerCallbackQuery();
  await ctx.reply(
    'Напиши текст одним сообщением.\nНесколько пунктов — с новой строки, каждый станет отдельным.\n\n' +
    'Например:\n<code>Дилшоду отменили лекарство с завтрашнего дня\nЗавтра приезжает врач к 11</code>',
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('Отмена', 'tcancel') });
});

bot.callbackQuery('tcancel', async (ctx) => {
  waiting.delete(String(ctx.from.id));
  pending.delete(String(ctx.from.id));
  await ctx.answerCallbackQuery({ text: 'Отменено' });
  await ctx.editMessageText('Отменено.');
});

bot.callbackQuery(/^td:(\w+)$/, async (ctx) => {
  const it = db.techItem(ctx.match[1]);
  if (!it) return ctx.answerCallbackQuery({ text: 'Пункт не найден' });
  it.doneAt = new Date().toISOString();
  it.doneBy = who(ctx);
  db.flush();
  await ctx.answerCallbackQuery({ text: 'Отмечено выполненным' });
  await showTech(ctx, true);
});

bot.callbackQuery('tdone', async (ctx) => {
  await ctx.answerCallbackQuery();
  const done = db.techDone();
  let t = '<b>Выполненные пункты</b>\n\n';
  t += done.length
    ? done.map((it) => `✅ ${it.text}\n  <i>закрыл ${it.doneBy || '—'}, ${age(it.doneAt)}</i>`).join('\n')
    : 'пока нет';
  await ctx.editMessageText(t, {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('« К техничке', 'tech'),
  });
});

// ============================ СМЕНА И ПЕРСОНАЛ ============================

// Кто нажимает кнопки. Если человек привязал себя — его имя, иначе имя из Telegram.
function who(ctx) {
  const st = db.staffByTg(ctx.from.id);
  return st ? st.name : (ctx.from.first_name || 'кто-то');
}

function shiftKeyboard() {
  const sh = db.shift();
  const kb = new InlineKeyboard();
  for (const st of db.staff()) {
    const on = sh.members.includes(st.id);
    const lead = sh.lead === st.id;
    kb.text(`${on ? (lead ? '1️⃣' : '✅') : '⬜'} ${st.name}`, `sh:${st.id}`).row();
  }
  kb.text('👤 Я — это кто?', 'me').row();
  kb.text('Открыть смену заново', 'shnew');
  return kb;
}

function shiftText() {
  const sh = db.shift();
  const names = sh.members.map((id) => {
    const st = db.staffById(id);
    return st ? (sh.lead === id ? `${st.name} (№1)` : st.name) : null;
  }).filter(Boolean);

  let t = '<b>👥 Смена</b>\n\n';
  t += sh.date ? `Открыта ${P.fmtDate(sh.date)}\n` : 'Смена не открыта\n';
  t += names.length ? `На смене: ${names.join(', ')}\n` : 'Никто не отмечен\n';
  t += '\nНажми на имя, чтобы поставить или снять.\n';
  t += 'Повторное нажатие на отмеченного делает его консультантом №1.\n';

  // что сделано за сегодня и кем
  const day = P.today();
  const marks = db.logAll().filter((e) => e.action === 'accept' && e.ts.slice(0, 10) === day);
  if (marks.length) {
    const byPerson = {};
    for (const m of marks) byPerson[m.byName || '—'] = (byPerson[m.byName || '—'] || 0) + 1;
    t += `\n<b>Принято сегодня: ${marks.length} ед.</b>\n`;
    t += Object.entries(byPerson).sort((a, b) => b[1] - a[1])
      .map(([n, c]) => `${n} — ${c}`).join('\n');
  }
  return t;
}

async function showShift(ctx, edit = false) {
  const opts = { reply_markup: shiftKeyboard(), parse_mode: 'HTML' };
  if (edit) { try { return await ctx.editMessageText(shiftText(), opts); } catch {} }
  await ctx.reply(shiftText(), opts);
}

bot.hears('👥 Смена', (ctx) => showShift(ctx));
bot.command('smena', (ctx) => showShift(ctx));

bot.callbackQuery('shift', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showShift(ctx, true);
});

bot.callbackQuery(/^sh:(\w+)$/, async (ctx) => {
  const id = ctx.match[1];
  const sh = db.shift();
  if (!sh.date) sh.date = P.today();

  if (!sh.members.includes(id)) {
    sh.members.push(id);
    if (!sh.lead) sh.lead = id;
  } else if (sh.lead !== id) {
    sh.lead = id;                                  // второе нажатие — старший
  } else {
    sh.members = sh.members.filter((x) => x !== id);
    sh.lead = sh.members[0] || null;               // третье — снять
  }
  db.setShift(sh);
  await ctx.answerCallbackQuery();
  await showShift(ctx, true);
});

bot.callbackQuery('shnew', async (ctx) => {
  db.setShift({ date: P.today(), members: [], lead: null });
  await ctx.answerCallbackQuery({ text: 'Смена открыта заново' });
  await showShift(ctx, true);
});

// Привязка Telegram к человеку из списка — один раз
bot.callbackQuery('me', async (ctx) => {
  const kb = new InlineKeyboard();
  for (const st of db.staff()) kb.text(st.name, `me:${st.id}`).row();
  await ctx.answerCallbackQuery();
  await ctx.editMessageText('Кто ты? Выбери себя — дальше отметки будут подписываться сами.',
    { reply_markup: kb });
});

bot.callbackQuery(/^me:(\w+)$/, async (ctx) => {
  const st = db.linkStaff(ctx.match[1], ctx.from.id);
  db.flush();
  await ctx.answerCallbackQuery({ text: `Записал: ${st?.name}` });
  await showShift(ctx, true);
});

bot.command(['kto', 'who'], async (ctx) => {
  const me = db.staffByTg(ctx.from.id);
  let t = `Твой Telegram ID: <code>${ctx.from.id}</code>\n`;
  t += me ? `Ты записан как <b>${me.name}</b>\n\n` : `Ты пока ни к кому не привязан\n\n`;
  t += '<b>Персонал</b>\n';
  for (const st of db.staff()) {
    t += `${st.tgId ? '🔗' : '⬜'} ${st.name}${st.tgId ? ` — <code>${st.tgId}</code>` : ''}\n`;
  }
  t += '\nПривязка задаётся переменной <code>STAFF</code> на Railway:\n';
  t += '<code>Юра:6996710979, Лена:123456789</code>';
  await ctx.reply(t, { parse_mode: 'HTML' });
});

// ============================ РЕЗЕРВНАЯ КОПИЯ ============================

bot.command(['backup', 'kopiya'], async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Только руководитель.');
  const json = db.rawJson();
  const name = `backup-${P.today()}.json`;
  await ctx.replyWithDocument(new InputFile(Buffer.from(json, 'utf8'), name), {
    caption:
      `Полная копия базы на ${P.fmtDate(P.today())}.\n` +
      `Резидентов: ${db.residents().length}.\n\n` +
      `Сохрани файл у себя. Чтобы восстановить — пришли его боту с подписью restore.`,
  });
});

// Восстановление: прислать файл копии с подписью «restore»
bot.on('message:document', async (ctx, next) => {
  if (!isAdmin(ctx.from.id)) return next();
  const cap = (ctx.message.caption || '').trim().toLowerCase();
  if (cap !== 'restore') return next();

  const doc = ctx.message.document;
  if (!/\.json$/i.test(doc.file_name || '')) return ctx.reply('Нужен файл .json из /backup.');

  try {
    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
    const json = await (await fetch(url)).text();
    const preview = JSON.parse(json);
    restorePending.set(String(ctx.from.id), json);
    await ctx.reply(
      `В файле ${preview.residents?.length || 0} резидентов.\n\n` +
      `⚠️ Восстановление СОТРЁТ текущую базу (сейчас ${db.residents().length} резидентов).\n` +
      `Продолжить?`,
      { reply_markup: new InlineKeyboard().text('Да, восстановить', 'rok').text('Отмена', 'rno') });
  } catch (e) {
    await ctx.reply(`Не смог прочитать файл: ${e.message}`);
  }
});

const restorePending = new Map();

bot.callbackQuery('rno', async (ctx) => {
  restorePending.delete(String(ctx.from.id));
  await ctx.answerCallbackQuery({ text: 'Отменено' });
  await ctx.editMessageText('Отменено, база не тронута.');
});

bot.callbackQuery('rok', async (ctx) => {
  const json = restorePending.get(String(ctx.from.id));
  if (!json) return ctx.answerCallbackQuery({ text: 'Нечего восстанавливать' });
  restorePending.delete(String(ctx.from.id));
  try {
    const n = db.restore(json);
    await ctx.answerCallbackQuery({ text: 'Восстановлено' });
    await ctx.editMessageText(`База восстановлена. Резидентов: ${n}.`);
  } catch (e) {
    await ctx.editMessageText(`Не получилось: ${e.message}`);
  }
});

// ============================ ВЫГРУЗКА ТАБЛИЦЫ ============================

// CSV с точкой с запятой и BOM — чтобы Excel открыл сразу и по-русски
function buildCsv() {
  const rows = db.residents().map((r) => ({ r, s: P.status(r) }))
    .sort((a, b) => a.s.diff - b.s.diff);

  // колонки — задания основной программы, для срыва свои
  const cols = TRACKS.main.map((t) => t.short);
  const colsS = TRACKS.sryv.map((t) => t.short);

  const head = ['Резидент', 'Программа', 'Заезд', 'Выписка', 'День', 'Осталось дней',
    'Закрыто', 'Всего', 'Процент', 'Ожидалось', 'Отклонение', 'Статус', 'Текущее задание',
    ...cols, ...colsS];

  const label = { bad: 'сильно отстаёт', late: 'отстаёт', ok: 'нормально' };
  const lines = [head.join(';')];

  for (const { r, s } of rows) {
    const cur = P.currentTask(r);
    const cell = (t) => {
      if (!tasksFor(r).includes(t)) return '';
      const tp = P.taskProgress(r, t.code);
      if (!tp.started) return '';
      return tp.complete ? 'закрыто' : `${tp.done}/${tp.total}`;
    };
    lines.push([
      r.name, TRACK_NAME[trackOf(r)], P.fmtDate(r.startedAt), P.fmtDate(r.dischargeAt),
      P.dayOfProgram(r), s.daysLeft, s.done, s.total, s.percent + '%',
      s.expectedUnits, s.diff, label[s.state], cur ? cur.short : '',
      ...TRACKS.main.map((t) => cell(t)), ...TRACKS.sryv.map((t) => cell(t)),
    ].map((x) => String(x).includes(';') ? `"${x}"` : x).join(';'));
  }
  return '\uFEFF' + lines.join('\n');
}

async function sendTable(ctx) {
  if (!db.residents().length) return ctx.reply('Резидентов пока нет.');
  const csv = buildCsv();
  const name = `rc-${P.today()}.csv`;
  await ctx.replyWithDocument(new InputFile(Buffer.from(csv, 'utf8'), name), {
    caption: `Выгрузка на ${P.fmtDate(P.today())} · ${db.residents().length} резидентов.\n` +
             `Открывается в Excel и Google Таблицах.`,
  });
}

bot.hears('📄 Таблица', (ctx) => sendTable(ctx));
bot.command(['tablica', 'table'], (ctx) => sendTable(ctx));

// ============================ ИМПОРТ ОТЧЁТОВ МГ ============================

bot.callbackQuery('mgadd', async (ctx) => {
  waiting.set(String(ctx.from.id), 'mg');
  await ctx.answerCallbackQuery();
  await ctx.reply(
    '<b>Внести отчёты МГ</b>\n\n' +
    'Вставь текст отчётов как есть — хоть один, хоть переписку за неделю.\n' +
    'Бот покажет, что понял, и спросит подтверждение.\n\n' +
    'Понимает: <code>сф6 пр1, пр2</code> · <code>2 сфера 1-4 примеры</code> · ' +
    '<code>9/2, 9/3</code> · <code>закрыл задание</code>\n' +
    'Всё, что помечено «переписать» или ❌, не засчитывается.',
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('Отмена', 'tcancel') });
});

async function handleMgText(ctx) {
  const uid = String(ctx.from.id);
  const rows = parseReport(ctx.message.text, db.residents());
  if (!rows.length) return ctx.reply('Ничего не нашёл в тексте.');

  const good = rows.filter((r) => !r.error);
  const bad = rows.filter((r) => r.error);
  pending.set(uid, good);

  // считаем, у кого придётся дозакрыть предыдущие задания
  const prevInfo = [];
  const seen = new Set();
  for (const r of good) {
    const key = `${r.resident.id}:${r.task.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = tasksFor(r.resident);
    const idx = list.findIndex((t) => t.code === r.task.code);
    let n = 0;
    for (let i = 0; i < idx; i++) {
      if (!P.taskProgress(r.resident, list[i].code).complete) n++;
    }
    if (n) prevInfo.push(`${r.resident.name} — ${n}`);
  }

  let t = `<b>Разобрал ${good.length} строк</b>\n\n`;
  for (const r of good.slice(0, 30)) {
    t += `✅ ${r.resident.name} · ${r.task.short} — ${r.units.length} ед.` +
         (r.whole ? ' (задание целиком)' : '') + '\n';
  }
  if (good.length > 30) t += `…и ещё ${good.length - 30}\n`;

  if (prevInfo.length) {
    t += `\n<b>Заодно отмечу закрытыми предыдущие задания</b>\n`;
    t += prevInfo.slice(0, 20).join('\n') + '\n';
  }

  if (bad.length) {
    t += `\n<b>Не разобрал ${bad.length}</b>\n`;
    for (const r of bad.slice(0, 15)) t += `• ${r.raw.slice(0, 50)}\n  <i>${r.error}</i>\n`;
  }
  t += '\nЗаписать?';

  const kb = new InlineKeyboard().text('✅ Записать', 'mgok').text('Отмена', 'tcancel');
  await ctx.reply(t, { parse_mode: 'HTML', reply_markup: kb });
}

bot.callbackQuery('mgok', async (ctx) => {
  const uid = String(ctx.from.id);
  const rows = pending.get(uid);
  if (!rows) return ctx.answerCallbackQuery({ text: 'Нечего записывать' });
  pending.delete(uid);

  let changed = 0, closed = 0;
  for (const r of rows) {
    closed += P.closePreceding(r.resident, r.task.code);
    for (const [gi, ui] of r.units) {
      if (P.setUnit(r.resident, r.task.code, gi, ui, true)) {
        changed++;
        db.logEntry({ action: 'accept', residentId: r.resident.id, taskCode: r.task.code,
          groupIdx: gi, unitIdx: ui, by: ctx.from.id, byName: who(ctx), src: 'import' });
      }
    }
  }
  db.flush();
  await ctx.answerCallbackQuery({ text: 'Записано' });
  await ctx.editMessageText(
    `Записано ${changed} новых отметок.` +
    (closed ? `\nДозакрыто предыдущих заданий: ${closed}.` : '') +
    `\nПовторные не дублировались.`);
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

// Один раз просим человека выбрать себя из списка персонала
async function askWhoIfNeeded(ctx) {
  if (db.staffByTg(ctx.from.id)) return false;
  const kb = new InlineKeyboard();
  for (const st of db.staff()) kb.text(st.name, `me:${st.id}`).row();
  await ctx.reply('Прежде чем начать — выбери себя из списка. Один раз, дальше подпишется само.',
    { reply_markup: kb });
  return true;
}

bot.hears('📋 Задания', async (ctx) => {
  if (await askWhoIfNeeded(ctx)) return;
  await showList(ctx);
});

bot.command(['spisok', 'list', 'residents'], (ctx) => showList(ctx));

async function showList(ctx) {
  const kb = listKeyboard();
  if (!kb.inline_keyboard.length) {
    return ctx.reply('Резидентов пока нет.\n\n' + HELP, { parse_mode: 'HTML' });
  }
  kb.text('📥 Внести отчёты МГ', 'mgadd');
  await ctx.reply(`${LEGEND}\n\nКого отмечаем?`, { reply_markup: kb });
}

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
    groupIdx: gi, unitIdx: ui, by: ctx.from.id, byName: who(ctx),
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
        groupIdx: gi, unitIdx: i, by: ctx.from.id, byName: who(ctx) });
    }
  }
  db.save();
  await ctx.answerCallbackQuery({ text: 'Отмечено' });
  await showGroup(ctx, r, ti, gi);
});

// ============================ СВОДКА ============================

bot.hears('📊 Сводка', (ctx) => showSvodka(ctx));

bot.command(['svodka', 'today'], (ctx) => showSvodka(ctx));

async function showSvodka(ctx) {
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
}

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
    const last = db.logAll().filter((e) =>
      e.residentId === r.id && e.taskCode === task.code && e.action === 'accept').at(-1);
    const by = last?.byName ? ` · ${last.byName}` : '';
    t += tp.complete
      ? `✅ ${task.short} — закрыто ${P.fmtDate(tp.rec.closedAt)}${by}\n`
      : `▶️ ${task.short} — ${tp.done}/${tp.total}, открыто ${P.fmtDate(tp.rec.issuedAt)}${by}\n`;
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

// Приём текста для технички — работает в любой момент
bot.on('message:text', async (ctx, next) => {
  const uid = String(ctx.from.id);
  const mode = waiting.get(uid);
  if (!mode) return next();
  if (ctx.message.text.startsWith('/')) { waiting.delete(uid); return next(); }
  waiting.delete(uid);

  if (mode === 'mg') return handleMgText(ctx);

  const lines = ctx.message.text.split('\n').map((x) => x.trim()).filter(Boolean);
  for (const line of lines) {
    db.addTech({ text: line, by: ctx.from.id, byName: who(ctx) });
  }
  db.flush();
  await ctx.reply(lines.length === 1 ? 'Записал.' : `Записал ${lines.length} пункта.`);
  await showTech(ctx);
});

bot.catch((err) => console.error('Ошибка:', err.message));

process.once('SIGINT', () => { db.flush(); process.exit(0); });
process.once('SIGTERM', () => { db.flush(); process.exit(0); });

if (DEMO && seedDemo()) console.log('Демо-данные созданы');

bot.start({
  onStart: (i) => {
    console.log(`Бот @${i.username} запущен${DEMO ? ' в ДЕМО-режиме' : ''}`);
    console.log(`Резидентов: ${db.residents().length}`);
    const linked = db.staff().filter((x) => x.tgId);
    console.log(`Персонал: ${db.staff().length}, с привязанным ID: ${linked.length}`);
    if (fromEnv.length) console.log(`Из переменной STAFF: ${fromEnv.map((x) => x.name).join(', ')}`);
  },
});
