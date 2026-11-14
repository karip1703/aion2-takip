// Karip Traker — oyun içi panel (overlay).
//
// Masaüstü uygulaması bu sayfayı her zaman üstte duran küçük bir pencerede açar (Alt+Shift+O).
//   Oyun modu      : pencere yarı saydam ve tıklamalar içinden geçer (oyunu engellemez).
//   Düzenleme modu : tam görünür, tıklanabilir; bileşenler ve ayarlar burada değiştirilir.
//   Alt+Shift+T iki mod arasında geçirir. Pencerenin saydamlığını ve tıklama geçirgenliğini uygulama ayarlar.
//
// Yeni özellik eklemek: aşağıdaki WIDGETS listesine bir bileşen ekle ({ title, render(c) }).
// Kullanıcı tercihleri (hangi bileşenler, sıra, saydamlık, yazı boyutu…) kullanıcıya özel saklanır.

import { getSession, setSession } from './auth.js';
import * as gh from './github.js';
import { esc, effEnergy } from './render.js';
import { energyState, energyCfg, fmtDuration } from './energy.js';
import { BOSSES, bossStatus, fmtLeft, fmtClock, SERVER_TZ } from './bosses.js';
import { LOCAL, bridge, refreshBridge, appApi } from './izleyici.js';

const $ = (s) => document.querySelector(s);
const nf = new Intl.NumberFormat('tr-TR');

// ---------------------------------------------------------------- Durum
const st = { data: null, etag: null, user: null, err: '', settingsOpen: false };

// ---------------------------------------------------------------- Tercihler (kullanıcıya özel)
const DEFAULTS = {
  order: ['status', 'energy', 'bosses', 'dungeons', 'lastbox', 'todos', 'clock'],
  on: { status: true, energy: true, bosses: true, dungeons: true, lastbox: false, todos: false, clock: false },
  alpha: 70,          // oyun modunda pencere görünürlüğü (%)
  scale: 100,         // yazı boyutu (%)
  energyChars: null,  // null = hepsi
  bossCount: 5,
  bossLead: 5,        // bu kadar dakika kala turuncu
  todoCount: 5,
  autoHeight: true,   // pencere yüksekliği içeriğe otursun
};
const prefKey = () => `kt.overlay.v1.${st.user || 'misafir'}`;
let prefs = { ...DEFAULTS };
function loadPrefs() {
  let p = null;
  try { p = JSON.parse(localStorage.getItem(prefKey()) || 'null'); } catch { /* yoksay */ }
  prefs = { ...DEFAULTS, ...(p || {}), on: { ...DEFAULTS.on, ...(p?.on || {}) } };
  // Sonradan eklenen bileşenler sıranın sonuna girer; kaldırılanlar düşer.
  prefs.order = [...prefs.order.filter((id) => WIDGETS[id]), ...Object.keys(WIDGETS).filter((id) => !prefs.order.includes(id))];
  applyPrefs();
}
function savePrefs() {
  try { localStorage.setItem(prefKey(), JSON.stringify(prefs)); } catch { /* yoksay */ }
  applyPrefs();
}
let sentAlpha = null;
function applyPrefs() {
  document.documentElement.style.setProperty('--scale', String(prefs.scale / 100));
  if (bridge.online && sentAlpha !== prefs.alpha) {
    sentAlpha = prefs.alpha;
    appApi.overlay({ action: 'alpha', alpha: prefs.alpha / 100 }).catch(() => { sentAlpha = null; });
  }
}

// ---------------------------------------------------------------- Yardımcılar
const chars = () => st.data?.characters || [];
const activeId = () => bridge.s?.charId || null;
const serverFmt = new Intl.DateTimeFormat('tr-TR', { timeZone: SERVER_TZ, hour: '2-digit', minute: '2-digit' });
const localFmt = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const head = (title, right = '') => `<h2 class="w-head">${esc(title)}${right ? `<span class="r">${right}</span>` : ''}</h2>`;
const empty = (t) => `<p class="empty">${esc(t)}</p>`;

