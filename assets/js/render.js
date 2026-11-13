import { energyState, energyCfg, fmtDuration } from './energy.js';

const nf = new Intl.NumberFormat('tr-TR');
const dtf = new Intl.DateTimeFormat('tr-TR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const dtfFull = new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const num = (v) => (v == null || v === '' ? '—' : (Number.isFinite(+v) ? nf.format(+v) : esc(v)));

export function fmtAgo(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'hiç';
  const diff = now - t;
  if (diff < 60_000) return 'az önce';
  return `${fmtDuration(diff)} önce`;
}
export const fmtDate = (iso) => (Number.isFinite(Date.parse(iso)) ? dtfFull.format(new Date(iso)) : '—');

export const effEnergy = (ch, edits) => edits[ch.id] || ch.energy || null;

// Sadece https görsellere izin ver (veri dış kaynaktan geliyor).
const safeImg = (u) => typeof u === 'string' && /^https:\/\//i.test(u);
const itemIcon = (it) => (safeImg(it.icon) ? `<img class="icon" src="${esc(it.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '');
const gradeClass = (g) => (g ? `grade grade-${String(g).toLowerCase().replace(/[^a-z]/g, '')}` : 'grade');
// +15 ✦4  (enchant + exceed)
const enchHtml = (it) => (it.enchant || it.exceed
  ? `<span class="ench">+${num(it.enchant || 0)}</span>${it.exceed ? ` <span class="exceed" title="Exceed ${num(it.exceed)}">✦${num(it.exceed)}</span>` : ''}`
  : '—');

function energyClass(st, nearFullHours) {
  if (!st.known) return '';
  if (st.isFull) return 'is-full';
  if (st.msToFull != null && st.msToFull <= nearFullHours * 3_600_000) return 'is-near';
  return '';
}

// ---------------- Kartlar ----------------

export function renderCards(root, data, ctx) {
  const { characters = [], config = {} } = data;
  if (!characters.length) {
    root.innerHTML = '<p class="hint">data.json içinde karakter yok.</p>';
    return;
  }
  const steps = config.energy?.steps?.length ? config.energy.steps : [10, 40];
  root.innerHTML = characters.map((ch) => cardHtml(ch, config, steps, ctx)).join('');
  updateEnergyLive(root, data, ctx);
}

function cardHtml(ch, config, steps, ctx) {
  const g = ch.game || {};
  const gear = Array.isArray(g.gear) ? g.gear : [];
  const eName = esc(config.energy?.name || 'Enerji');
  const dis = ctx.editable ? '' : 'disabled';
  const bonusSteps = config.energy?.bonusSteps?.length ? config.energy.bonusSteps : steps;
  const spendSteps = config.energy?.spendSteps?.length ? config.energy.spendSteps : [40, 80];
  const ctrl = (pool, st, inputKey, label) => `
      <div class="energy-row">
        <span class="lbl">${label}</span>
        <div class="energy-ctrl" data-pool="${pool}">
          ${[...st].reverse().map((s) => `<button type="button" class="btn sm" data-delta="-${s}" ${dis}>−${s}</button>`).join('')}
          <input type="number" inputmode="numeric" min="0" step="1" data-e="${inputKey}" aria-label="${eName} ${label}" ${dis}>
          ${st.map((s) => `<button type="button" class="btn sm" data-delta="${s}" ${dis}>+${s}</button>`).join('')}
        </div>
      </div>`;

  return `
  <article class="card" data-id="${esc(ch.id)}">
    <div class="card-head card-open" title="Detaylar için tıkla">
      ${safeImg(g.profileImage) ? `<img class="avatar" src="${esc(g.profileImage)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
      <div class="who">
        <h3>${esc(ch.name)}${ch.owner ? `<span class="owner">${esc(ch.owner)}</span>` : ''}${ch.sample ? '<span class="sample-tag">örnek veri</span>' : ''}</h3>
        ${g.title ? `<div class="title-txt">${esc(g.title)}</div>` : ''}
      </div>
      <div class="meta">${esc(g.class || '—')}<br>Lv ${num(g.level)}${g.race ? ` · ${esc(g.race)}` : ''}</div>
    </div>

    <div class="stats card-open">
      <div class="stat"><span class="k">Item lvl</span><span class="v">${num(g.itemLevel)}</span></div>
      <div class="stat"><span class="k">Combat P.</span><span class="v">${num(g.combatPower)}</span></div>
      <div class="stat"><span class="k">Sunucu</span><span class="v">${esc(ch.server || config.server || '—')}</span></div>
    </div>

    <div class="energy">
      <div class="energy-top">
        <span>${eName}</span>
        <span><span class="now" data-e="now">—</span> <span class="bonus-tag" data-e="bonusTag" hidden></span></span>
      </div>
      <div class="bar"><i data-e="bar"></i></div>
      <div class="energy-info">
        <span class="full-txt" data-e="full">—</span>
        <span data-e="next"></span>
        <span data-e="set"></span>
      </div>
      ${ctrl('natural', steps, 'input', 'Zamanla')}
      ${ctrl('bonus', bonusSteps, 'bonus', 'Ek (+)')}
      <div class="energy-row">
        <span class="lbl spend-lbl">Harca</span>
        <div class="energy-ctrl">
          ${spendSteps.map((s) => `<button type="button" class="btn sm spend" data-spend="${s}" ${dis} title="Önce zamanla dolan, sonra ek (+) kısımdan düşer">−${s}</button>`).join('')}
        </div>
      </div>
      <div class="energy-total">
        <span>Toplam: <b data-e="total">—</b></span>
        <span class="dirty-dot" data-e="dirty" hidden>● kaydedilmedi</span>
      </div>
    </div>

    <button type="button" class="open-char" data-open="${esc(ch.id)}" title="Gear, arcana ve skill detayları">
      <span>Gear <b>${splitGear(gear).gear.length}</b></span>
      <span>Arcana <b>${splitGear(gear).arcana.length}</b></span>
      <span>Skill <b>${(g.skills || []).length}</b></span>
      ${(ch.dungeons || []).length ? `<span>Zindan <b>${ch.dungeons.length}</b></span>` : ''}
      <span class="go">Detay ›</span>
    </button>

    <div class="updated" title="${esc(fmtDate(g.updatedAt))}">Gear güncellendi: ${esc(fmtAgo(g.updatedAt))}</div>
    ${ch.lastError ? `<div class="err" title="${esc(ch.lastError.at)}">Son çekme hatası: ${esc(ch.lastError.message)}</div>` : ''}
  </article>`;
}

// Her saniye/dakika çağrılır: sadece enerji metinleri değişir, kart yeniden çizilmez.
export function updateEnergyLive(root, data, ctx) {
  const cfg = data.config?.energy || {};
  const near = Number(data.config?.nearFullHours ?? 3);
  const now = Date.now();

  for (const ch of data.characters || []) {
    const card = root.querySelector(`.card[data-id="${CSS.escape(ch.id)}"]`);
    if (!card) continue;
    const en = effEnergy(ch, ctx.edits);
    const st = energyState(en, energyCfg(data, ch), now);
    const q = (k) => card.querySelector(`[data-e="${k}"]`);

    card.classList.remove('is-full', 'is-near');
    const cls = energyClass(st, near);
    if (cls) card.classList.add(cls);

    if (!st.known) {
      q('now').textContent = `? / ${nf.format(st.max)}`;
      q('bar').style.width = '0%';
      q('full').textContent = 'Henüz değer girilmedi';
      q('next').textContent = '';
      q('set').textContent = '';
    } else {
      q('now').textContent = `~${nf.format(st.current)} / ${nf.format(st.max)}`;
      q('bar').style.width = `${(st.ratio * 100).toFixed(1)}%`;
      q('full').textContent = st.isFull ? 'FULL!' : `Full: ${fmtDuration(st.msToFull)} (${dtf.format(st.fullAt)})`;
      q('next').textContent = st.msToNextTick != null ? `Sonraki +${cfg.regenAmount}: ${fmtDuration(st.msToNextTick)}` : '';
      const at = en.editedAt || en.setAt;
      q('set').textContent = `Girildi: ${fmtAgo(at, now)}${en.setBy ? ` · ${en.setBy}` : ''}`;
      q('set').title = fmtDate(at);
    }

    const tag = q('bonusTag');
    tag.hidden = !st.bonus;
    tag.textContent = `+${nf.format(st.bonus)}`;
    q('total').textContent = st.known || st.bonus ? nf.format(st.total) : '—';

    const input = q('input');
    if (document.activeElement !== input) input.value = st.known ? st.current : '';
    const bInput = q('bonus');
    if (document.activeElement !== bInput) bInput.value = st.bonus;
    q('dirty').hidden = !ctx.edits[ch.id];
  }
}

// ---------------- Karakter penceresi (Gear / Arcana / Skill) ----------------

const isArcana = (it) => it.slotPos >= 41 || /^arcana/i.test(it.slot || '');
export function splitGear(gear = []) {
  const arcana = gear.filter(isArcana);
  return { gear: gear.filter((it) => !isArcana(it)), arcana };
}

// Gear sekmesindeki gruplar (slotPos'a göre; bilinmeyen slot "Aksesuar"a düşer)
const GEAR_GROUPS = [
  { title: 'Silah & Zırh', test: (p) => (p >= 1 && p <= 9) || p === 19 },
  { title: 'Rün', test: (p) => p === 23 || p === 24 },
  { title: 'Aksesuar', test: () => true },
];

export const CHAR_TABS = [
  { id: 'gear', label: 'Gear' },
  { id: 'arcana', label: 'Arcana' },
  { id: 'skills', label: 'Skill' },
  { id: 'dungeons', label: 'Zindanlar' },
];

export function charDialogHtml(ch, tab, { editable = false } = {}) {
  const g = ch.game || {};
  const { gear, arcana } = splitGear(g.gear || []);
  const counts = { gear: gear.length, arcana: arcana.length, skills: (g.skills || []).length, dungeons: (ch.dungeons || []).length };

  const head = `
    <div class="cd-head">
      ${safeImg(g.profileImage) ? `<img class="avatar lg" src="${esc(g.profileImage)}" alt="" referrerpolicy="no-referrer">` : ''}
      <div class="who">
        <h2>${esc(ch.name)}${ch.sample ? '<span class="sample-tag">örnek veri</span>' : ''}</h2>
        <div class="muted">${[esc(g.class), g.level ? `Lv ${num(g.level)}` : '', esc(g.race), esc(g.title)].filter(Boolean).join(' · ')}</div>
      </div>
      <div class="cd-stats">
        <div><span class="k">Item lvl</span><b>${num(g.itemLevel)}</b></div>
        <div><span class="k">Combat P.</span><b>${num(g.combatPower)}</b></div>
      </div>
    </div>
    <div class="cd-tabs" role="tablist">
      ${CHAR_TABS.map((t) => `<button type="button" role="tab" class="cd-tab" data-tab="${t.id}" aria-selected="${t.id === tab}">
        ${t.label} <span class="cnt">${counts[t.id]}</span></button>`).join('')}
    </div>`;

  const body = tab === 'arcana' ? arcanaTab(ch, arcana)
    : tab === 'skills' ? skillsTab(g.skills || [])
      : tab === 'dungeons' ? dungeonsTab(ch, editable)
        : gearTab(ch, gear, g);
  return `${head}<div class="cd-body">${body}</div>
    <div class="updated">Veri güncellendi: ${esc(fmtAgo(g.updatedAt))}</div>`;
}

const tile = (ch, it, extra = '') => `
  <div class="tile clickable" data-char="${esc(ch.id)}" data-slot="${esc(it.slot)}" tabindex="0" title="Detay için tıkla">
    ${itemIcon(it).replace('class="icon"', 'class="icon md"')}
    <div class="tile-txt">
      <div class="${gradeClass(it.grade)} tname">${esc(it.name)}</div>
      <div class="muted">${esc(it.slot)} · ${enchHtml(it)}${it.itemLevel != null ? ` · iLvl ${num(it.itemLevel)}` : ''}</div>
      ${extra}
    </div>
  </div>`;

function gearTab(ch, gear, g) {
  if (!gear.length) return '<p class="hint">Gear verisi yok.</p>';
  const used = new Set();
  const groups = GEAR_GROUPS.map((grp) => {
    const items = gear.filter((it) => !used.has(it) && grp.test(Number(it.slotPos)));
    items.forEach((it) => used.add(it));
    return items.length ? `<h3 class="grp">${grp.title}</h3><div class="tiles">${items.map((it) => tile(ch, it)).join('')}</div>` : '';
  }).join('');

  const extras = [
    g.wing && { ...g.wing, slot: 'Kanat' },
    g.wingSkin && { ...g.wingSkin, slot: 'Kanat görünümü' },
    g.pet && { name: g.pet.name, icon: g.pet.icon, slot: `Pet · Lv ${num(g.pet.level)}` },
  ].filter(Boolean);
  const extraHtml = extras.length ? `<h3 class="grp">Kanat & Pet</h3><div class="tiles">${extras.map((it) => `
    <div class="tile">
      ${itemIcon(it).replace('class="icon"', 'class="icon md"')}
      <div class="tile-txt"><div class="${gradeClass(it.grade)} tname">${esc(it.name)}</div>
      <div class="muted">${esc(it.slot)}${it.enchant ? ` · <span class="ench">+${num(it.enchant)}</span>` : ''}</div></div>
    </div>`).join('')}</div>` : '';

  return groups + extraHtml;
}

function arcanaTab(ch, arcana) {
  if (!arcana.length) return '<p class="hint">Arcana verisi yok.</p>';
  return `<div class="tiles wide">${arcana.map((it) => {
    const d = it.detail;
    const stats = d ? [
      ...(d.main || []).map((s) => `<li><span>${esc(s.name)}</span><b>${esc(s.value)}${s.extra ? ` <span class="plus">+${esc(s.extra)}</span>` : ''}</b></li>`),
      ...(d.sub || []).map((s) => `<li class="${s.added ? 'added' : ''}"><span>${esc(s.name)}</span><b>${esc(s.value)}</b></li>`),
      ...(d.subSkills || []).map((s) => `<li class="skill-li ${s.added ? 'added' : ''}"><span class="sk">${safeImg(s.icon) ? `<img class="icon xs" src="${esc(s.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}${esc(s.name)}</span><b>${s.level != null ? `Lv +${num(s.level)}` : ''}</b></li>`),
    ].join('') : '';
    return tile(ch, it, stats ? `<ul class="mini-stats">${stats}</ul>` : '');
  }).join('')}</div>`;
}

// Zindan garanti sayaçları: ilerleme çubuğu, ±1, elle düzenleme, silme, yeni zindan ekleme.
function dungeonsTab(ch, editable) {
  const list = ch.dungeons || [];
  const rows = list.map((d) => {
    const pct = d.max ? Math.min(100, (d.count / d.max) * 100) : 0;
    const left = d.max ? d.max - d.count : null;
    const near = d.max && left <= 2;
    return `
    <div class="dg ${near ? 'near' : ''}" data-dungeon="${esc(d.name)}">
      <div class="dg-top">
        <b class="dg-name">${esc(d.name)}</b>
        <span class="dg-count"><b>${num(d.count)}</b> / ${d.max ? num(d.max) : '?'}</span>
      </div>
      <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
      <div class="dg-bottom">
        <span class="muted">${left != null ? (left === 0 ? 'Garanti hazır' : `Garantiye ${num(left)} kutu`) : 'Sınır bilinmiyor'}
          · ${esc(fmtAgo(d.updatedAt))}${d.updatedBy ? ` · ${esc(d.updatedBy)}` : ''}</span>
        ${editable ? `<span class="dg-actions">
          <button type="button" class="btn sm" data-dg="dec" title="−1">−1</button>
          <button type="button" class="btn sm" data-dg="inc" title="+1">+1</button>
          <button type="button" class="btn sm" data-dg="edit" title="Değeri düzenle">✎</button>
          <button type="button" class="btn sm danger" data-dg="del" title="Sil">✕</button>
        </span>` : ''}
      </div>
    </div>`;
  }).join('');

  const form = editable ? `
    <form class="dg-form" data-dg-form>
      <input type="text" name="name" placeholder="Zindan adı (ör. Fire Temple)" required maxlength="60" autocomplete="off">
      <input type="number" name="count" placeholder="Şu an" min="0" inputmode="numeric" class="short">
      <input type="number" name="max" placeholder="Sınır" min="1" inputmode="numeric" class="short" required>
      <button type="submit" class="btn primary">Ekle</button>
    </form>` : '';

  return `
    <p class="hint">Garanti sayaçları karaktere ve zindana özeldir. Sınıra ulaşınca garanti ödülü verilir ve sayaç sıfırlanır.
      Ekran okuma programı kutu açtığınızda bunları otomatik günceller.</p>
    ${rows ? `<div class="dgs">${rows}</div>` : '<p class="hint">Henüz zindan sayacı yok.</p>'}
    ${form}`;
}

const SKILL_GROUPS = [
  { id: 'Active', title: 'Aktif' },
  { id: 'Passive', title: 'Pasif' },
  { id: 'Dp', title: 'DP' },
];

function skillsTab(skills) {
  if (!skills.length) return '<p class="hint">Skill verisi yok. Bir sonraki otomatik güncellemede gelecek.</p>';
  const known = new Set(SKILL_GROUPS.map((x) => x.id));
  const groups = [...SKILL_GROUPS, { id: '__other', title: 'Diğer' }];
  return groups.map((grp) => {
    const list = skills
      .filter((s) => (grp.id === '__other' ? !known.has(s.category) : s.category === grp.id))
      .sort((a, b) => (b.acquired - a.acquired) || (b.equip - a.equip) || ((b.level || 0) - (a.level || 0)));
    if (!list.length) return '';
    const eq = list.filter((s) => s.equip).length;
    return `<h3 class="grp">${grp.title} <span class="muted">${list.length} skill${eq ? ` · ${eq} takılı` : ''}</span></h3>
      <div class="skills">${list.map((s) => `
        <div class="skill ${s.acquired ? '' : 'locked'} ${s.equip ? 'equipped' : ''}" title="${esc(s.name)}${s.acquired ? '' : ' (öğrenilmedi)'}">
          ${safeImg(s.icon) ? `<img class="icon md" src="${esc(s.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="icon md"></span>'}
          <div class="tile-txt">
            <div class="tname">${esc(s.name)}</div>
            <div class="muted">${[
              s.acquired ? (s.level ? `Lv ${num(s.level)}` : '') : 'Öğrenilmedi',
              s.equip ? '<span class="eq">takılı</span>' : '',
            ].filter(Boolean).join(' · ') || '&nbsp;'}</div>
          </div>
        </div>`).join('')}
      </div>`;
  }).join('');
}

