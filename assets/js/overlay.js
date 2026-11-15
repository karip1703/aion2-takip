// Karip Traker — oyun içi arayüz.
//
// overlay.html?w=hub      → oyun içi menü (Alt+Shift+O): Enerji, Bosslar, Gear, Yapılacaklar… düğmeleri ve ayarlar.
// overlay.html?w=<id>     → tek bir bileşenin kendi penceresi; ekranın istenen yerine taşınır.
//
// Pencereleri masaüstü uygulaması (tools/izleyici) açar, üstte tutar ve saydamlığını yönetir:
//   oyun modu     : yarı saydam, tıklamalar içinden oyuna geçer
//   kullanım modu : imleç bileşenin üstüne gelince (ya da düzenleme modunda) tam görünür ve tıklanabilir
// Edge'in başlık çubuğu gizlendiği için taşıma / boyutlandırma bu sayfanın başlığından ve sağ alt köşesinden yapılır.
//
// Yeni bileşen eklemek: WIDGETS listesine { title, icon, hint, render(c), settings?() } ekle; menüde kendiliğinden çıkar.
// (overlay.html içindeki başlık listesine de adını ekle: uygulama pencereyi başlığından bulur.)

import { getSession, setSession } from './auth.js';
import * as gh from './github.js';
import { esc, effEnergy, splitGear } from './render.js';
import { energyState, energyCfg, fmtDuration } from './energy.js';
import { BOSSES, bossStatus, fmtLeft, fmtClock, SERVER_TZ, nextScheduled } from './bosses.js';
import { EVENTS } from './events.js';
import { LOCAL, appApi } from './izleyici.js';

const W = new URLSearchParams(location.search).get('w') || 'hub';
const $ = (s, el = document) => el.querySelector(s);
const nf = new Intl.NumberFormat('tr-TR');
const dpr = () => window.devicePixelRatio || 1;

// ---------------------------------------------------------------- İkonlar
const svg = (d) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICON = {
  remind: svg('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
  dps: svg('<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>'),
  energy: svg('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  bosses: svg('<path d="M12 3c-4.4 0-8 3.2-8 7.3 0 2.4 1.2 4.4 3 5.7V20h3v-2h4v2h3v-4c1.8-1.3 3-3.3 3-5.7C20 6.2 16.4 3 12 3z"/><circle cx="9" cy="11" r="1.6"/><circle cx="15" cy="11" r="1.6"/>'),
  gear: svg('<path d="M12 3l8 3v6c0 4.6-3.4 8-8 9-4.6-1-8-4.4-8-9V6z"/><path d="M9 12l2 2 4-4"/>'),
  todos: svg('<path d="M9 6h11M9 12h11M9 18h11"/><path d="M3.5 6l1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11M3.5 18l1.5 1.5L7.5 17"/>'),
  dungeons: svg('<path d="M4 21V9l8-5 8 5v12"/><path d="M9 21v-6a3 3 0 0 1 6 0v6"/>'),
  lastbox: svg('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  status: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
};

// ---------------------------------------------------------------- Durum
const st = { data: null, etag: null, user: null, err: '' };
let ov = null;            // uygulamanın durumu (/api/ov)
let online = false;
let net = null;           // ağ okuma durumu (/api/net): hasar, hedef, enerji

// ---------------------------------------------------------------- Tercihler (kullanıcıya özel, tüm pencereler paylaşır)
const DEFAULTS = {
  scale: 100,         // yazı boyutu (%)
  energyChars: null,  // null = hepsi
  bossCount: 5,
  bossLead: 5,        // bu kadar dakika kala turuncu
  todoCount: 6,
  gearChar: null,     // null = aktif karakter
  remind: {},         // { boss/etkinlik id: [1,3,5] } → kaç dk kala haber verilsin
  remindSound: true,
  dpsRows: 8,
  dpsNamedOnly: false,
  dpsMode: 'party',   // me | party | all
  dpsCols: { dmg: true, crit: false, max: false, taken: false },
  dpsEnergy: true,    // altta oyundaki karakterin enerjisi
  partyCols: 'both',  // parti görünümü: both | cp | gs
  partyAuto: true,    // savaş yokken partiyi göster
  partyLevel: false,  // parti satırında seviye
  fixed: {},          // { bileşen: true } → yükseklik elle ayarlandı (içeriğe oturtma kapalı)
};
const prefKey = () => `kt.overlay.v2.${st.user || 'misafir'}`;
let prefs = structuredClone(DEFAULTS);
function loadPrefs() {
  let p = null;
  try { p = JSON.parse(localStorage.getItem(prefKey()) || 'null'); } catch { /* yoksay */ }
  prefs = { ...structuredClone(DEFAULTS), ...(p || {}) };
  prefs.fixed ||= {};
  // Sade görünüme geçiş (bir kere): elle verilen sabit yükseklikler sıfırlanır, pencereler içeriğe oturur
  if (!prefs.slimV1) { prefs.fixed = {}; prefs.slimV1 = true; try { localStorage.setItem(prefKey(), JSON.stringify(prefs)); } catch { /* yoksay */ } }
  prefs.dpsCols = { ...DEFAULTS.dpsCols, ...(prefs.dpsCols || {}) };
  document.documentElement.style.setProperty('--scale', String(prefs.scale / 100));
}
function savePrefs() {
  try { localStorage.setItem(prefKey(), JSON.stringify(prefs)); } catch { /* yoksay */ }
  document.documentElement.style.setProperty('--scale', String(prefs.scale / 100));
}
// Başka pencerede değişince (ör. menüden yazı boyutu) burada da uygula
window.addEventListener('storage', (e) => { if (e.key === prefKey()) { loadPrefs(); renderAll(true); } });

// ---------------------------------------------------------------- Yardımcılar
const chars = () => st.data?.characters || [];
const activeId = () => ov?.charId || null;
const serverFmt = new Intl.DateTimeFormat('tr-TR', { timeZone: SERVER_TZ, hour: '2-digit', minute: '2-digit' });
const localFmt = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const empty = (t) => `<p class="empty">${esc(t)}</p>`;
const safeImg = (u) => typeof u === 'string' && /^https:\/\//i.test(u);
const gradeCls = (g) => `grade-${String(g || 'common').toLowerCase().replace(/[^a-z]/g, '')}`;
const sel = (name, vals, cur) => `<select data-num="${name}">${vals.map((v) => `<option ${v === cur ? 'selected' : ''}>${v}</option>`).join('')}</select>`;

// ---------------------------------------------------------------- Bileşenler
// render(c): c = { now } → HTML (başlık satırının sağı için `right` döndürmek istersen { html, right }).
const kfmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : nf.format(Math.round(n)));
const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// ---- Hatırlatıcı ----
const remView = { open: new Set(['events', 'abyss', 'watched']), seen: new Set(), lastSig: '' };
const LEADS = [1, 3, 5];
const remDef = (key) => BOSSES.find((b) => b.id === key) || EVENTS.find((e) => e.id === key);
// Sıradaki zaman: sabit programlılar için başlangıç, saha bossları için doğuş (ölüm zamanı biliniyorsa)
function remNext(def, now) {
  if (def.kind === 'schedule') { const n = nextScheduled(def, now); return n ? n.start : null; }
  const s = bossStatus(def, st.data, now);
  return s.state === 'waiting' ? s.at : null;
}
function remItems(now = Date.now()) {
  const out = [];
  for (const [key, leads] of Object.entries(prefs.remind || {})) {
    if (!leads?.length) continue;
    const def = remDef(key); if (!def) continue;
    const at = remNext(def, now); if (!at) continue;
    out.push({ key, title: def.name, sub: def.map ? `${def.map} · ${def.area || ''}` : def.area || '', at, leads });
  }
  return out;
}
// Zamanları uygulamaya yolla (pencere gizliyken de; uygulama bildirimi zamanında gösterir)
async function remSync(force) {
  if (!online) return;
  const items = remItems();
  const sig = JSON.stringify(items);
  if (!force && sig === remView.lastSig) return;
  remView.lastSig = sig;
  try { await appApi.overlay({ action: 'remind', items }); } catch { remView.lastSig = ''; }
}
function remBeep() {
  if (!prefs.remindSound) return;
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.18].forEach((t, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = i ? 1175 : 880; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, ac.currentTime + t); g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + t + 0.16);
      o.connect(g); g.connect(ac.destination); o.start(ac.currentTime + t); o.stop(ac.currentTime + t + 0.18);
    });
    setTimeout(() => ac.close(), 800);
  } catch { /* ses yok */ }
}
function remRow(def, now) {
  const leads = prefs.remind?.[def.id] || [];
  const at = remNext(def, now);
  const when = at ? `${fmtClock(at)} <span class="muted">· ${fmtLeft(at - now)}</span>` : '<span class="muted">zamanı bilinmiyor</span>';
  return `<li class="rm-row ${leads.length ? 'on' : ''}"><span class="rm-n">${esc(def.name)}<small>${when}</small></span>
    <span class="rm-leads">${LEADS.map((l) => `<button type="button" data-rlead="${def.id}|${l}" aria-pressed="${leads.includes(l)}" title="${l} dk kala">${l}</button>`).join('')}</span></li>`;
}
function remSection(id, title, defs, now) {
  if (!defs.length) return '';
  const open = remView.open.has(id);
  const on = defs.filter((d) => prefs.remind?.[d.id]?.length).length;
  return `<div class="rm-sec"><button type="button" class="rm-sh" data-rsec="${id}">${open ? '▾' : '▸'} ${esc(title)} <span class="muted">${on ? `${on} seçili` : ''}</span></button>
    ${open ? `<ul class="l rm-list">${defs.map((d) => remRow(d, now)).join('')}</ul>` : ''}</div>`;
}
function remSetupView() {
  const now = Date.now();
  const watched = st.data?.bosses?.watch?.[st.user] || [];
  const field = BOSSES.filter((b) => b.kind !== 'schedule');
  const byMap = (m) => field.filter((b) => b.map === m && !watched.includes(b.id));
  return `<p class="rm-hint">Bildirim, bu pencerenin durduğu yerde çıkar: başlığından tutup istediğin yere taşı. Her satırda kaç dakika önce haber verileceğini seç (birden fazla seçilebilir).</p>
    ${remSection('events', 'Etkinlikler', EVENTS, now)}
    ${remSection('abyss', 'Abyss', BOSSES.filter((b) => b.kind === 'schedule'), now)}
    ${remSection('watched', 'Takip ettiğin saha bossları', field.filter((b) => watched.includes(b.id)), now)}
    ${remSection('verteron', 'Verteron saha bossları', byMap('Verteron'), now)}
    ${remSection('altgard', 'Altgard saha bossları', byMap('Altgard'), now)}
    <p class="rm-hint">Saha bossları, ölüm zamanı biliniyorsa hatırlatılır (sitede "Öldü" ile ya da oyundan kendiliğinden işaretlenir).</p>
    <div class="row rm-foot">
      <label class="chk"><input type="checkbox" data-bool="remindSound" ${prefs.remindSound ? 'checked' : ''}> Ses</label>
      <button type="button" class="btn" data-rtest>Dene</button>
      <span class="sp"></span>
      <button type="button" class="btn primary" data-rdone>Bitti</button>
    </div>`;
}
function remAlertView(due) {
  const now = Date.now();
  return due.map((d) => {
    const left = d.at - now;
    return `<div class="rm-card ${left <= 60000 ? 'hot' : ''}">
      <span class="rm-ic">🔔</span>
      <span class="rm-txt"><b>${esc(d.title)}</b><small>${esc(d.sub || '')}</small></span>
      <span class="rm-t">${left > 0 ? mmss(left) : 'Şimdi!'}</span>
      <button type="button" class="icon-btn" data-rdis="${esc(d.key)}|${d.at}" title="Kapat">✕</button>
    </div>`;
  }).join('');
}