// ---------------------------------------------------------------- Bileşenler
// render(c): c = { now, edit } → HTML. Boş string dönerse bileşen gizlenir.
const WIDGETS = {
  status: {
    title: 'Uygulama durumu',
    render({ edit }) {
      const s = bridge.s;
      if (!bridge.online) return head('Uygulama') + empty('Uygulama yanıt vermiyor.');
      if (!s.loggedIn) return head('Uygulama') + empty('Giriş bekleniyor — ana pencerede giriş yap.');
      const name = s.chars?.find((c) => c.id === s.charId)?.name || '?';
      const cls = s.paused ? 'warn' : 'on';
      return head('Uygulama', s.queue ? `<span class="soon">${s.queue} bekliyor</span>` : '') + `
        <div class="st-line"><span class="dot ${cls}"></span><b>${s.paused ? 'Duraklatıldı' : 'İzliyor'}</b><span class="muted">· ${esc(name)}</span></div>
        ${edit ? `
        <div class="seg" role="radiogroup" aria-label="Aktif karakter">
          ${(s.chars || []).map((c) => `<button type="button" role="radio" data-char="${esc(c.id)}" aria-checked="${c.id === s.charId}">${esc(c.name)}</button>`).join('')}
        </div>
        <div class="seg"><button type="button" data-act="pause">${s.paused ? '▶ Devam et' : '❚❚ Duraklat'}</button></div>` : ''}`;
    },
  },

  energy: {
    title: 'Enerji',
    render({ now }) {
      const near = Number(st.data?.config?.nearFullHours ?? 3);
      const list = chars().filter((ch) => !prefs.energyChars || prefs.energyChars.includes(ch.id));
      if (!list.length) return head('Enerji') + empty('Karakter seçilmedi.');
      const rows = list.map((ch) => {
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
      return head('Enerji') + rows;
    },
  },

  bosses: {
    title: 'Bosslar',
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
      return head(watched.length ? 'Takip ettiğin bosslar' : 'Abyss programı') + (rows ? `<ul>${rows}</ul>` : empty('Zamanı bilinen boss yok.'));
    },
  },

  dungeons: {
    title: 'Zindan sayaçları (aktif karakter)',
    render() {
      const ch = chars().find((c) => c.id === activeId()) || chars()[0];
      if (!ch) return head('Zindanlar') + empty('Karakter yok.');
      const ds = (ch.dungeons || []).filter((d) => d.max > 0);
      const rows = ds.map((d) => {
        const left = d.max - d.count;
        return `<div class="dg ${left <= 3 ? 'close' : ''}"><span>${esc(d.name)}</span><span><b>${esc(d.count)}</b>/${esc(d.max)} <span class="muted">· ${left} kaldı</span></span><span class="bar"><i style="width:${(d.count / d.max * 100).toFixed(1)}%"></i></span></div>`;
      }).join('');
      return head(`Zindanlar · ${ch.name}`) + (rows || empty('Sayaç yok.'));
    },
  },

  lastbox: {
    title: 'Son okunan kutu',
    render() {
      const l = bridge.s?.lastRead;
      if (!l) return head('Son kutu') + empty('Henüz kutu okunmadı.');
      const t = l.at ? new Date(l.at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : '';
      return head('Son kutu', esc(t)) + `<ul>
        <li><span>${esc(l.dungeon)}</span><span><b>${esc(l.seen)}</b>/${esc(l.max)}</span></li>
        <li><span class="muted">Enerji</span><span>${l.natural != null ? `${esc(l.natural)} <span class="bonus">+${esc(l.bonus)}</span> / ${esc(l.energyMax)}` : '<span class="muted">okunamadı</span>'}</span></li>
      </ul>`;
    },
  },

  todos: {
    title: 'Yapılacaklar',
    render() {
      const open = (st.data?.todos || []).filter((t) => !t.done);
      const rows = open.slice(0, prefs.todoCount).map((t) => `<li><span>• ${esc(t.text)}</span><span class="muted">${esc(t.by || '')}</span></li>`).join('');
      return head('Yapılacaklar', `${open.length} açık`) + (rows ? `<ul>${rows}</ul>` : empty('Açık madde yok.'));
    },
  },

  clock: {
    title: 'Saat',
    render({ now }) {
      return head('Saat') + `<div class="clock"><span><span class="muted">Yerel</span> <b>${localFmt.format(now)}</b></span><span><span class="muted">Sunucu</span> <b>${serverFmt.format(now)}</b></span></div>`;
    },
  },
};

// ---------------------------------------------------------------- Çizim
const isGhost = () => !!bridge.s?.overlay?.ghost;

function renderWidgets() {
  const now = Date.now();
  const c = { now, edit: !isGhost() };
  document.body.classList.toggle('ghost', isGhost());
  const html = prefs.order.filter((id) => prefs.on[id] && WIDGETS[id]).map((id) => {
    let inner = '';
    try { inner = WIDGETS[id].render(c); } catch (e) { inner = head(WIDGETS[id].title) + empty(`Hata: ${e.message}`); }
    return inner ? `<section class="w" data-w="${id}">${inner}</section>` : '';
  }).join('');
  $('#ov-widgets').innerHTML = (st.err ? `<div class="ov-err">${esc(st.err)}</div>` : '')
    + (html || '<section class="w"><p class="empty">Hiç bileşen açık değil. ⚙ ile seç.</p></section>');
  $('#ov-mode').textContent = isGhost() ? '' : 'düzenleme modu';
  $('#ov-hint').textContent = isGhost() ? 'Alt+Shift+T: düzenle · Alt+Shift+O: gizle' : 'Başlıktan taşı, kenardan boyutlandır · Alt+Shift+T: oyun modu';
  $('#ov-settings').classList.toggle('on', st.settingsOpen);
  $('#ov-panel').hidden = !st.settingsOpen || isGhost();
  fitWindow();
}

// Pencereyi içeriğin yüksekliğine oturt (oyun modunda boş alan oyunu kapatmasın).
let fitSent = 0, fitTimer = 0;
function fitWindow() {
  if (!prefs.autoHeight || !bridge.online) return;
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    const chrome = Math.max(0, window.outerHeight - window.innerHeight);
    const want = Math.ceil((document.body.scrollHeight + chrome) * devicePixelRatio);
    if (Math.abs(want - fitSent) <= 3 && Math.abs(window.outerHeight * devicePixelRatio - want) <= 6) return;
    fitSent = want;
    appApi.overlay({ action: 'fit', height: want }).catch(() => { fitSent = 0; });
  }, 150);
}

