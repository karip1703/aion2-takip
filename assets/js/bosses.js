// Boss zamanlayıcıları (AION 2 Global EU).
//
// İki tür boss var:
//   * Saha bossları (Verteron = Elyos, Altgard = Asmodian): ÖLDÜKTEN sonra sabit sürede yeniden doğar.
//     Biri "Öldü" dediğinde sayaç başlar; bu bilgi data.json'da tutulur, herkeste görünür.
//   * Abyss bossları / etkinlikleri: sunucu saatine göre SABİT gün ve saatlerde çıkar (hesaplanır, kayıt gerekmez).
//
// data.json → bosses: {
//   kills: { [bossId]: { at, by } },   // son ölüm zamanı
//   watch: { [kullanıcı]: [bossId…] }  // kimin hangi bossları takip ettiği (bildirim bunlar için)
// }
// Süreler topluluk kaynaklarından (Kasım 2026). 4 Kasım yaması: Gartua (iki taraf) ve Lagta 12 → 11 saat,
// Argo the Spirit King sabit 10:30/22:30, Artifact Siege + Executors sadece Perşembe/Cumartesi.

import { esc, fmtAgo } from './render.js';

// EU sunucu saati: CET/CEST.
export const SERVER_TZ = 'Europe/Paris';

const H = 60;
const field = (map, list) => list.map(([name, area, respawn]) => ({
  id: `${map}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  name, area, map, respawn, kind: 'field',
}));

export const BOSSES = [
  ...field('Verteron', [
    ['Kernon of the West', 'Cantas Valley', 30],
    ['Neikel of the East', 'Cantas Valley', 30],
    ['Rotten Kutar', 'Elun River Swamp', 30],
    ['Blooming Korin', 'Elun River Midstream', 1 * H],
    ['Bodyguard Teegant', 'Fortress Ruins', 1.5 * H],
    ['Chaser Taulo', 'Aulau Village', 2 * H],
    ['Kusan the Mad Gladiator', 'Fortress Ruins', 2 * H],
    ['Ritualist Garshim', 'Fortress Ruins', 2 * H],
    ['Scholar Aulla', 'Aulau Village', 2 * H],
    ['Bloodfang Pnyn', 'Tolbas Forest', 3 * H],
    ['Furious Saursus', 'Tolbas Forest', 3 * H],
    ['Harvest Manager Moshav', 'Drana Plantation', 3 * H],
    ['Heretic Layla', 'Artamia Plateau', 3 * H],
    ['Black Tentacle Lawa', 'Artamia Gorge', 4 * H],
    ['Centurion Demiros', 'Artamia Plateau', 4 * H],
    ['Forest Warrior Aullamu', 'Aulau Village', 4 * H],
    ["Sentinel K'nash", 'Drana Plantation', 4 * H],
    ['Divine Ansas', 'Artamia Plateau', 6 * H],
    ['Phantasm Kasia', 'Garden of the Illusion God', 6 * H],
    ['Researcher Setram', 'Nahid Legion Fortress', 6 * H],
    ['Silent Dartan', 'Artamia Plateau South', 6 * H],
    ['Soul Ruler Kashapa', 'Artamia Plateau East', 6 * H],
    ['Eternal Gartua', 'Isle of Eternity', 11 * H],
    ['High Commander Lagta', 'Red Forest', 11 * H],
  ]),
  ...field('Altgard', [
    ['Black Warrior Aed', 'Nameless Graveyard', 30],
    ['Faithful Rajit', 'Sanctuary Watch Post', 30],
    ['Melted Danar', 'Dredgion Crash Site', 30],
    ['Berserker Vargor', 'Sanctuary Watch Post', 1 * H],
    ['Blood Warrior Lannar', 'Moslan Forest', 1.5 * H],
    ['Blue Wave Kelpina', 'Forest of Purification', 2 * H],
    ['Deceiver Trid', 'Urtumheim', 2 * H],
    ['High Overseer Nutah', 'Dranactus', 2 * H],
    ['Predator Garsan', 'Moslan Forest', 2 * H],
    ['Addicted Hardirun', 'Pafnite Burial Ground', 3 * H],
    ['Advisor Resana', 'Dranactus', 3 * H],
    ['Special Operations Leader Linx', 'Basfelt Ruins', 3 * H],
    ['Veteran Shujakan', 'Black Claw Village', 3 * H],
    ['Desecrator Newbold', 'Basfelt Ruins', 4 * H],
    ['Executioner Barthien', 'Gribade Canyon West', 4 * H],
    ['Specter Archon Axios', 'Basfelt Ruins', 4 * H],
    ['Visionary Karuka', 'Black Claw Village', 4 * H],
    ['Dark Shadow Vishwada', 'Ragta Fortress', 6 * H],
    ['Drakan Battalion Weapon Guruta', 'Gribade Canyon East', 6 * H],
    ['Sharp Shylak', 'Impetusium Plaza', 6 * H],
    ['Silent Dartan', 'Forest of Purification', 6 * H],
    ['Soul Ruler Kashapa', 'Pafnite Burial Ground', 6 * H],
    ['High Commander Lagta', 'Ragta Fortress', 11 * H],
    ['Immortal Gartua', 'Isle of Immortality', 11 * H],
  ]),
  // Abyss — sabit program (sunucu saati). days: 0=Pazar … 6=Cumartesi; null = her gün.
  { id: 'abyss-watcher-kaira', name: 'Watcher Kaira', area: 'Lower Reshanta (Chaotic)', map: 'Abyss', kind: 'schedule',
    days: null, times: ['01:00', '04:00', '07:00', '10:00', '13:00', '16:00', '19:00', '22:00'], duration: 30 },
  { id: 'abyss-argo-spirit-king', name: 'Argo, the Spirit King', area: "Siel's Wing Islands", map: 'Abyss', kind: 'schedule',
    days: null, times: ['10:30', '22:30'], duration: 30 },
  { id: 'abyss-artifact-siege', name: 'Artifact Siege', area: 'Lower Reshanta (Chaotic)', map: 'Abyss', kind: 'schedule',
    days: [4, 6], times: ['21:00'], duration: 30 },
  { id: 'abyss-executors', name: 'Executors Argo · Kaira · Tamasa', area: 'Lower Reshanta (Chaotic)', map: 'Abyss', kind: 'schedule',
    days: [4, 6], times: ['21:30'], duration: 30 },
];

export const MAPS = [
  { id: 'all', label: 'Tümü' },
  { id: 'Verteron', label: 'Verteron (Elyos)' },
  { id: 'Altgard', label: 'Altgard (Asmodian)' },
  { id: 'Abyss', label: 'Abyss' },
];

const DAY_TR = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];
export const bossById = (id) => BOSSES.find((b) => b.id === id);

// ---------------- Saat dilimi yardımcıları ----------------
// Saat dilimine göre biçimleyiciler (varsayılan sunucu saati; ör. sıfırlamalar UTC'ye sabit)
const fmts = new Map();
const partsFmt = (tz) => {
  if (!fmts.has(tz)) fmts.set(tz, new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short',
  }));
  return fmts.get(tz);
};
function zoned(ts, tz = SERVER_TZ) {
  const p = Object.fromEntries(partsFmt(tz).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
// Sunucu saatindeki y-m-d h:mi → UTC zaman damgası (yaz/kış saati dahil).
function serverToUtc(y, m, d, h, mi, tz = SERVER_TZ) {
  let guess = Date.UTC(y, m - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const z = zoned(guess, tz);
    const diff = Date.UTC(z.y, z.m - 1, z.d, z.h, z.mi) - Date.UTC(y, m - 1, d, h, mi);
    guess -= diff;
  }
  return guess;
}

// Sabit programlı boss: şu an aktifse o pencerenin başı, değilse bir sonraki başlangıç.
export function nextScheduled(b, now = Date.now()) {
  const tz = b.tz || SERVER_TZ;
  const base = zoned(now, tz);
  for (let k = -1; k <= 8; k++) {
    const day = new Date(Date.UTC(base.y, base.m - 1, base.d + k));
    const wd = day.getUTCDay();
    if (b.days && !b.days.includes(wd)) continue;
    for (const t of b.times) {
      const [h, mi] = t.split(':').map(Number);
      const start = serverToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, mi, tz);
      if (start + b.duration * 60_000 > now) return { start, end: start + b.duration * 60_000 };
    }
  }
  return null;
}

// Bir bossun durumu: { at: doğma/başlama zamanı, state: 'unknown'|'waiting'|'up'|'active' }
export function bossStatus(b, data, now = Date.now()) {
  if (b.kind === 'schedule') {
    const n = nextScheduled(b, now);
    if (!n) return { state: 'unknown' };
    return n.start <= now ? { state: 'active', at: n.start, end: n.end } : { state: 'waiting', at: n.start };
  }
  const k = data?.bosses?.kills?.[b.id];
  if (!k) return { state: 'unknown' };
  const at = Date.parse(k.at) + b.respawn * 60_000;
  return { state: at > now ? 'waiting' : 'up', at, killedAt: Date.parse(k.at), by: k.by };
}

// ---------------- İşlemler (ops.js üzerinden kaydedilir) ----------------
//   { type: 'bossKill', id, at, by }      → ölüm zamanını yaz
//   { type: 'bossReset', id }             → sayacı sil
//   { type: 'bossWatch', user, id, on }   → takip listesine ekle / çıkar

// "Saat…" girişi → ölüm zamanı (ms) ya da null.
//   14:35  → o saatte öldü (ileri bir saatse dün)
//   25     → 25 dakika önce öldü
//   +2:15 / +40 → oyundaki "kalan süre": 2 sa 15 dk / 40 dk sonra doğacak
export function parseKillInput(v, respawnMin, now = Date.now()) {
  const s = String(v ?? '').trim();
  let m = s.match(/^\+\s*(?:(\d{1,2})[:.])?(\d{1,3})$/);
  if (m) {
    const left = (Number(m[1] || 0) * 60 + Number(m[2])) * 60_000;
    return left > respawnMin * 60_000 ? null : now + left - respawnMin * 60_000;
  }
  m = s.match(/^(\d{1,2})[:.](\d{2})$/);
  if (m && Number(m[1]) < 24 && Number(m[2]) < 60) {
    const d = new Date(now); d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (d.getTime() > now + 60_000) d.setDate(d.getDate() - 1); // ileri bir saat → dün
    return d.getTime();
  }
  if (/^\d{1,4}$/.test(s)) return now - Number(s) * 60_000;
  return null;
}

export function applyBossOp(data, op) {
  if (!op.type.startsWith('boss')) return null;
  data.bosses ||= {};
  const B = data.bosses;
  B.kills ||= {};
  B.watch ||= {};
  switch (op.type) {
    case 'bossKill':
      if (!bossById(op.id) || B.kills[op.id]?.at === op.at) return false;
      B.kills[op.id] = { at: op.at, by: op.by || null };
      return true;
    case 'bossReset':
      if (!B.kills[op.id]) return false;
      delete B.kills[op.id];
      return true;
    case 'bossWatch': {
      const list = B.watch[op.user] ||= [];
      const has = list.includes(op.id);
      if (has === !!op.on) return false;
      B.watch[op.user] = op.on ? [...list, op.id] : list.filter((x) => x !== op.id);
      return true;
    }
    default:
      return false;
  }
}

export function bossOpMessage(op, data, by) {
  const who = by ? ` (${by})` : '';
  const name = bossById(op.id)?.name || op.id;
  switch (op.type) {
    case 'bossKill': return `Boss öldü: ${name} @ ${fmtClock(Date.parse(op.at))}${who}`;
    case 'bossReset': return `Boss sayacı silindi: ${name}${who}`;
    case 'bossWatch': return `Boss takibi ${op.on ? 'eklendi' : 'kaldırıldı'}: ${name}${who}`;
    default: return `Boss güncellendi${who}`;
  }
}

// ---------------- Biçimlendirme ----------------
export const fmtClock = (ts) => new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
function fmtDayClock(ts, now) {
  const d = new Date(ts), n = new Date(now);
  const sameDay = d.toDateString() === n.toDateString();
  const tmr = new Date(n); tmr.setDate(n.getDate() + 1);
  const prefix = sameDay ? '' : d.toDateString() === tmr.toDateString() ? 'yarın ' : `${DAY_TR[d.getDay()]} `;
  return prefix + fmtClock(ts);
}
export function fmtLeft(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m} dk`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return r ? `${h} sa ${r} dk` : `${h} sa`;
  return `${Math.floor(h / 24)} g ${h % 24} sa`;
}
const fmtRespawn = (min) => (min < 60 ? `${min} dk` : `${min / 60} sa`.replace('.5 sa', ' sa 30 dk'));
function scheduleText(b) {
  const days = b.days ? b.days.map((d) => DAY_TR[d]).join(', ') : 'Her gün';
  const times = b.times.length > 3 ? `${b.times[0]}'dan itibaren 3 saatte bir` : b.times.join(' ve ');
  return `${days} · ${times} (sunucu saati)`;
}

// Sıralama anahtarı: aktif/doğmuş en üstte, sonra yaklaşan, bilinmeyenler en sonda.
function sortKey(st, now) {
  if (st.state === 'active' || st.state === 'up') return -1e15 + (st.at || 0);
  if (st.state === 'waiting') return st.at - now;
  return 1e15;
}

export function renderBosses(root, data, { editable, user, filter, onlyWatched, notif, lead, now = Date.now() }) {
  const watched = new Set(data?.bosses?.watch?.[user] || []);
  const rows = BOSSES
    .filter((b) => filter === 'all' || b.map === filter)
    .filter((b) => !onlyWatched || watched.has(b.id))
    .map((b) => ({ b, st: bossStatus(b, data, now) }))
    .sort((x, y) => (watched.has(y.b.id) - watched.has(x.b.id)) || (sortKey(x.st, now) - sortKey(y.st, now)) || x.b.name.localeCompare(y.b.name));

  const dis = editable ? '' : 'disabled';
  const notifBtn = notif === 'unsupported' ? '<span class="hint">Bu tarayıcı bildirim desteklemiyor.</span>'
    : notif === 'granted' ? '<span class="pill edit" title="Takip ettiğin bosslar için bildirim gelir">🔔 Bildirimler açık</span>'
      : notif === 'denied' ? '<span class="hint">Bildirim izni engellenmiş — tarayıcının site ayarlarından izin ver.</span>'
        : '<button type="button" class="btn primary sm" id="boss-notif">🔔 Bildirimleri aç</button>';

  const row = ({ b, st }) => {
    const w = watched.has(b.id);
    let when = '', cls = '';
    if (st.state === 'active') { cls = 'up'; when = `<b>Şu an aktif</b> · ${fmtClock(st.end)}'a kadar`; }
    else if (st.state === 'up') { cls = 'up'; when = `<b>Doğdu</b> · ${fmtAgo(new Date(st.at).toISOString())}`; }
    else if (st.state === 'waiting') {
      const left = st.at - now;
      cls = left <= lead * 60_000 ? 'soon' : '';
      when = `<b>${fmtLeft(left)}</b> sonra · ${fmtDayClock(st.at, now)}`;
    } else when = '<span class="muted">Ölüm zamanı bilinmiyor</span>';

    const meta = b.kind === 'schedule' ? scheduleText(b)
      : `${fmtRespawn(b.respawn)}'de doğar${st.killedAt ? ` · öldü ${fmtClock(st.killedAt)}${st.by ? ` (${esc(st.by)})` : ''}` : ''}`;
    const acts = b.kind === 'field' && editable ? `
      <div class="boss-acts">
        <button type="button" class="btn sm primary" data-boss="kill" title="Şimdi öldü olarak işaretle">Öldü</button>
        <button type="button" class="btn sm" data-boss="time" title="Ölüm saatini gir">Saat…</button>
        ${st.killedAt ? '<button type="button" class="btn sm" data-boss="reset" title="Sayacı sil">✕</button>' : ''}
      </div>` : '';
    return `
      <li class="boss ${cls} ${w ? 'watched' : ''}" data-id="${esc(b.id)}">
        <button type="button" class="boss-star" data-boss="watch" ${dis} aria-pressed="${w}" title="${w ? 'Takipten çıkar' : 'Takip et (bildirim al)'}">${w ? '★' : '☆'}</button>
        <div class="boss-main">
          <div class="boss-name">${esc(b.name)} <span class="muted">${esc(b.area)} · ${esc(b.map)}</span></div>
          <div class="boss-meta muted">${meta}</div>
        </div>
        <div class="boss-when">${when}</div>
        ${acts}
      </li>`;
  };

  root.innerHTML = `
    <div class="toolbar boss-bar">
      <label>Harita:
        <select id="boss-filter">${MAPS.map((m) => `<option value="${m.id}" ${m.id === filter ? 'selected' : ''}>${m.label}</option>`).join('')}</select>
      </label>
      <label class="chk"><input type="checkbox" id="boss-only" ${onlyWatched ? 'checked' : ''}> Sadece takip ettiklerim (${watched.size})</label>
      <label>Önceden haber ver:
        <select id="boss-lead">${[0, 1, 3, 5, 10, 15].map((m) => `<option value="${m}" ${m === lead ? 'selected' : ''}>${m ? `${m} dk` : 'sadece doğunca'}</option>`).join('')}</select>
      </label>
      ${notifBtn}
    </div>
    ${editable ? '' : '<p class="hint">Takip etmek ve "Öldü" işaretlemek için giriş yap.</p>'}
    <p class="hint">★ ile takip ettiğin bosslar için bildirim gelir (site açık bir sekmede durmalı). Saha bossları öldükten sonra sayılır — "Öldü"ye basan kişinin işareti herkese yansır. Saatler bu bilgisayarın saatine göre gösterilir.</p>
    ${rows.length ? `<ul class="boss-list">${rows.map(row).join('')}</ul>` : '<p class="hint todo-empty">Bu filtrede boss yok.</p>'}`;
}

// ---------------- Bildirimler ----------------
// Takip edilen her boss için: doğmasına "lead" dk kala ve doğduğu an. Aynı bildirim iki kez gönderilmez
// (localStorage'da işaretlenir; sayfa yenilense de tekrar etmez).
const LS_SENT = 'aion2.bossSent';
function sentSet() { try { return JSON.parse(localStorage.getItem(LS_SENT) || '{}'); } catch { return {}; } }
function saveSent(s) {
  const cutoff = Date.now() - 2 * 86_400_000;
  for (const [k, t] of Object.entries(s)) if (t < cutoff) delete s[k];
  try { localStorage.setItem(LS_SENT, JSON.stringify(s)); } catch { /* yoksay */ }
}

export function dueNotifications(data, user, lead, now = Date.now()) {
  const out = [];
  for (const id of data?.bosses?.watch?.[user] || []) {
    const b = bossById(id);
    if (!b) continue;
    const st = bossStatus(b, data, now);
    if (!st.at) continue;
    const phases = lead > 0 ? [['pre', st.at - lead * 60_000], ['spawn', st.at]] : [['spawn', st.at]];
    for (const [phase, t] of phases) {
      // Zamanı geldiyse ve çok eskide kalmadıysa (sekme uzun süre kapalıysa eski bildirimleri boğma)
      if (t <= now && now - t < 10 * 60_000) out.push({ key: `${id}|${st.at}|${phase}`, b, phase, at: st.at });
    }
  }
  return out;
}

export function fireNotifications(data, user, lead, onInPage) {
  const sent = sentSet();
  let changed = false;
  for (const n of dueNotifications(data, user, lead)) {
    if (sent[n.key]) continue;
    sent[n.key] = Date.now();
    changed = true;
    const title = n.phase === 'pre' ? `${n.b.name} ${lead} dk sonra!` : `${n.b.name} ${n.b.kind === 'schedule' ? 'başladı' : 'doğdu'}!`;
    const body = `${n.b.area} · ${n.b.map} — ${fmtClock(n.at)}`;
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification(title, { body, tag: n.key, requireInteraction: n.phase === 'spawn' });
      }
    } catch { /* bazı mobil tarayıcılar sayfadan new Notification'a izin vermez */ }
    onInPage?.(title, body);
  }
  if (changed) saveSent(sent);
}
