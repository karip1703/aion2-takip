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
import { BOSSES, bossStatus, fmtLeft, fmtClock, SERVER_TZ } from './bosses.js';
import { LOCAL, appApi } from './izleyici.js';

const W = new URLSearchParams(location.search).get('w') || 'hub';
const $ = (s, el = document) => el.querySelector(s);
const nf = new Intl.NumberFormat('tr-TR');
const dpr = () => window.devicePixelRatio || 1;

// ---------------------------------------------------------------- İkonlar
const svg = (d) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICON = {
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

// ---------------------------------------------------------------- Tercihler (kullanıcıya özel, tüm pencereler paylaşır)
const DEFAULTS = {
  scale: 100,         // yazı boyutu (%)
  energyChars: null,  // null = hepsi
  bossCount: 5,
  bossLead: 5,        // bu kadar dakika kala turuncu
  todoCount: 6,
  gearChar: null,     // null = aktif karakter
  fixed: {},          // { bileşen: true } → yükseklik elle ayarlandı (içeriğe oturtma kapalı)
};
const prefKey = () => `kt.overlay.v2.${st.user || 'misafir'}`;
let prefs = structuredClone(DEFAULTS);
function loadPrefs() {
  let p = null;
  try { p = JSON.parse(localStorage.getItem(prefKey()) || 'null'); } catch { /* yoksay */ }
  prefs = { ...structuredClone(DEFAULTS), ...(p || {}) };
  prefs.fixed ||= {};
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
const WIDGETS = {
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
        <li><span>${esc(l.dungeon)}</span><span><b>${esc(l.seen)}</b>/${esc(l.max)}</span></li>
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
const ORDER = ['energy', 'bosses', 'gear', 'todos', 'dungeons', 'lastbox', 'clock', 'status'];

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
  const sig = JSON.stringify([online, o.openIds, o.edit, o.hover, o.hoverAny, o.allHidden, Math.round((o.alpha || 0) * 100), prefs.scale, st.err]);
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
        const id = t.dataset.tile, on = t.getAttribute('aria-pressed') !== 'true';
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
function renderWidget() {
  let out;
  try { out = def.render({ now: Date.now() }); } catch (e) { out = empty(`Hata: ${e.message}`); }
  if (typeof out === 'string') out = { html: out };
  $('#wbody').innerHTML = (st.err ? `<div class="ov-err">${esc(st.err)}</div>` : '') + out.html;
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
    const b = e.target.closest('[data-w], [data-char], [data-act], [data-gearchar]');
    if (!b) return;
    try {
      if (b.dataset.w === 'set') { setOpen = !setOpen; if (setOpen) renderSettings(); $('#wset').hidden = !setOpen; fitWindow(); return; }
      if (b.dataset.w === 'close') { await appApi.overlay({ action: 'widget', id: W, title: def.title, on: false }); return; }
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
    else if (t.dataset.auto !== undefined) {
      if (t.checked) delete prefs.fixed[W]; else prefs.fixed[W] = true;
      document.body.classList.toggle('fixed', !!prefs.fixed[W]);
      fitSent = 0;
    } else return;
    savePrefs(); renderWidget();
  });
}

// ---------------------------------------------------------------- Veri
async function poll() {
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
  st.user = getSession()?.user || null;
  loadPrefs();
  if (W === 'hub') hubEvents(); else { widgetShell(); widgetEvents(); }
  await poll();
  renderAll(true);
  await loadData();
  setInterval(async () => { await poll(); renderAll(false); fitWindow(); }, W === 'hub' ? 1000 : 700);   // durum + geri sayımlar (+ pencere boyu doğru mu)
  setInterval(() => { if (!document.hidden) loadData(); }, 20_000);
})();