function renderSettings() {
  const ids = prefs.order;
  const list = ids.map((id, i) => `
    <li>
      <label><input type="checkbox" data-on="${id}" ${prefs.on[id] ? 'checked' : ''}> ${esc(WIDGETS[id].title)}</label>
      <button type="button" class="mv" data-mv="${id}" data-d="-1" ${i === 0 ? 'disabled' : ''} title="Yukarı">↑</button>
      <button type="button" class="mv" data-mv="${id}" data-d="1" ${i === ids.length - 1 ? 'disabled' : ''} title="Aşağı">↓</button>
    </li>`).join('');
  const chs = chars().map((ch) => `<label><input type="checkbox" data-ech="${esc(ch.id)}" ${!prefs.energyChars || prefs.energyChars.includes(ch.id) ? 'checked' : ''}> ${esc(ch.name)}</label>`).join('');
  const opt = (name, vals, cur) => `<select data-num="${name}">${vals.map((v) => `<option ${v === cur ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
  $('#ov-panel').innerHTML = `
    <h3>Bileşenler</h3>
    <ul class="ov-list">${list}</ul>
    <h3>Görünüm</h3>
    <div class="ov-row"><span>Oyun modunda görünürlük</span><input type="range" min="20" max="100" step="5" data-range="alpha" value="${prefs.alpha}"><output>%${prefs.alpha}</output></div>
    <label><input type="checkbox" data-bool="autoHeight" ${prefs.autoHeight ? 'checked' : ''}> Pencere yüksekliği içeriğe otursun</label>
    <div class="ov-row"><span>Yazı boyutu</span><input type="range" min="80" max="150" step="5" data-range="scale" value="${prefs.scale}"><output>%${prefs.scale}</output></div>
    <h3>Enerji: gösterilen karakterler</h3>
    <div class="ov-chips">${chs || '<span class="muted">Veri yükleniyor…</span>'}</div>
    <h3>Diğer</h3>
    <div class="ov-chips">
      <label>Boss sayısı ${opt('bossCount', [3, 4, 5, 6, 8, 10], prefs.bossCount)}</label>
      <label>Turuncu (dk kala) ${opt('bossLead', [1, 3, 5, 10, 15], prefs.bossLead)}</label>
      <label>Yapılacak sayısı ${opt('todoCount', [3, 5, 8, 10], prefs.todoCount)}</label>
    </div>
    <div class="ov-chips"><button type="button" class="ov-btn" data-reset>Varsayılana dön</button></div>`;
}

// ---------------------------------------------------------------- Olaylar
$('#ov-settings').addEventListener('click', () => {
  st.settingsOpen = !st.settingsOpen;
  if (st.settingsOpen) renderSettings();
  renderWidgets();
});
$('#ov-ghost').addEventListener('click', () => appApi.overlay({ action: 'ghost' }).then(tickApp).catch((e) => { st.err = e.message; renderWidgets(); }));

$('#ov-panel').addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.on) prefs.on[t.dataset.on] = t.checked;
  else if (t.dataset.ech) {
    const all = chars().map((c) => c.id);
    const cur = new Set(prefs.energyChars || all);
    if (t.checked) cur.add(t.dataset.ech); else cur.delete(t.dataset.ech);
    prefs.energyChars = all.every((id) => cur.has(id)) ? null : all.filter((id) => cur.has(id));
  } else if (t.dataset.num) prefs[t.dataset.num] = Number(t.value);
  else if (t.dataset.bool) prefs[t.dataset.bool] = t.checked;
  else return;
  savePrefs(); renderWidgets();
});
$('#ov-panel').addEventListener('input', (e) => {
  const t = e.target;
  if (!t.dataset.range) return;
  prefs[t.dataset.range] = Number(t.value);
  t.nextElementSibling.textContent = `%${t.value}`;
  savePrefs(); renderWidgets();
});
$('#ov-panel').addEventListener('click', (e) => {
  const mv = e.target.closest('[data-mv]');
  if (mv) {
    const i = prefs.order.indexOf(mv.dataset.mv), j = i + Number(mv.dataset.d);
    if (j < 0 || j >= prefs.order.length) return;
    [prefs.order[i], prefs.order[j]] = [prefs.order[j], prefs.order[i]];
    savePrefs(); renderSettings(); renderWidgets();
    return;
  }
  if (e.target.closest('[data-reset]') && confirm('Oyun içi panel ayarları varsayılana dönsün mü?')) {
    prefs = structuredClone(DEFAULTS);
    savePrefs(); renderSettings(); renderWidgets();
  }
});
$('#ov-widgets').addEventListener('click', async (e) => {
  if (isGhost()) return;
  const b = e.target.closest('[data-char], [data-act]');
  if (!b) return;
  try {
    if (b.dataset.char) await appApi.char(b.dataset.char);
    else if (b.dataset.act === 'pause') await appApi.pause(!bridge.s?.paused);
  } catch (err) { st.err = err.message; }
  await tickApp();
});