// ---- Hasar bileşeni yardımcıları ----
const dpsView = { fight: 0, detail: null, tab: 'auto', lastNo: 0 };
// EU sunucuları (parti listesinde kısaltma: Siel → SIE)
const SERVERS = {"1301":"Siel","1302":"Nezekan","1303":"Vaizel","1304":"Kaisinel","1305":"Yustiel","1306":"Ariel","1307":"Fregion","1308":"Meslamtaeda","1309":"Hithanya","1310":"Nania","1311":"Tahabata","1312":"Luteros","1313":"Phernos","1314":"Daminu","1315":"Kasika","1316":"Bakarma","1317":"Tsenka","1318":"Kochi","1319":"Ishtar","1320":"Tiamat","1321":"Poeta","1322":"Verteron","1323":"Nathara","1324":"Talisra","1325":"Zumion","1326":"Nahid","1327":"Asahr","1328":"Caelid","1329":"Laveis","1330":"Perion","1331":"Dramata","1332":"Reda","1333":"Auldor","1334":"Vakron","1335":"Narun","1336":"Gartua","1337":"Chloris","1338":"Ione","1339":"Teina","1340":"Dymones","1341":"Bargott","1342":"Atheron","1343":"Ruthilis","1344":"Siliator","1345":"Idris","1346":"Satia","1347":"Estian","1348":"Rahu","1349":"Rhanman","1350":"Hebran","2301":"Israphel","2302":"Zikel","2303":"Triniel","2304":"Lumiel","2305":"Marchutan","2306":"Azphel","2307":"Ereshkigal","2308":"Beritra","2309":"Nemon","2310":"Hadala","2311":"Ludra","2312":"Ulgorn","2313":"Munin","2314":"Odar","2315":"Zemurru","2316":"Kromede","2317":"Quai","2318":"Baba","2319":"Fafnir","2320":"Indnath","2321":"Ishalgen","2322":"Altgard","2323":"Agnita","2324":"Atiel","2325":"Valdemar","2326":"Lagta","2327":"Gerod","2328":"Urd","2329":"Ecco","2330":"Giselle","2331":"Kashapa","2332":"Stof","2333":"Berk","2334":"Nuakum","2335":"Grisilla","2336":"Santras","2337":"Reuben","2338":"Hugo","2339":"Kraki","2340":"Hystan","2341":"Rathman","2342":"Sigebert","2343":"Nazmun","2344":"Gelcos","2345":"Paton","2346":"Pelleir","2347":"Elvida","2348":"Ketu","2349":"Pydeon","2350":"Notun"};
const srvTag = (id) => (SERVERS[id] ? SERVERS[id].slice(0, 3).toUpperCase() : id ? String(id) : '');
function pingTag() {
  const p = net?.ping;
  if (p == null) return '';
  const cls = p < 80 ? 'good' : p < 150 ? 'mid' : 'bad';
  return `<span class="ping ${cls}" title="Sunucuya gecikme (oyunun kendi ping ölçümünden)"><i></i><i></i><i></i><i></i>${p} ms</span>`;
}
function dhCtl() {
  return '<span class="dh-ctl"><button type="button" class="icon-btn" data-w="set" title="Ayarlar">⚙</button><button type="button" class="icon-btn" data-w="close" title="Ekrandan kaldır">✕</button></span>';
}
// Savaş yokken de başlık: taşınabilir (data-drag), ayarlar ve kapatma düğmeleri görünür
function idleHead(text, extra = '') {
  return { html: `<div class="dh" data-drag><div class="dh-top"><span class="dh-time">${esc(text)}</span><span class="dh-sw">${extra}${dhCtl()}</span></div></div>` + energyFoot() };
}
function viewSwitch(cur) {
  if (!net?.roster) return '';
  const b = (k, label) => `<button type="button" role="radio" data-dpstab="${k}" aria-checked="${cur === k}">${label}</button>`;
  return `<div class="seg dp-modes" role="radiogroup" aria-label="Görünüm">${b('party', 'Parti')}${b('dmg', 'Hasar')}</div>`;
}
// Savaş öncesi: partideki oyuncuların GS / CP'si
function partyView(rs) {
  const ms = rs.members || [];
  const cols = prefs.partyCols;
  const selfName = net?.self?.name || net?.self?.hint;
  const avg = (k) => ms.reduce((a, m) => a + (m[k] || 0), 0) / Math.max(1, ms.length);
  const big = cols === 'gs' ? `<b>${nf.format(Math.round(avg('gs')))}</b> <span>ort. GS</span>` : `<b>${kfmt(avg('cp'))}</b> <span>ort. CP</span>`;
  const topKey = cols === 'gs' ? 'gs' : 'cp';
  const top = Math.max(1, ...ms.map((m) => m[topKey] || 0));
  const head = `<div class="pc-cols ${cols === 'both' ? '' : 'one'}"><span></span><span></span>${cols !== 'cp' ? '<span>GS</span>' : ''}${cols !== 'gs' ? '<span>CP</span>' : ''}<span></span></div>`;
  const rows = ms.map((m) => {
    const col = CLASSES[m.cls]?.[2] || '#6f8fb3';
    const me = m.self || (selfName && m.name === selfName);
    return `
      <div class="dq pm ${me ? 'me' : ''} ${cols === 'both' ? '' : 'one'}" style="--c:${col};--w:${((m[topKey] || 0) / top * 100).toFixed(1)}%">
        <span class="dq-ic">${CLASSES[m.cls]?.[0] || '?'}</span>
        <span class="dq-n">${m.leader ? '<span class="crown" title="Parti lideri">♛</span> ' : ''}${esc(m.name)} <small>${esc(srvTag(m.server))}</small>${m.level && prefs.partyLevel ? ` <small>Lv${m.level}</small>` : ''}</span>
        ${cols !== 'cp' ? `<span class="dq-p">${nf.format(m.gs)}</span>` : ''}
        ${cols !== 'gs' ? `<span class="dq-d">${kfmt(m.cp)}</span>` : ''}
        <span class="pm-st ${m.leader ? 'lead' : m.ready ? 'ok' : 'no'}" title="${m.leader ? 'Parti lideri' : m.ready ? 'Hazır' : 'Hazır değil'}">${m.leader ? 'Lider' : m.ready ? '● Hazır' : '● Hazır değil'}</span>
      </div>`;
  }).join('');
  return `<div class="dh" data-drag>
      <div class="dh-top"><span class="dh-time">Parti · <b class="rdy">${ms.filter((m) => m.ready || m.leader).length}/${ms.length} hazır</b>${rs.name && rs.name !== selfName ? ` · ${esc(rs.name)}` : ''}</span><span class="dh-sw">${viewSwitch('party')}${dhCtl()}</span></div>
      <div class="dh-dps">${big}${cols === 'both' ? `<span class="dh-who">ort. GS ${nf.format(Math.round(avg('gs')))}</span>` : ''}${pingTag()}</div>
      ${head}
    </div>${rows}` + energyFoot();
}

