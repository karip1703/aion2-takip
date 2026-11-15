// Masaüstü uygulaması (Karip Traker, https://app.karip): ilk açılış, otomatik karakter ekleme (ağ okuması), kaldırma, gear güncelleme.
// Veri kullanıcının kendi bilgisayarında; GitHub ya da hesap gerekmez.

import { APP, setAppUser } from './auth.js';
import { esc } from './render.js';
import { listServers, findCandidates, fetchCharacter } from './plaync.js';

export { APP };

const $ = (s, el = document) => el.querySelector(s);
const slug = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'karakter';

let hooks = null;   // { getData, commit(mutator, message), reload, status }
export function initLocalApp(h) { hooks = h; }

/** Uygulamadan kullanıcı adını al (yapılacaklar ve boss işaretlerinde görünür). */
export async function loadAppUser() {
  try { const j = await (await fetch('/api/app', { cache: 'no-store' })).json(); if (j.user) setAppUser(j.user); return j; } catch { return {}; }
}

// ---------------------------------------------------------------- Diyalog
function dialog(html, { wide } = {}) {
  let d = $('#kt-dlg');
  if (!d) {
    d = document.createElement('dialog'); d.id = 'kt-dlg';
    document.body.appendChild(d);
  }
  d.innerHTML = `<div class="dlg kt-dlg ${wide ? 'wide' : ''}">${html}</div>`;
  if (!d.open) d.showModal();
  return d;
}
const closeDialog = () => { const d = $('#kt-dlg'); if (d?.open) d.close(); };

// ---------------------------------------------------------------- İlk açılış
/** Karşılama: sadece kullanıcı adı. Karakterler oyuna girince ağ okumasıyla kendiliğinden eklenir. */
export async function openWelcome() {
  const appInfo = await loadAppUser();
  const d = dialog(`
    <h2>Karip Traker'a hoş geldin</h2>
    <p class="hint">Veriler sadece bu bilgisayarda tutulur. Karakter eklemen gerekmez: oyuna bir karakterle girdiğinde uygulama onu oyun trafiğinden tanır,
    resmi siteden gear, seviye ve CP'sini çekip <b>Karakterler</b> bölümüne kendiliğinden ekler.</p>
    <label>Adın <span class="hint">(yapılacaklarda ve boss işaretlerinde görünür)</span>
      <input type="text" id="kt-user" maxlength="24" value="${esc(appInfo?.user || '')}" placeholder="ör. Karip" autocomplete="off"></label>
    <p class="hint" id="kt-msg" role="status"></p>
    <div class="row end"><button type="button" class="btn primary" id="kt-ok">Başla</button></div>`);
  d.addEventListener('cancel', (e) => e.preventDefault());
  const input = $('#kt-user', d); input.focus();
  let resolve; const done = new Promise((r) => { resolve = r; });   // ad girilince biter
  const submit = async () => {
    const user = input.value.trim();
    if (!user) { const m = $('#kt-msg', d); m.textContent = 'Adını yaz.'; m.className = 'hint error'; return; }
    await fetch('/api/app/user', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: user }) });
    setAppUser(user);
    closeDialog();
    hooks.status('Hazır. Oyuna gir: karakterin kendiliğinden eklenecek.', 'ok');
    resolve();
  };
  $('#kt-ok', d).addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  return done;
}

// ---------------------------------------------------------------- Otomatik karakter ekleme (ağ okuması)
const busy = new Set();
const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** Aynı adda birden fazla karakter varsa (farklı sunucular) kullanıcıya sor. */
function chooseCandidate(name, list) {
  return new Promise((resolve) => {
    const d = dialog(`
      <h2>${esc(name)} hangi sunucuda?</h2>
      <p class="hint">Oyundaki karakterin <b>${esc(name)}</b> olarak okundu; resmi sitede bu adda birden fazla karakter var. Seninkini seç.</p>
      <div class="kt-pick">${list.map((c, i) => `<button type="button" class="btn" data-pick="${i}">${esc(c.serverName || c.ref.serverId)}${c.level != null ? ` · Lv${esc(c.level)}` : ''}</button>`).join('')}</div>
      <div class="row end"><button type="button" class="btn" data-pick="-1">Şimdi değil</button></div>`);
    const done = (v) => { d.removeEventListener('click', onClick); closeDialog(); resolve(v); };
    const onClick = (e) => { const b = e.target.closest('[data-pick]'); if (b) done(list[Number(b.dataset.pick)] || null); };
    d.addEventListener('click', onClick);
    d.addEventListener('cancel', () => done(null), { once: true });
  });
}

/**
 * Ağ okuyucusu oyundaki karakteri ilk kez gördü: listede yoksa resmi siteden bulup ekle.
 * server: parti listesinden biliniyorsa sunucu kodu (0 = bilinmiyor).
 */