// ---------------- Eşya detay penceresi ----------------

export function itemDetailHtml(ch, it) {
  const d = it.detail;
  const gc = gradeClass(it.grade);
  const big = safeImg(it.icon) ? `<img class="icon-lg" src="${esc(it.icon)}" alt="" referrerpolicy="no-referrer">` : '';
  const badges = [
    `<span class="badge"><span class="ench">+${num(it.enchant || 0)}</span>${d?.maxEnchant ? ` / ${num(d.maxEnchant)}` : ''}</span>`,
    it.exceed || d?.maxExceed ? `<span class="badge"><span class="exceed">✦${num(it.exceed || 0)}</span>${d?.maxExceed ? ` / ${num(d.maxExceed)}` : ''}</span>` : '',
    it.itemLevel != null ? `<span class="badge">iLvl ${num(it.itemLevel)}</span>` : '',
    d?.soulBind ? `<span class="badge">Soul bind %${esc(d.soulBind)}</span>` : '',
  ].join('');

  const head = `
    <div class="idlg-head">
      ${big}
      <div>
        <h2 class="${gc}">${esc(it.name)}</h2>
        <div class="muted">${[esc(ch.name), esc(it.slot), esc(d?.category), d?.equipLevel ? `Lv ${num(d.equipLevel)}` : '', esc(it.grade)].filter(Boolean).join(' · ')}</div>
      </div>
    </div>
    <div class="badges">${badges}</div>`;

  if (!d) return `${head}<p class="hint">Bu parçanın detayı henüz çekilmedi. Bir sonraki otomatik güncellemede gelecek.</p>`;

  const section = (title, body) => (body ? `<section class="isec"><h3>${title}</h3>${body}</section>` : '');

  const main = d.main?.length ? `<table class="stats-tbl">${d.main.map((s) => `
    <tr><td>${esc(s.name)}</td><td class="num">${s.min ? `<span class="muted">${esc(s.min)}–</span>` : ''}${esc(s.value)}${s.extra ? ` <span class="plus">+${esc(s.extra)}</span>` : ''}</td></tr>`).join('')}</table>` : '';

  // Ek statlar + ek skill'ler aynı bölümde: önce statlar, sonra skill'ler (ikon + seviye).
  const subRows = [
    ...(d.sub || []).map((s) => `
    <tr class="${s.added ? 'added' : ''}"><td>${esc(s.name)}${s.added ? ' <span class="tag">eklenen</span>' : ''}</td><td class="num">${esc(s.value)}</td></tr>`),
    ...(d.subSkills || []).map((s) => `
    <tr class="skill-row ${s.added ? 'added' : ''}"><td><span class="sk">${safeImg(s.icon) ? `<img class="icon" src="${esc(s.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}${esc(s.name)}</span>${s.added ? ' <span class="tag">eklenen</span>' : ''}</td>
      <td class="num">${s.level != null ? `Lv +${num(s.level)}` : ''}</td></tr>`),
  ];
  const sub = subRows.length ? `<table class="stats-tbl">${subRows.join('')}</table>` : '';

  const set = d.set ? `<div class="set">
      <div><b>${esc(d.set.name)}</b> <span class="muted">(${num(d.set.equipped)}/${num(d.set.items?.length || 0)} takılı)</span></div>
      <ul class="set-bonus">${(d.set.bonuses || []).map((b) => `
        <li class="${d.set.equipped >= b.degree ? 'on' : ''}"><span class="deg">${num(b.degree)} parça</span>${(b.text || []).map((t) => esc(t)).join('<br>')}</li>`).join('')}
      </ul>
      <div class="muted set-items">${(d.set.items || []).map((i) => (i.equipped ? `<b>${esc(i.name)}</b>` : esc(i.name))).join(' · ')}</div>
    </div>` : '';

  const stones = (list, slots, withDesc) => {
    if (!slots && !list?.length) return '';
    const rows = (list || []).map((s) => `
      <li>
        ${safeImg(s.icon) ? `<img class="icon" src="${esc(s.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
        <div><span class="${gradeClass(s.grade)}">${esc(s.name)}</span>${s.value ? ` <b>${esc(s.value)}</b>` : ''}
        ${withDesc && s.desc ? `<div class="desc">${esc(s.desc)}</div>` : ''}</div>
      </li>`);
    for (let i = (list || []).length; i < slots; i++) rows.push('<li class="empty">Boş yuva</li>');
    return `<ul class="stones">${rows.join('')}</ul>`;
  };

  return head
    + section('Ana statlar', main)
    + section(`Ek statlar${d.subSkills?.length ? ' & skill' : ''}`, sub)
    + section('Set', set)
    + section(`Büyü taşları <span class="muted">(${(d.magicStones || []).length}/${d.magicSlots || 0})</span>`, stones(d.magicStones, d.magicSlots, false))
    + section(`Tanrı taşı <span class="muted">(${(d.godStones || []).length}/${d.godSlots || 0})</span>`, stones(d.godStones, d.godSlots, true))
    + (d.desc ? `<p class="desc-txt">${esc(d.desc)}</p>` : '');
}

// ---------------- Karşılaştırma ----------------

export function renderCompare(rankEl, matrixEl, data, sortKey, ctx) {
  const cfg = data.config?.energy || {};
  const near = Number(data.config?.nearFullHours ?? 3);
  const now = Date.now();

  const rows = (data.characters || []).map((ch) => {
    const st = energyState(effEnergy(ch, ctx.edits), energyCfg(data, ch), now);
    const g = ch.game || {};
    return {
      ch, st,
      itemLevel: +g.itemLevel || 0,
      combatPower: +g.combatPower || 0,
      level: +g.level || 0,
      energy: st.known || st.bonus ? st.total : -1,
    };
  });
  rows.sort((a, b) => b[sortKey] - a[sortKey] || a.ch.name.localeCompare(b.ch.name, 'tr'));

  const maxOf = (k) => Math.max(1, ...rows.map((r) => r[k]));
  const mIL = maxOf('itemLevel');
  const mCP = maxOf('combatPower');
  const bar = (v, m) => `<div class="rbar"><i style="width:${((v / m) * 100).toFixed(1)}%"></i></div>`;

  rankEl.innerHTML = `
    <thead><tr>
      <th>#</th><th>Karakter</th><th>Sınıf</th><th class="num">Lv</th>
      <th class="num">Item lvl</th><th class="num">Combat P.</th><th class="num" title="${esc(cfg.name || 'Enerji')} — zamanla biriken">Zamanla</th><th class="num">Ek (+)</th><th class="num">Toplam</th><th class="num">Full'e</th>
    </tr></thead>
    <tbody>${rows.map((r, i) => `
      <tr class="${energyClass(r.st, near)}">
        <td>${i + 1}</td>
        <td><strong>${esc(r.ch.name)}</strong>${r.ch.owner ? ` <span class="owner">${esc(r.ch.owner)}</span>` : ''}</td>
        <td>${esc(r.ch.game?.class || '—')}</td>
        <td class="num">${num(r.ch.game?.level)}</td>
        <td class="num">${num(r.ch.game?.itemLevel)}${bar(r.itemLevel, mIL)}</td>
        <td class="num">${num(r.ch.game?.combatPower)}${bar(r.combatPower, mCP)}</td>
        <td class="num">${r.st.known ? `~${nf.format(r.st.current)}` : '?'}</td>
        <td class="num">${r.st.bonus ? `+${nf.format(r.st.bonus)}` : '—'}</td>
        <td class="num"><strong>${r.st.known || r.st.bonus ? nf.format(r.st.total) : '—'}</strong></td>
        <td class="num">${r.st.known ? (r.st.isFull ? '<strong>FULL</strong>' : fmtDuration(r.st.msToFull)) : '—'}</td>
      </tr>`).join('')}
    </tbody>`;

  // Slot × karakter matrisi. Slot listesi karakter verilerinden, ilk görülme sırasıyla.
  const chars = rows.map((r) => r.ch);
  const slots = [];
  for (const ch of chars) for (const it of ch.game?.gear || []) if (!slots.includes(it.slot)) slots.push(it.slot);

  if (!slots.length) { matrixEl.innerHTML = '<tbody><tr><td>Gear verisi yok.</td></tr></tbody>'; return; }

  const bySlot = (ch, slot) => (ch.game?.gear || []).find((it) => it.slot === slot);
  matrixEl.innerHTML = `
    <thead><tr><th>Slot</th>${chars.map((c) => `<th>${esc(c.name)}</th>`).join('')}</tr></thead>
    <tbody>${slots.map((slot) => {
      const items = chars.map((c) => bySlot(c, slot));
      const best = Math.max(...items.map((it) => +it?.itemLevel || 0));
      return `<tr><td class="slot">${esc(slot)}</td>${items.map((it, ci) => {
        if (!it) return '<td>—</td>';
        const isBest = best > 0 && +it.itemLevel === best && items.filter(Boolean).length > 1;
        return `<td class="clickable ${isBest ? 'best' : ''}" data-char="${esc(chars[ci].id)}" data-slot="${esc(slot)}" tabindex="0">
          <div class="item">${itemIcon(it)}<span class="${gradeClass(it.grade)}">${esc(it.name)}</span></div>
          <div class="il">${enchHtml(it)} · iLvl ${num(it.itemLevel)}</div></td>`;
      }).join('')}</tr>`;
    }).join('')}
    </tbody>`;
}