const CLASSES = {
  11: ['GL', 'Gladiator', '#c94a3d'], 12: ['TE', 'Templar (Guardian)', '#3a7de0'], 13: ['AS', 'Assassin', '#7ddc84'],
  14: ['RA', 'Ranger', '#2e9e4c'], 15: ['SO', 'Sorcerer', '#9b5bd8'], 16: ['EL', 'Elementalist', '#32b8c4'],
  17: ['CL', 'Cleric', '#d6bf5a'], 18: ['CH', 'Chanter', '#ee8a2c'], 19: ['FI', 'Fighter', '#d6577f'],
};
const clsBadge = (cls) => (CLASSES[cls] ? `<span class="cls" style="border-color:${CLASSES[cls][2]};color:${CLASSES[cls][2]}" title="${CLASSES[cls][1]}">${CLASSES[cls][0]}</span>` : '');
const clsColor = (cls) => (CLASSES[cls] ? `background:${CLASSES[cls][2]}` : '');
const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);
let skillNames = null;
async function loadSkillNames() {
  if (skillNames) return;
  try { skillNames = await (await fetch('assets/data/skills.json')).json(); } catch { skillNames = {}; }
}
const skillName = (code) => skillNames?.[code] || (code >= 10000000 ? `Yetenek ${code}` : code < 1000 ? 'Temel saldırı' : `#${code}`);
function partySel() {
  const o = (v, l) => `<option value="${v}" ${prefs.partyCols === v ? 'selected' : ''}>${l}</option>`;
  return `<select data-partycols>${o('both', 'GS + CP')}${o('cp', 'sadece CP')}${o('gs', 'sadece GS')}</select>`;
}
function energyFoot() {
  if (!prefs.dpsEnergy) return net?.ping != null ? `<div class="dp-foot">${pingTag()}</div>` : '';
  const e = net?.energy, nm = net?.self?.name || net?.self?.hint;
  if (!e) {
    // Oyundan henüz okunmadı: sitedeki kayda göre (zamanla dolan kısım hesaplanır); oyundan gelince kesin değer
    const ch = chars().find((c) => c.id === activeId());
    if (!ch) return '<div class="dp-foot muted">⚡ enerji henüz okunmadı</div>';
    const es = energyState(effEnergy(ch, {}), energyCfg(st.data, ch), Date.now());
    if (!es.known && !es.bonus) return '<div class="dp-foot muted">⚡ enerji girilmemiş</div>';
    return `<div class="dp-foot" title="Sitedeki kayda göre; oyundan okununca kesin değer gelir"><span class="ef-ic">⚡</span><b>${es.known ? nf.format(es.current) : '?'}</b> <span class="bonus">+${nf.format(es.bonus)}</span> <span class="muted">· ${esc(ch.name)} · site</span>${pingTag()}</div>`;
  }
  return `<div class="dp-foot" title="Odyle enerjisi (oyundaki karakter): doğal + ek"><span class="ef-ic">⚡</span><b>${nf.format(e.natural)}</b> <span class="bonus">+${nf.format(e.bonus)}</span>${nm ? ` <span class="muted">· ${esc(nm)}</span>` : ''}${pingTag()}</div>`;
}
function dpsModes() {
  const m = prefs.dpsMode;
  const b = (k, label) => `<button type="button" role="radio" data-dpsmode="${k}" aria-checked="${m === k}">${label}</button>`;
  return `<div class="seg dp-modes" role="radiogroup" aria-label="Kimler">${b('me', 'Ben')}${b('party', 'Parti')}${b('all', 'Herkes')}</div>`;
}
function dpsDetail(r, f) {
  const dur = f.dur;
  const skills = (r.skills || []).map((s) => `
    <li><span>${esc(skillName(s.code))}</span><span><b>${kfmt(s.dmg)}</b> <span class="muted">%${pct(s.dmg, r.dmg)} · ${s.hits}× · K%${pct(s.crits, s.hits)} · ↑${kfmt(s.max)}</span></span></li>`).join('');
  return `
    <div class="dp-head"><button type="button" class="btn" data-dpsd="">‹ Geri</button>
      <b>${clsBadge(r.cls)}${esc(r.name || `#${r.id}`)}</b>${r.self ? ' <span class="muted">(sen)</span>' : ''}</div>
    <dl class="dp-kv">
      <dt>Hasar</dt><dd><b>${kfmt(r.dmg)}</b> · ${kfmt(r.dmg * 1000 / dur)}/sn · %${pct(r.dmg, f.total)}</dd>
      <dt>Vuruş</dt><dd>${r.hits} · kritik %${pct(r.crits, r.hits)} · en büyük ${kfmt(r.max)}</dd>
      ${r.dot ? `<dt>DoT</dt><dd>${kfmt(r.dot)} (%${pct(r.dot, r.dmg)})</dd>` : ''}
      ${r.taken ? `<dt>Alınan</dt><dd>${kfmt(r.taken)}</dd>` : ''}
      ${r.pets ? `<dt>Pet</dt><dd>${r.pets} çağrı hasarı eklendi</dd>` : ''}
    </dl>
    <h3 class="dp-h">Yetenekler</h3>
    ${skills ? `<ul class="l dp-sk">${skills}</ul>` : empty('Yetenek bilgisi yok.')}`;
}

const WIDGETS = {
  remind: {
    title: 'Hatırlatıcı', hint: 'Boss ve etkinlik bildirimleri',
    render() {
      const r = ov?.overlay?.remind || {};
      const due = r.due || [];
      // Yeni bildirim (ya da yeni aşama) → kısa ses
      const fresh = due.filter((d) => !remView.seen.has(`${d.key}|${d.at}|${d.stage}`));
      if (fresh.length && !r.setup) { fresh.forEach((d) => remView.seen.add(`${d.key}|${d.at}|${d.stage}`)); remBeep(); }
      if (r.setup) return { right: '', html: (due.length ? remAlertView(due) : '') + remSetupView() };
      return { right: '', html: due.length ? remAlertView(due) : empty('Yaklaşan hatırlatma yok.') };
    },
  },
  dps: {

    title: 'Hasar', hint: 'DPS, parti, yetenekler (oyun trafiğinden)',
    render() {
      if (!net) return idleHead('Uygulama yanıt vermiyor.');
      if (net.npcap === false) return idleHead(`Ağ okuma kapalı: ${net.status || ''}`);
      const fights = [net.fight, ...(net.history || [])].filter(Boolean);
      const live = !!(net.fight && net.fight.active);
      if (net.fight && net.fight.no !== dpsView.lastNo) { if (live && dpsView.tab === 'party') dpsView.tab = 'auto'; dpsView.lastNo = net.fight.no; }
      const showParty = net.roster && (dpsView.tab === 'party' || (dpsView.tab === 'auto' && prefs.partyAuto && !live && dpsView.fight === 0 && dpsView.detail == null));
      if (showParty) return { right: '', html: partyView(net.roster) };
      if (!fights.length) {
        const st = net.status === 'dinleniyor' ? (net.self?.name ? `${net.self.name} · savaş bekleniyor` : 'savaş bekleniyor') : (net.status || '');
        return idleHead(st, dpsModes());
      }
      if (dpsView.fight >= fights.length) dpsView.fight = 0;
      const f = fights[dpsView.fight];
      const all = f.rows;
      const mode = prefs.dpsMode;
      let rows = all.filter((r) => (mode === 'me' ? r.self : mode === 'party' ? r.party || r.self : true));
      if (prefs.dpsNamedOnly) rows = rows.filter((r) => r.name || r.self);
      const nav = `<span class="dp-nav">
        <button type="button" data-dpsf="1" ${dpsView.fight >= fights.length - 1 ? 'disabled' : ''} title="Önceki savaş">‹</button>
        <span>${dpsView.fight === 0 && f.active ? '<span class="ok-txt">●</span> canlı' : `#${f.no}`}</span>
        <button type="button" data-dpsf="-1" ${dpsView.fight === 0 ? 'disabled' : ''} title="Sonraki savaş">›</button></span>`;
      const right = `${nav} ${mmss(f.dur)}`;

      // Ayrıntı: bir oyuncunun yetenekleri
      const sel = dpsView.detail != null ? all.find((r) => r.id === dpsView.detail) : null;
      if (sel) return { right, html: dpsDetail(sel, f) };
      dpsView.detail = null;

      const t = f.target || {};
      const hp = t.hp != null && t.hpMax ? Math.max(0, Math.min(1, t.hp / t.hpMax)) : null;
      const tname = t.boss || (t.id ? `Hedef #${t.id}` : '');
      const top = rows[0]?.dmg || 1;
      const c = prefs.dpsCols;
      const sumRows = rows.reduce((x, r) => x + r.dmg, 0);
      const body = rows.slice(0, prefs.dpsRows).map((r) => {
        const col = CLASSES[r.cls]?.[2] || '#6f8fb3';
        const extra = [c.crit ? `K%${pct(r.crits, r.hits)}` : '', c.max ? `↑${kfmt(r.max)}` : '', c.taken && r.taken ? `⬇${kfmt(r.taken)}` : ''].filter(Boolean).join(' ');
        return `
        <button type="button" class="dq ${r.self ? 'me' : ''}" style="--c:${col};--w:${(r.dmg / top * 100).toFixed(1)}%" data-dpsd="${r.id}" title="Yetenekleri gör">
          <span class="dq-ic">${CLASSES[r.cls]?.[0] || '?'}</span>
          <span class="dq-n">${esc(r.name || `#${r.id}`)}${r.pets ? ' <small>+pet</small>' : ''}${extra ? ` <small class="dq-x">${extra}</small>` : ''}</span>
          <span class="dq-d">${kfmt(r.dps)}</span>
          <span class="dq-p">${(r.dmg / f.total * 100).toFixed(1)}%</span>
          ${c.dmg ? `<span class="dq-t">${kfmt(r.dmg)}</span>` : ''}
        </button>`;
      }).join('');
      return {
        right: '',
        html: `<div class="dh" data-drag>
            <div class="dh-top"><span class="dh-time">${right}</span><span class="dh-sw">${viewSwitch('dmg')}${dpsModes()}${dhCtl()}</span></div>
            <div class="dh-dps"><b>${kfmt(sumRows * 1000 / f.dur)}</b> <span>DPS</span><span class="dh-who">${mode === 'all' ? 'herkes' : mode === 'party' ? 'parti' : 'sen'}${mode !== 'all' ? ` · toplam ${kfmt(f.total * 1000 / f.dur)}` : ''}</span></div>
            ${tname ? `<div class="dh-t"><span>${esc(tname)}</span><span>${hp != null ? `%${(hp * 100).toFixed(1)}` : ''}</span>${hp != null ? `<span class="bar hp"><i style="width:${(hp * 100).toFixed(1)}%"></i></span>` : ''}</div>` : ''}
          </div>`
          + (body || empty(mode === 'me' ? 'Bu savaşta hasarın yok (adın henüz gelmemiş olabilir).' : 'Gösterilecek oyuncu yok.'))
          + energyFoot(),
      };
    },
    settings() {
      const c = prefs.dpsCols;
      const chk = (k, label) => `<label class="chk"><input type="checkbox" data-dpscol="${k}" ${c[k] ? 'checked' : ''}> ${label}</label>`;
      return `<h4>Sütunlar</h4><div class="row">${chk('dmg', 'Toplam hasar')}${chk('crit', 'Kritik %')}${chk('max', 'En büyük vuruş')}${chk('taken', 'Alınan hasar')}</div>
        <div class="row"><label>Satır ${sel('dpsRows', [4, 6, 8, 12, 16, 24], prefs.dpsRows)}</label>
        <label>Parti: ${partySel()}</label>
        <label class="chk"><input type="checkbox" data-bool="partyLevel" ${prefs.partyLevel ? 'checked' : ''}> Seviye</label>
        <label class="chk"><input type="checkbox" data-bool="partyAuto" ${prefs.partyAuto ? 'checked' : ''}> Savaş yokken partiyi göster</label>
        <label class="chk"><input type="checkbox" data-bool="dpsEnergy" ${prefs.dpsEnergy ? 'checked' : ''}> Altta enerji</label>
        <label class="chk"><input type="checkbox" data-bool="dpsNamedOnly" ${prefs.dpsNamedOnly ? 'checked' : ''}> Sadece adı bilinenler</label>
        <button type="button" class="btn" data-net="reset">Savaşı bitir</button></div>
        <p class="empty">Veri, oyunun bu bilgisayara gelen trafiğinden okunur (Npcap). Parti: sunucunun sana ve partine gönderdiği kayıtlardan.
        Çağrılan yaratıkların hasarı sahibine eklenir (+pet). Bir savaş 15 sn hasarsız geçince biter; son 6 savaş ‹ › ile gezilir.</p>`;
    },
  },

  energy: {
    title: 'Enerji', hint: 'Karakterlerin enerjisi',
    render({ now }) {
      const near = Number(st.data?.config?.nearFullHours ?? 3);
      const list = chars().filter((ch) => !prefs.energyChars || prefs.energyChars.includes(ch.id));
      if (!list.length) return empty(st.data ? 'Karakter seçilmedi (⚙).' : 'Yükleniyor…');
      return list.map((ch) => {
        const e = energyState(effEnergy(ch, {}), energyCfg(st.data, ch), now);
        const cls = !e.known ? '' : e.isFull ? 'full' : e.msToFull != null && e.msToFull <= near * 3_600_000 ? 'near' : '';
        const full = !e.known ? 'girilmedi' : e.isFull ? 'FULL' : fmtDuration(e.msToFull);
        return `
          <div class="en ${cls} ${ch.id === activeId() ? 'active' : ''}">
            <span class="nm">${esc(ch.name)}</span>
            <span class="tot">${e.known || e.bonus ? nf.format(e.total) : '—'}</span>
            <span class="sub">${e.known ? `${nf.format(e.current)}/${nf.format(e.max)}` : `?/${nf.format(e.max)}`}${e.bonus ? ` <span class="bonus">+${nf.format(e.bonus)}</span>` : ''}</span>
            <span class="sub r">${full}</span>
            <span class="bar"><i style="width:${e.known ? (e.ratio * 100).toFixed(1) : 0}%"></i></span>
          </div>`;
      }).join('');
    },
    settings() {
      return `<h4>Gösterilen karakterler</h4><div class="row">${chars().map((ch) => `<label class="chk"><input type="checkbox" data-ech="${esc(ch.id)}" ${!prefs.energyChars || prefs.energyChars.includes(ch.id) ? 'checked' : ''}> ${esc(ch.name)}</label>`).join('')}</div>`;
    },
  },

  bosses: {
    title: 'Bosslar', hint: 'Takip ettiğin bosslar',
    render({ now }) {
      const watched = st.data?.bosses?.watch?.[st.user] || [];
      const pool = watched.length ? BOSSES.filter((b) => watched.includes(b.id)) : BOSSES.filter((b) => b.kind === 'schedule');
      const rows = pool
        .map((b) => ({ b, s: bossStatus(b, st.data, now) }))
        .filter((x) => x.s.state !== 'unknown')
        .sort((x, y) => (x.s.state === 'waiting') - (y.s.state === 'waiting') || x.s.at - y.s.at)
        .slice(0, prefs.bossCount)
        .map(({ b, s }) => {
          const left = s.at - now;
          const when = s.state === 'active' ? '<span class="ok-txt">aktif</span>'
            : s.state === 'up' ? '<span class="ok-txt">doğdu</span>'
              : `<span class="${left <= prefs.bossLead * 60_000 ? 'soon' : ''}">${fmtLeft(left)}</span> <span class="muted">${fmtClock(s.at)}</span>`;
          return `<li><span>${esc(b.name)}</span><span>${when}</span></li>`;
        }).join('');
      return {
        right: watched.length ? 'takip' : 'Abyss',
        html: rows ? `<ul class="l">${rows}</ul>` : empty(watched.length ? 'Takip ettiğin bossların zamanı bilinmiyor.' : 'Zamanı bilinen boss yok.'),
      };
    },
    settings() {
      return `<div class="row"><label>Gösterilen ${sel('bossCount', [3, 4, 5, 6, 8, 10, 15], prefs.bossCount)}</label>
        <label>Turuncu (dk kala) ${sel('bossLead', [1, 3, 5, 10, 15], prefs.bossLead)}</label></div>
        <p class="empty">Takip listesi sitedeki Bosslar bölümünden (★) seçilir.</p>`;
    },
  },

  gear: {
    title: 'Gear', hint: 'Ekipman ve iLvl',
    render() {
      const list = chars();
      if (!list.length) return empty('Yükleniyor…');
      const id = list.some((c) => c.id === prefs.gearChar) ? prefs.gearChar : (activeId() || list[0].id);
      const ch = list.find((c) => c.id === id) || list[0];
      const g = ch.game || {};
      const items = splitGear(g.gear || []).gear.slice().sort((a, b) => (a.slotPos || 99) - (b.slotPos || 99));
      const chips = `<div class="seg" role="radiogroup">${list.map((c) => `<button type="button" role="radio" data-gearchar="${esc(c.id)}" aria-checked="${c.id === ch.id}">${esc(c.name)}</button>`).join('')}</div>`;
      const sum = `<p class="gsum">${esc(g.class || '')}${g.level ? ` · Lv${esc(g.level)}` : ''} · iLvl <b>${g.itemLevel ? nf.format(g.itemLevel) : '—'}</b>${g.combatPower ? ` · CP <b>${nf.format(g.combatPower)}</b>` : ''}</p>`;
      const rows = items.map((it) => `
        <li title="${esc(it.slot || '')}">
          ${safeImg(it.icon) ? `<img src="${esc(it.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<img alt="">'}
          <span class="gn ${gradeCls(it.grade)}">${esc(it.name || it.slot || '?')}</span>
          <span class="ge">${it.enchant ? `+${esc(it.enchant)}` : ''}${it.exceed ? ` <span class="gx">✦${esc(it.exceed)}</span>` : ''}</span>
        </li>`).join('');
      return chips + sum + (rows ? `<ul class="l gear">${rows}</ul>` : empty(ch.sample ? 'Örnek karakter: gear verisi yok.' : 'Gear verisi yok.'));
    },
  },

  todos: {
    title: 'Yapılacaklar', hint: 'Ortak yapılacaklar listesi',
    render() {
      const open = (st.data?.todos || []).filter((t) => !t.done);
      const rows = open.slice(0, prefs.todoCount).map((t) => `<li><span>• ${esc(t.text)}</span><span class="muted">${esc(t.by || '')}</span></li>`).join('');
      return { right: `${open.length} açık`, html: rows ? `<ul class="l">${rows}</ul>` : empty('Açık madde yok.') };
    },
    settings() { return `<div class="row"><label>Gösterilen ${sel('todoCount', [3, 5, 6, 8, 10, 15], prefs.todoCount)}</label></div>`; },
  },

  dungeons: {
    title: 'Zindanlar', hint: 'Aktif karakterin garanti sayaçları',
    render() {
      const ch = chars().find((c) => c.id === activeId()) || chars()[0];
      if (!ch) return empty('Yükleniyor…');
      const rows = (ch.dungeons || []).filter((d) => d.max > 0).map((d) => {
        const left = d.max - d.count;
        return `<div class="dg ${left <= 3 ? 'close' : ''}"><span>${esc(d.name)}</span><span><b>${esc(d.count)}</b>/${esc(d.max)} <span class="muted">· ${left} kaldı</span></span><span class="bar"><i style="width:${(d.count / d.max * 100).toFixed(1)}%"></i></span></div>`;
      }).join('');
      return { right: esc(ch.name), html: rows || empty('Sayaç yok.') };
    },
  },

  lastbox: {
    title: 'Son kutu', hint: 'Ekrandan son okunan kutu',
    render() {
      const l = ov?.lastRead;
      if (!l) return empty('Henüz kutu okunmadı.');
      const t = l.at ? new Date(l.at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : '';
      return { right: esc(t), html: `<ul class="l">
        <li><span>${esc(l.dungeon)}</span><span>${l.kind === 'trans' ? '<span class="muted">Transcendence</span>' : `<b>${esc(l.seen)}</b>/${esc(l.max)}`}</span></li>
        <li><span class="muted">Kutu · maliyet</span><span>${esc(l.boxes)} · ${esc(l.cost)}</span></li>
        <li><span class="muted">Enerji</span><span>${l.natural != null ? `${esc(l.natural)} <span class="bonus">+${esc(l.bonus)}</span> / ${esc(l.energyMax)}` : '<span class="muted">okunamadı</span>'}</span></li>
      </ul>` };
    },
  },

  clock: {
    title: 'Saat', hint: 'Yerel ve sunucu saati',
    render({ now }) {
      return `<div class="clock"><span><span class="muted">Yerel</span> <b>${localFmt.format(now)}</b></span><span><span class="muted">Sunucu</span> <b>${serverFmt.format(now)}</b></span></div>`;
    },
  },

  status: {
    title: 'Uygulama durumu', hint: 'İzleyici ve aktif karakter',
    render() {
      if (!online) return empty('Uygulama yanıt vermiyor.');
      if (!ov.loggedIn) return empty('Giriş bekleniyor — ana pencerede giriş yap.');
      const name = ov.chars?.find((c) => c.id === ov.charId)?.name || '?';
      return { right: ov.queue ? `<span class="soon">${ov.queue} bekliyor</span>` : '', html: `
        <div class="st-line"><span class="dot ${ov.paused ? 'warn' : 'on'}"></span><b>${ov.paused ? 'Duraklatıldı' : 'İzliyor'}</b><span class="muted">· ${esc(name)}</span></div>
        <div class="seg" role="radiogroup" aria-label="Aktif karakter">
          ${(ov.chars || []).map((c) => `<button type="button" role="radio" data-char="${esc(c.id)}" aria-checked="${c.id === ov.charId}">${esc(c.name)}</button>`).join('')}
        </div>
        <div class="seg"><button type="button" data-act="pause">${ov.paused ? '▶ Devam et' : '❚❚ Duraklat'}</button></div>` };
    },
  },
};
// Masaüstü uygulamasında ekran okuma yok: 'Son kutu' bileşeni sadece eski izleyicide
const ORDER = ['dps', 'remind', 'energy', 'bosses', 'gear', 'todos', 'dungeons', 'lastbox', 'clock', 'status'].filter((id) => !(location.hostname === 'app.karip' && id === 'lastbox'));

// ---------------------------------------------------------------- Pencereyi içeriğe oturt
let fitSent = 0, fitTimer = 0;
function fitWindow() {
  if (!online || prefs.fixed[W]) return;
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    const want = Math.ceil($('#root').getBoundingClientRect().height * dpr());
    if (Math.abs(want - fitSent) <= 2 && Math.abs(window.innerHeight * dpr() - want) <= 4) return;
    fitSent = want;
    appApi.overlay({ action: 'fit', id: W, height: want }).catch(() => { fitSent = 0; });
  }, 120);
}