export async function autoAddCharacter(name, server) {
  name = String(name || '').trim();
  if (!name || busy.has(name.toLowerCase())) return;
  const data0 = hooks.getData() || {};
  if ((data0.characters || []).some((c) => sameName(c.name, name))) return;
  busy.add(name.toLowerCase());
  try {
    const cfg = data0.config || {};
    const region = cfg.regionCode || 'eu';
    hooks.status(`Oyundaki karakter okundu: <b>${esc(name)}</b> — resmi sitede aranıyor…`);
    let pick = null;
    if (server) pick = (await findCandidates(name, region, server))[0] || null;
    if (!pick) {
      const all = await findCandidates(name, region);
      // Önce bilinen sunucular (ayar + eklenmiş karakterler)
      const known = new Set([Number(cfg.serverId), ...(data0.characters || []).map((c) => Number(c.ref?.serverId || c.serverId))].filter(Boolean));
      const onKnown = all.filter((c) => known.has(c.ref.serverId));
      if (onKnown.length === 1) pick = onKnown[0];
      else if (all.length === 1) pick = all[0];
      else if (all.length > 1) pick = await chooseCandidate(name, (onKnown.length > 1 ? onKnown : all).sort((a, b) => (b.level ?? 0) - (a.level ?? 0)));
      else for (const sid of known) { pick = (await findCandidates(name, region, sid))[0] || null; if (pick) break; }
    }
    if (!pick) {
      hooks.status(`<b>${esc(name)}</b> resmi sitede bulunamadı ya da seçilmedi. Yeni açılan karakterler siteye geç düşebilir; uygulama bir sonraki girişte yeniden dener.`, 'error', true);
      return;
    }
    const serverName = (await listServers(region)).find((x) => x.id === pick.ref.serverId)?.name || pick.serverName;
    hooks.status(`<b>${esc(name)}</b> bulundu (${esc(serverName)}) — gear çekiliyor…`);
    const { ref, game } = await fetchCharacter({ name, ref: pick.ref, region }, { regionCode: region, serverId: pick.ref.serverId },
      (i, n) => hooks.status(`<b>${esc(name)}</b> — gear çekiliyor… ${i}/${n}`));
    let added = false;
    await hooks.commit((data) => {
      data.config ||= {};
      if (!data.config.serverId) { data.config.serverId = ref.serverId; data.config.server = serverName; data.config.regionCode = region; }
      data.characters ||= [];
      if (data.characters.some((c) => sameName(c.name, name))) return false;
      let id = slug(name); const ids = new Set(data.characters.map((c) => c.id));
      for (let k = 2; ids.has(id); k++) id = `${slug(name)}-${k}`;
      data.characters.push({ id, name, region, server: serverName, serverId: ref.serverId, ref, game: { ...game, updatedAt: new Date().toISOString() }, energy: null, dungeons: [], auto: true });
      data.lastFetch = new Date().toISOString();
      added = true;
      return true;
    }, `Karakter eklendi (oyundan): ${name}`);
    if (added) hooks.status(`<b>${esc(name)}</b> oyundan tanındı ve eklendi: ${esc(game.class || '')} Lv${esc(game.level ?? '?')}, iLvl ${esc(game.itemLevel ?? '?')}. Enerjisi oyunda okunduğunda kendiliğinden gelir.`, 'ok');
  } catch (e) {
    hooks.status(`${esc(name)} eklenemedi: ${esc(e.message)}`, 'error', true);
  } finally { busy.delete(name.toLowerCase()); }
}

/** Karakteri kaldır (onaylı). */
export async function removeCharacter(id) {
  const ch = (hooks.getData().characters || []).find((c) => c.id === id);
  if (!ch || !confirm(`${ch.name} kaldırılsın mı? (Enerji ve zindan sayaçları da silinir.)`)) return false;
  await hooks.commit((data) => { data.characters = (data.characters || []).filter((c) => c.id !== id); }, `Karakter kaldırıldı: ${ch.name}`);
  hooks.status(`${esc(ch.name)} kaldırıldı.`, 'ok');
  return true;
}

/** Gear güncelle: bütün karakterleri resmi siteden yeniden çek. */
export async function refreshAll(onProgress) {
  const data = hooks.getData();
  const chars = (data.characters || []).filter((c) => c.fetch !== false && !c.sample);
  if (!chars.length) { hooks.status('Güncellenecek karakter yok. Oyuna bir karakterle gir; kendiliğinden eklenir.', 'error'); return; }
  const results = [];
  for (const [i, ch] of chars.entries()) {
    onProgress?.(`${ch.name} (${i + 1}/${chars.length})…`);
    const at = new Date().toISOString();
    try {
      const { ref, game } = await fetchCharacter(ch, data.config || {}, (k, n) => onProgress?.(`${ch.name} (${i + 1}/${chars.length}) · gear ${k}/${n}`));
      results.push({ id: ch.id, ok: true, at, ref, game });
    } catch (e) { results.push({ id: ch.id, ok: false, at, error: e.message }); }
  }
  await hooks.commit((d) => {
    for (const r of results) {
      const ch = (d.characters || []).find((c) => c.id === r.id); if (!ch) continue;
      if (r.ok) { ch.game = { ...r.game, updatedAt: r.at }; ch.ref = r.ref; delete ch.lastError; }
      else ch.lastError = { message: r.error, at: r.at };
    }
    d.lastFetch = new Date().toISOString();
  }, 'Gear güncellendi');
  const bad = results.filter((r) => !r.ok);
  hooks.status(bad.length ? `Güncellendi; çekilemeyenler: ${bad.map((r) => `${esc(r.id)} (${esc(r.error)})`).join(', ')}` : `${results.length} karakter güncellendi ✔`, bad.length ? 'error' : 'ok', !!bad.length);
}
