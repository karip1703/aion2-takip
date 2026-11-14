// Masaüstü uygulaması (ekran izleyici) ile köprü.
//
// Uygulama (tools/izleyici/Baslat.bat) siteyi bu bilgisayarda http://127.0.0.1:47321 adresinden sunar ve
// kendi penceresinde açar. Site bu adresten açıldıysa izleyiciyle aynı kökendedir: /api/* üzerinden durumunu
// okur, aktif karakteri değiştirir, duraklatır, son kaydı geri alır. GitHub Pages'ten açıldığında köprü kapalıdır
// (dışarıdaki bir site bu bilgisayardaki uygulamaya erişemez).

import { esc } from './render.js';

export const APP_PORT = '47321';
export const LOCAL = ['127.0.0.1', 'localhost'].includes(location.hostname) && location.port === APP_PORT;

async function api(path, body) {
  const opt = body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(`/api${path}`, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

export const bridge = { local: LOCAL, online: false, s: null, at: 0 };

export async function refreshBridge() {
  if (!LOCAL) return bridge;
  try {
    bridge.s = await api('/status');
    bridge.online = true;
  } catch {
    bridge.online = false;
  }
  bridge.at = Date.now();
  return bridge;
}

export const appApi = {
  char: (id) => api('/char', { id }),
  pause: (paused) => api('/pause', { paused }),
  undo: () => api('/undo', {}),
  test: () => api('/test', {}),
  session: (s) => api('/session', s),
  logout: () => api('/logout', {}),
  getSession: () => api('/session'),
  overlay: (b) => api('/overlay', b),
};

// Kenar çubuğundaki küçük durum rozeti
export function appChip(b) {
  if (!b.local) return '';
  if (!b.online) return '<span class="chip off" title="Uygulama kapalı ya da yanıt vermiyor">● Uygulama kapalı</span>';
  const s = b.s;
  if (!s.loggedIn) return '<span class="chip warn">● Giriş bekleniyor</span>';
  const name = s.chars?.find((c) => c.id === s.charId)?.name || '?';
  return s.paused
    ? `<span class="chip warn" title="Ekran izleme duraklatıldı">❚❚ Duraklatıldı · ${esc(name)}</span>`
    : `<span class="chip on" title="Ödül kutusu penceresi izleniyor">● İzliyor · ${esc(name)}</span>`;
}

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');

export function renderAppView(root, b, { repo }) {
  if (!b.local) {
    const link = repo?.owner && repo?.repo ? `https://github.com/${esc(repo.owner)}/${esc(repo.repo)}/tree/main/tools/izleyici` : '';
    root.innerHTML = `
      <section class="panel">
        <header class="panel-head"><h2>Masaüstü uygulaması</h2></header>
        <p>Ekran izleyici, oyunda <b>Odyle Energy Cube</b> penceresini görünce enerjiyi ve zindan garanti sayacını kendiliğinden kaydeder.
        Uygulama açıldığında bu siteyi kendi penceresinde gösterir; izleyicinin durumu, aktif karakter seçimi ve kayıtları bu bölümde görünür.</p>
        <ol class="steps">
          <li><code>tools/izleyici</code> klasöründeki <b>Baslat.bat</b> ve <b>izleyici.ps1</b> dosyalarını aynı klasöre indir${link ? ` (<a href="${link}" target="_blank" rel="noopener">GitHub'da aç</a>)` : ''}.</li>
          <li><b>Baslat.bat</b>'a çift tıkla. Kurulum gerekmez; saat yanında bir simge belirir ve uygulama penceresi açılır.</li>
          <li>Pencerede bir kez giriş yap. Sonraki açılışlarda kendiliğinden bağlanır.</li>
        </ol>
        <p class="hint">Bu sayfayı GitHub Pages'ten açtığın için uygulamaya bağlanılmıyor; bu, dışarıdaki sitelerin bilgisayarındaki uygulamaya erişememesi için.</p>
      </section>`;
    return;
  }
  if (!b.online) {
    root.innerHTML = `
      <section class="panel">
        <header class="panel-head"><h2>Uygulama yanıt vermiyor</h2></header>
        <p>Ekran izleyici kapanmış olabilir. <b>Baslat.bat</b> ile yeniden başlat; bu sayfa kendiliğinden bağlanır.</p>
      </section>`;
    return;
  }
  const s = b.s;
  const stateTxt = !s.loggedIn ? 'Giriş bekleniyor' : s.paused ? 'Duraklatıldı' : 'İzliyor';
  const stateCls = !s.loggedIn ? 'warn' : s.paused ? 'warn' : 'on';
  const last = s.lastRead;
  const ov = s.overlay || {};
  root.innerHTML = `
    <div class="app-grid">
      <section class="panel app-state ${stateCls}">
        <header class="panel-head">
          <h2><span class="dot"></span>${stateTxt}</h2>
          <span class="muted">v${esc(s.version || '?')} · ekran ${esc(s.screen || '?')}${s.queue ? ` · <b class="warn-txt">${s.queue} kayıt gönderilmeyi bekliyor</b>` : ''}</span>
        </header>
        <p class="app-status">${esc(s.status || '')}</p>
        <div class="row">
          <button type="button" class="btn ${s.paused ? 'primary' : ''}" data-app="pause" ${s.loggedIn ? '' : 'disabled'}>${s.paused ? '▶ Devam et' : '❚❚ Duraklat'}</button>
          <button type="button" class="btn" data-app="undo" ${s.canUndo ? '' : 'disabled'} title="Son kutu kaydını geri al">↶ Son kaydı geri al</button>
          <button type="button" class="btn" data-app="test" title="Ekranı şimdi oku ve görüntüyü kaydet">⌖ Ekranı şimdi oku</button>
        </div>
      </section>

      <section class="panel">
        <header class="panel-head"><h2>Aktif karakter</h2><span class="muted">kutular bu karaktere yazılır</span></header>
        <div class="seg" role="radiogroup" aria-label="Aktif karakter">
          ${(s.chars || []).map((c) => `<button type="button" role="radio" class="seg-btn" data-app-char="${esc(c.id)}" aria-checked="${c.id === s.charId}">${esc(c.name)}</button>`).join('') || '<span class="hint">Giriş yapınca karakterler gelir.</span>'}
        </div>
      </section>

      <section class="panel">
        <header class="panel-head"><h2>Son okunan kutu</h2>${last?.at ? `<span class="muted">${fmtTime(last.at)}</span>` : ''}</header>
        ${last ? `
        <dl class="kv">
          <dt>Zindan</dt><dd>${esc(last.dungeon)}</dd>
          <dt>Garanti</dt><dd>${last.kind === 'trans' ? '<span class="muted">yok (Transcendence)</span>' : `${esc(last.seen)}/${esc(last.max)}`}</dd>
          <dt>Kutu · maliyet</dt><dd>${esc(last.boxes)} kutu · ${esc(last.cost)} enerji</dd>
          <dt>Enerji</dt><dd>${last.natural != null ? `${esc(last.natural)} <span class="bonus-tag">+${esc(last.bonus)}</span> / ${esc(last.energyMax)}` : '<span class="muted">okunamadı</span>'}</dd>
        </dl>` : '<p class="hint">Henüz kutu okunmadı. Oyunda ödül kutusunu açtığında burada görünür.</p>'}
      </section>

      <section class="panel">
        <header class="panel-head"><h2>Oyun içi arayüz</h2><span class="muted">${(ov.openIds || []).length} bileşen${ov.edit ? ' · düzenleme modu' : ''}</span></header>
        <p>Oyunda <kbd>Alt+Shift+O</kbd> ile menü açılır: Enerji, Bosslar, Gear, Yapılacaklar… İstediğini ekrana ekle, başlığından tutup istediğin yere taşı.
        Bileşenler yarı saydamdır ve tıklamaları oyuna geçirir; oyunda imleci açıp üstüne gelince kullanılabilir hale gelir.</p>
        <div class="row">
          <button type="button" class="btn primary" data-app="overlay">Oyun içi menü</button>
          <button type="button" class="btn ${ov.edit ? 'primary' : ''}" data-app="ovmode">${ov.edit ? 'Düzenleme modunu kapat' : 'Düzenleme modu'}</button>
        </div>
        <p class="hint"><kbd>Alt+Shift+O</kbd> menü · <kbd>Alt+Shift+H</kbd> hepsini gizle/göster · <kbd>Alt+Shift+T</kbd> düzenleme modu. Oyun <b>çerçevesiz pencere</b> modunda olmalı.${ov.hotkeys === false ? ' <b class="warn-txt">Kısayol tuşlarından biri başka bir programda kullanıldığı için kaydedilemedi.</b>' : ''}</p>
      </section>

      <section class="panel span-all">
        <header class="panel-head"><h2>Kayıtlar</h2></header>
        <ol class="log">${(s.log || []).map((l) => `<li><time>${fmtTime(l.t)}</time> ${esc(l.m)}</li>`).join('') || '<li class="hint">Kayıt yok.</li>'}</ol>
      </section>
    </div>`;
}