// Taşıma / boyutlandırma: uygulama imleci izleyip pencereyi taşır (sol tuş bırakılınca biter).
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('.grip')) {
    e.preventDefault();
    prefs.fixed[W] = true; savePrefs(); document.body.classList.add('fixed');
    appApi.overlay({ action: 'drag', id: W, mode: 'size' }).catch(() => {});
    return;
  }
  const h = e.target.closest('[data-drag]');
  if (h && !e.target.closest('button, input, select, a, label')) {
    e.preventDefault();
    appApi.overlay({ action: 'drag', id: W, mode: 'move' }).catch(() => {});
  }
});

// ---------------------------------------------------------------- Menü (hub)
let hubSig = '';
function renderHub(force) {
  const o = ov?.overlay || {};
  const sig = JSON.stringify([online, o.openIds, o.edit, o.hover, o.hoverAny, o.autoHide, o.remindAlways, o.allHidden, Math.round((o.alpha || 0) * 100), prefs.scale, st.err]);
  if (!force && sig === hubSig) return;
  hubSig = sig;
  const open = new Set(o.openIds || []);
  const alpha = Math.round((o.alpha || 0.7) * 100);
  $('#root').innerHTML = `
    <header class="hub-head" data-drag>
      <img src="assets/img/logo.png" alt="" width="26" height="29">
      <b><em>Karip</em> Traker</b><span class="muted">oyun içi menü</span>
      <span class="sp"></span>
      <button type="button" class="icon-btn" data-hub="close" title="Menüyü kapat (Alt+Shift+O)">✕</button>
    </header>
    ${!online ? '<div class="ov-err">Uygulama yanıt vermiyor.</div>' : ''}
    ${st.err ? `<div class="ov-err">${esc(st.err)}</div>` : ''}
    <div class="tiles">
      ${ORDER.map((id) => `
        <button type="button" class="tile" data-tile="${id}" aria-pressed="${open.has(id)}" title="${open.has(id) ? 'Kapat' : 'Ekrana ekle'}">
          ${ICON[id]}<span>${esc(WIDGETS[id].title)}</span><small>${esc(WIDGETS[id].hint)}</small>
        </button>`).join('')}
    </div>
    <section class="hub-sec">
      <h3>Görünüm</h3>
      <div class="range"><span>Oyun modunda görünürlük</span><input type="range" min="20" max="100" step="5" data-alpha value="${alpha}"><output>%${alpha}</output></div>
      <div class="range"><span>Yazı boyutu</span><input type="range" min="80" max="150" step="5" data-scale value="${prefs.scale}"><output>%${prefs.scale}</output></div>
      <label class="chk"><input type="checkbox" data-opt="hover" ${o.hover ? 'checked' : ''}> İmleç bileşenin üstüne gelince kullanım moduna geç</label>
      <label class="chk"><input type="checkbox" data-opt="hoverAny" ${o.hoverAny ? 'checked' : ''}> Oyun imleci algılanmazsa da çalışsın <span class="muted">(imleç gizliyken de)</span></label>
      <label class="chk"><input type="checkbox" data-opt="autoHide" ${o.autoHide !== false ? 'checked' : ''}> Oyun ön planda değilken gizle <span class="muted">(masaüstü, tarayıcı, Discord…)</span></label>
      <label class="chk"><input type="checkbox" data-opt="remindAlways" ${o.remindAlways ? 'checked' : ''}> Hatırlatıcı bildirimleri oyun arkadayken de görünsün</label>
      <div class="row">
        <button type="button" class="btn ${o.edit ? 'on' : ''}" data-hub="edit" title="Bütün bileşenler tam görünür ve tıklanabilir olur (Alt+Shift+T)">${o.edit ? '✓ Düzenleme modu açık' : 'Düzenleme modu'}</button>
        <button type="button" class="btn" data-hub="hideAll" title="Alt+Shift+H">Hepsini gizle</button>
        <button type="button" class="btn" data-hub="reset">Konumları sıfırla</button>
      </div>
    </section>
    <div class="keys">
      <span><kbd>Alt+Shift+O</kbd> menü</span><span><kbd>Alt+Shift+H</kbd> hepsini gizle/göster</span><span><kbd>Alt+Shift+T</kbd> düzenleme modu</span>
      <span>Bileşeni başlığından taşı, sağ alt köşesinden boyutlandır.</span>
    </div>
    <span class="grip" title="Boyutlandır"></span>`;
  fitWindow();
}