// ---------------------------------------------------------------- Veri
async function ensureSession() {
  if (getSession()?.token) return getSession();
  try {
    const s = await appApi.getSession();
    if (s?.token) { setSession(s, true); return s; }
  } catch { /* oturum yok */ }
  return null;
}

async function loadData() {
  try {
    const s = await ensureSession();
    if (s) {
      const f = await gh.getFileIfChanged(st.etag);
      if (!f) return; // değişmedi
      st.data = JSON.parse(f.text); st.etag = f.etag;
    } else {
      const r = await fetch(`data/data.json?t=${Date.now()}`, { cache: 'no-store' });
      st.data = await r.json();
    }
    st.err = '';
    if (st.settingsOpen) renderSettings();
  } catch (e) {
    st.err = `Veri alınamadı: ${e.message}`;
  }
  renderWidgets();
}

let lastUser;
async function tickApp() {
  await refreshBridge();
  const u = bridge.s?.user || getSession()?.user || null;
  if (u !== lastUser) { lastUser = u; st.user = u; loadPrefs(); sentAlpha = null; applyPrefs(); if (st.settingsOpen) renderSettings(); }
  else applyPrefs();
  renderWidgets();
}

// ---------------------------------------------------------------- Başlat
(async () => {
  if (!LOCAL) {
    document.body.innerHTML = '<p class="ov-err">Oyun içi panel yalnızca masaüstü uygulamasından açılır (saat yanındaki simge → Oyun içi panel, ya da Alt+Shift+O).</p>';
    return;
  }
  st.user = getSession()?.user || null;
  loadPrefs();
  await tickApp();
  await loadData();
  setInterval(tickApp, 1000);                                   // uygulama durumu + geri sayımlar
  setInterval(() => { if (!document.hidden) loadData(); }, 20_000); // veri (değişmediyse GitHub 304 döner, limitten düşmez)
})();
