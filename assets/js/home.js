// Genel bakış: karakterlerin enerjisi, yaklaşan bosslar, açık yapılacaklar ve uygulamanın durumu tek ekranda.

import { esc, effEnergy, fmtAgo } from './render.js';
import { energyState, energyCfg, fmtDuration } from './energy.js';
import { BOSSES, bossStatus, fmtLeft, fmtClock } from './bosses.js';
import { appChip } from './izleyici.js';

const nf = new Intl.NumberFormat('tr-TR');
const safeImg = (u) => typeof u === 'string' && /^https:\/\//i.test(u);

function charRow(ch, st, near) {
  const g = ch.game || {};
  const cls = !st.known ? '' : st.isFull ? 'is-full' : st.msToFull != null && st.msToFull <= near * 3_600_000 ? 'is-near' : '';
  const img = safeImg(g.profileImage)
    ? `<img class="avatar sm" src="${esc(g.profileImage)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<span class="avatar sm ph">${esc((ch.name || '?')[0])}</span>`;
  const nat = st.known ? `${nf.format(st.current)}/${nf.format(st.max)}` : `?/${nf.format(st.max)}`;
  const full = !st.known ? 'enerji girilmedi' : st.isFull ? '<b class="full-txt">FULL</b>' : `full ${fmtDuration(st.msToFull)}`;
  return `
    <button type="button" class="crow ${cls}" data-char="${esc(ch.id)}" title="Detayları aç">
      ${img}
      <span class="crow-who">
        <b>${esc(ch.name)}</b>${ch.sample ? '<span class="sample-tag">örnek</span>' : ''}
        <span class="muted">${esc(g.class || '')}${g.level ? ` · Lv${esc(g.level)}` : ''}${g.itemLevel ? ` · iLvl ${nf.format(g.itemLevel)}` : ''}</span>
      </span>
      <span class="crow-en">
        <b class="crow-total">${st.known || st.bonus ? nf.format(st.total) : '—'}</b>
        <span class="muted">${nat}${st.bonus ? ` <span class="bonus-tag">+${nf.format(st.bonus)}</span>` : ''}</span>
        <span class="crow-bar"><i style="width:${st.known ? (st.ratio * 100).toFixed(1) : 0}%"></i></span>
        <span class="muted crow-full">${full}</span>
      </span>
    </button>`;
}

export function renderHome(root, data, { edits, user, bridge, now = Date.now() }) {
  const near = Number(data.config?.nearFullHours ?? 3);
  const chars = (data.characters || []).map((ch) => charRow(ch, energyState(effEnergy(ch, edits), energyCfg(data, ch), now), near)).join('');

  // Bosslar: takip edilenler; hiç yoksa Abyss programı
  const watched = data.bosses?.watch?.[user] || [];
  const pool = watched.length ? BOSSES.filter((b) => watched.includes(b.id)) : BOSSES.filter((b) => b.kind === 'schedule');
  const bosses = pool
    .map((b) => ({ b, st: bossStatus(b, data, now) }))
    .filter((x) => x.st.state !== 'unknown')
    .sort((x, y) => (x.st.state === 'waiting') - (y.st.state === 'waiting') || x.st.at - y.st.at)
    .slice(0, 6)
    .map(({ b, st }) => {
      const when = st.state === 'active' ? '<b class="ok-txt">aktif</b>'
        : st.state === 'up' ? '<b class="ok-txt">doğdu</b>'
          : `<b>${fmtLeft(st.at - now)}</b> <span class="muted">${fmtClock(st.at)}</span>`;
      return `<li><span>${esc(b.name)} <span class="muted">${esc(b.map)}</span></span><span>${when}</span></li>`;
    }).join('');
  const unknownWatched = watched.length && pool.filter((b) => bossStatus(b, data, now).state === 'unknown').length;

  const open = (data.todos || []).filter((t) => !t.done);
  const todos = open.slice(0, 6).map((t) => `<li><span>${esc(t.text)}</span><span class="muted">${esc(t.by || '')} · ${esc(fmtAgo(t.at, now))}</span></li>`).join('');

  root.innerHTML = `
    <div class="home">
      <section class="panel span-2">
        <header class="panel-head"><h2>Karakterler</h2><button type="button" class="linkbtn" data-go="cards">Kartlar →</button></header>
        <div class="crows">${chars || '<p class="hint">Karakter yok.</p>'}</div>
      </section>

      <section class="panel">
        <header class="panel-head"><h2>${watched.length ? 'Takip ettiğin bosslar' : 'Abyss programı'}</h2><button type="button" class="linkbtn" data-go="bosses">Bosslar →</button></header>
        ${bosses ? `<ul class="mini">${bosses}</ul>` : '<p class="hint">Gösterilecek boss yok.</p>'}
        ${unknownWatched ? `<p class="hint">${unknownWatched} takip edilen bossun ölüm zamanı bilinmiyor.</p>` : ''}
        ${watched.length ? '' : '<p class="hint">Bosslar bölümünde ★ ile seçtiklerin burada ve bildirimlerde görünür.</p>'}
      </section>

      <section class="panel">
        <header class="panel-head"><h2>Yapılacaklar <span class="muted">${open.length} açık</span></h2><button type="button" class="linkbtn" data-go="todos">Tümü →</button></header>
        ${todos ? `<ul class="mini">${todos}</ul>` : '<p class="hint">Açık madde yok.</p>'}
      </section>

      ${bridge.local ? `
      <section class="panel">
        <header class="panel-head"><h2>Uygulama</h2><button type="button" class="linkbtn" data-go="app">Aç →</button></header>
        <p>${appChip(bridge)}</p>
        ${bridge.online && bridge.s?.lastRead ? `<p class="hint">Son kutu: ${esc(bridge.s.lastRead.dungeon)} ${esc(bridge.s.lastRead.seen)}/${esc(bridge.s.lastRead.max)}</p>` : ''}
      </section>` : ''}
    </div>`;
}