function hubEvents() {
  const root = $('#root');
  root.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tile]');
    const h = e.target.closest('[data-hub]');
    try {
      if (t) {
        const id = t.dataset.tile, on = id === 'remind' ? true : t.getAttribute('aria-pressed') !== 'true';
        t.setAttribute('aria-pressed', String(on));
        await appApi.overlay({ action: 'widget', id, title: WIDGETS[id].title, on });
      } else if (h) {
        const a = h.dataset.hub;
        if (a === 'close') await appApi.overlay({ action: 'hideHub' });
        else if (a === 'reset') { if (confirm('Bütün bileşenler varsayılan yerlerine dönsün mü?')) await appApi.overlay({ action: 'reset' }); }
        else await appApi.overlay({ action: a });
      } else return;
      st.err = '';
    } catch (err) { st.err = err.message; }
    await poll(); renderHub(true);
  });
  root.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.scale !== undefined) { prefs.scale = Number(t.value); t.nextElementSibling.textContent = `%${t.value}`; savePrefs(); fitWindow(); }
    if (t.dataset.alpha !== undefined) t.nextElementSibling.textContent = `%${t.value}`;
  });
  root.addEventListener('change', async (e) => {
    const t = e.target;
    try {
      if (t.dataset.alpha !== undefined) await appApi.overlay({ action: 'alpha', alpha: Number(t.value) / 100 });
      else if (t.dataset.opt) await appApi.overlay({ action: t.dataset.opt, on: t.checked });
      else return;
    } catch (err) { st.err = err.message; }
    await poll(); renderHub(true);
  });
}

// ---------------------------------------------------------------- Bileşen penceresi
const def = WIDGETS[W];
let setOpen = false;
function widgetShell() {
  $('#root').innerHTML = `
    <div class="wtop">
      <h2 class="w-head">${ICON[W] || ''}<span>${esc(def.title)}</span><span class="r" id="w-right"></span></h2>
      <div class="wbar" data-drag title="Taşımak için sürükle">
        <span class="t">${ICON[W] || ''}${esc(def.title)}</span>
        <button type="button" class="icon-btn" data-w="set" title="Ayarlar">⚙</button>
        <button type="button" class="icon-btn" data-w="close" title="Ekrandan kaldır">✕</button>
      </div>
    </div>
    <div class="wset" id="wset" hidden></div>
    <div class="wbody" id="wbody"></div>
    <span class="grip" title="Boyutlandır"></span>`;
  document.body.classList.toggle('fixed', !!prefs.fixed[W]);
}
function renderSettings() {
  $('#wset').innerHTML = (def.settings ? def.settings() : '') + `
    <label class="chk"><input type="checkbox" data-auto ${prefs.fixed[W] ? '' : 'checked'}> Yükseklik içeriğe otursun</label>`;
}
let lastBody = '';
function renderWidget() {
  let out;
  try { out = def.render({ now: Date.now() }); } catch (e) { out = empty(`Hata: ${e.message}`); }
  if (typeof out === 'string') out = { html: out };
  const html = (st.err ? `<div class="ov-err">${esc(st.err)}</div>` : '') + out.html;
  if (html !== lastBody) { $('#wbody').innerHTML = html; lastBody = html; }
  $('#w-right').innerHTML = out.right || '';
  const o = ov?.overlay || {};
  const active = !!o.wins?.[W]?.active;
  document.body.classList.toggle('edit', !!o.edit);
  document.body.classList.toggle('active', active);
  document.body.classList.toggle('ghost', !active && !o.edit);
  fitWindow();
}
function widgetEvents() {
  const root = $('#root');
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-w], [data-char], [data-act], [data-gearchar], [data-net], [data-dpsmode], [data-dpsf], [data-dpsd], [data-dpstab], [data-rlead], [data-rsec], [data-rtest], [data-rdone], [data-rdis]');
    if (!b) return;
    try {
      if (b.dataset.w === 'set') { setOpen = !setOpen; if (setOpen) renderSettings(); $('#wset').hidden = !setOpen; fitWindow(); return; }
      if (b.dataset.w === 'close') { await appApi.overlay({ action: 'widget', id: W, title: def.title, on: false }); return; }
      if (b.dataset.rlead) {
        const [key, l] = b.dataset.rlead.split('|'); const n = Number(l);
        const cur = new Set(prefs.remind[key] || []); if (cur.has(n)) cur.delete(n); else cur.add(n);
        if (cur.size) prefs.remind[key] = [...cur].sort((x, y) => x - y); else delete prefs.remind[key];
        savePrefs(); renderWidget(); remSync(true); return;
      }
      if (b.dataset.rsec) { if (remView.open.has(b.dataset.rsec)) remView.open.delete(b.dataset.rsec); else remView.open.add(b.dataset.rsec); renderWidget(); return; }
      if (b.dataset.rtest !== undefined) { await appApi.overlay({ action: 'remindTest' }); await poll(); renderWidget(); return; }
      if (b.dataset.rdone !== undefined) { await appApi.overlay({ action: 'widget', id: 'remind', title: def.title, on: false }); return; }
      if (b.dataset.rdis) { const [key, at] = b.dataset.rdis.split('|'); await appApi.overlay({ action: 'remindDismiss', key, at: Number(at) }); await poll(); renderWidget(); return; }
      if (b.dataset.dpstab) { dpsView.tab = b.dataset.dpstab; dpsView.detail = null; if (b.dataset.dpstab === 'dmg') dpsView.fight = 0; renderWidget(); return; }
      if (b.dataset.dpsmode) { prefs.dpsMode = b.dataset.dpsmode; savePrefs(); renderWidget(); return; }
      if (b.dataset.dpsf) { dpsView.fight = Math.max(0, dpsView.fight + Number(b.dataset.dpsf)); dpsView.detail = null; renderWidget(); return; }
      if (b.dataset.dpsd !== undefined) { dpsView.detail = b.dataset.dpsd ? Number(b.dataset.dpsd) : null; renderWidget(); return; }
      if (b.dataset.net === 'reset') { await fetch('/api/net', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reset' }) }); await pollNet(); renderWidget(); return; }
      if (b.dataset.gearchar) { prefs.gearChar = b.dataset.gearchar; savePrefs(); renderWidget(); return; }
      if (b.dataset.char) await appApi.char(b.dataset.char);
      else if (b.dataset.act === 'pause') await appApi.pause(!ov?.paused);
      st.err = '';
    } catch (err) { st.err = err.message; }
    await poll(); renderWidget();
  });
  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.ech) {
      const all = chars().map((c) => c.id);
      const cur = new Set(prefs.energyChars || all);
      if (t.checked) cur.add(t.dataset.ech); else cur.delete(t.dataset.ech);
      prefs.energyChars = all.every((id) => cur.has(id)) ? null : all.filter((id) => cur.has(id));
    } else if (t.dataset.num) prefs[t.dataset.num] = Number(t.value);
    else if (t.dataset.bool) prefs[t.dataset.bool] = t.checked;
    else if (t.dataset.dpscol) prefs.dpsCols[t.dataset.dpscol] = t.checked;
    else if (t.dataset.partycols !== undefined) prefs.partyCols = t.value;
    else if (t.dataset.auto !== undefined) {
      if (t.checked) delete prefs.fixed[W]; else prefs.fixed[W] = true;
      document.body.classList.toggle('fixed', !!prefs.fixed[W]);
      fitSent = 0;
    } else return;
    savePrefs(); renderWidget();
    if (W === 'remind') remSync(true);
  });
}

// ---------------------------------------------------------------- Veri
async function pollNet() {
  try { const r = await fetch('/api/net', { cache: 'no-store' }); net = r.ok ? await r.json() : null; } catch { net = null; }
}
async function poll() {
  if (W === 'dps') await pollNet();
  try {
    const r = await fetch('/api/ov', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    ov = await r.json(); online = true;
  } catch { online = false; }
  const u = ov?.user || getSession()?.user || null;
  if (u !== st.user) { st.user = u; loadPrefs(); renderAll(true); }
}

async function ensureSession() {
  if (getSession()?.token) return getSession();
  try {
    const s = await appApi.getSession();
    if (s?.token) { setSession(s, true); return s; }
  } catch { /* oturum yok */ }
  return null;
}
async function loadData() {
  if (W === 'hub' || W === 'clock' || W === 'lastbox' || W === 'status') return; // bunlar repo verisine ihtiyaç duymaz
  try {
    if (await ensureSession()) {
      const f = await gh.getFileIfChanged(st.etag);
      if (!f) return; // değişmedi (GitHub 304 → istek limitinden düşmez)
      st.data = JSON.parse(f.text); st.etag = f.etag;
    } else {
      const r = await fetch(`data/data.json?t=${Date.now()}`, { cache: 'no-store' });
      st.data = await r.json();
    }
    st.err = '';
  } catch (e) {
    st.err = `Veri alınamadı: ${e.message}`;
  }
  renderAll(true);
}

function renderAll(force) {
  if (W === 'hub') renderHub(force);
  else if (def) { renderWidget(); if (force && setOpen) renderSettings(); }
}

// ---------------------------------------------------------------- Başlat
(async () => {
  if (!LOCAL) {
    $('#root').innerHTML = '<p class="ov-err">Oyun içi arayüz yalnızca masaüstü uygulamasından açılır (Alt+Shift+O).</p>';
    return;
  }
  if (W !== 'hub' && !def) { $('#root').innerHTML = '<p class="ov-err">Bilinmeyen bileşen.</p>'; return; }
  document.body.dataset.w = W;
  st.user = getSession()?.user || null;
  loadPrefs();
  if (W === 'hub') hubEvents(); else { widgetShell(); widgetEvents(); }
  if (W === 'dps') await loadSkillNames();
  if (W === 'remind') { setInterval(() => remSync(false), 30_000); setTimeout(() => remSync(true), 1500); }
  await poll();
  renderAll(true);
  await loadData();
  setInterval(async () => { await poll(); renderAll(false); fitWindow(); }, W === 'hub' ? 1000 : W === 'dps' ? 500 : 700);   // durum + geri sayımlar (+ pencere boyu doğru mu)
  setInterval(() => { if (!document.hidden) loadData(); }, 20_000);
})();
