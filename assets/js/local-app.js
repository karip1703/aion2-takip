// Masaüstü uygulaması (Karip Traker, https://app.karip): ilk açılış, karakter ekleme/kaldırma, gear güncelleme.
// Veri kullanıcının kendi bilgisayarında; GitHub ya da hesap gerekmez.

import { APP, setAppUser } from './auth.js';
import { esc } from './render.js';
import { REGIONS, listServers, searchCharacter, fetchCharacter } from './plaync.js';

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

// ---------------------------------------------------------------- Sunucu listesi (bölge başına önbellek)
const serverCache = new Map();
async function servers(region) {
  if (!serverCache.has(region)) serverCache.set(region, await listServers(region));
  return serverCache.get(region);
}

// ---------------------------------------------------------------- Karakter ekleme
/** Karakter ekle penceresi. first: ilk açılış karşılaması (ad + ilk karakter). */
export async function openAddCharacter({ first = false } = {}) {
  const data = hooks.getData();
  const cfg = data?.config || {};
  const appInfo = first ? await loadAppUser() : null;
  const region = cfg.regionCode || 'eu';
  const d = dialog(`
    <h2>${first ? 'Karip Traker\'a hoş geldin' : 'Karakter ekle'}</h2>
    ${first ? `<p class="hint">Veriler sadece bu bilgisayarda tutulur. Başlamak için adını ve oyundaki karakterini ekle; gear, seviye ve CP resmi siteden çekilir.</p>
    <label>Adın <span class="hint">(yapılacaklarda ve boss işaretlerinde görünür)</span>
      <input type="text" id="kt-user" maxlength="24" value="${esc(appInfo?.user || '')}" placeholder="ör. Karip" autocomplete="off"></label>` : ''}
    <div class="kt-grid">
      <label>Bölge <select id="kt-region">${REGIONS.map((r) => `<option value="${r.code}" ${r.code === region ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
      <label>Sunucu <select id="kt-server"><option>Yükleniyor…</option></select></label>
    </div>
    <label>Karakter adı <input type="text" id="kt-name" maxlength="24" placeholder="oyundaki adı, tam olarak" autocomplete="off"></label>
    <p class="hint" id="kt-msg" role="status"></p>
    <div class="row end">
      ${first ? '' : '<button type="button" class="btn" id="kt-cancel">Vazgeç</button>'}
      <button type="button" class="btn primary" id="kt-add">${first ? 'Başla' : 'Ekle'}</button>
    </div>`);
  const msg = (t, kind = '') => { const m = $('#kt-msg', d); m.textContent = t; m.className = `hint ${kind}`; };
  const fillServers = async () => {
    const sel = $('#kt-server', d);
    sel.innerHTML = '<option>Yükleniyor…</option>';
    try {
      const list = await servers($('#kt-region', d).value);
      const cur = Number(cfg.serverId) || null;
      sel.innerHTML = list.map((s) => `<option value="${s.id}" ${s.id === cur ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
    } catch (e) { sel.innerHTML = '<option value="">—</option>'; msg(`Sunucular alınamadı: ${e.message}`, 'error'); }
  };
  $('#kt-region', d).addEventListener('change', fillServers);
  $('#kt-cancel', d)?.addEventListener('click', closeDialog);
  d.addEventListener('cancel', (e) => { if (first) e.preventDefault(); });
  await fillServers();
  $('#kt-name', d).focus();

  const submit = async () => {
    const btn = $('#kt-add', d);
    const name = $('#kt-name', d).value.trim();
    const regionCode = $('#kt-region', d).value;
    const serverId = Number($('#kt-server', d).value);
    const serverName = $('#kt-server', d).selectedOptions[0]?.textContent || '';
    if (first) {
      const user = $('#kt-user', d).value.trim();
      if (!user) return msg('Adını yaz.', 'error');
      await fetch('/api/app/user', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: user }) });
      setAppUser(user);
    }
    if (!name) return msg('Karakter adını yaz.', 'error');
    if (!serverId) return msg('Sunucu seç.', 'error');
    if ((hooks.getData().characters || []).some((c) => c.name.toLowerCase() === name.toLowerCase() && Number(c.ref?.serverId || c.serverId) === serverId)) return msg('Bu karakter zaten ekli.', 'error');
    btn.disabled = true;
    try {
      msg('Karakter aranıyor…');
      const ref = await searchCharacter(name, serverId, regionCode);
      msg('Gear ve yetenekler çekiliyor…');
      const { game } = await fetchCharacter({ name, ref, region: regionCode }, { regionCode, serverId }, (i, n) => msg(`Gear çekiliyor… ${i}/${n}`));
      await hooks.commit((data) => {
        data.config ||= {};
        if (!data.config.serverId) { data.config.serverId = serverId; data.config.server = serverName; data.config.regionCode = regionCode; }
        data.characters ||= [];
        let id = slug(name); const ids = new Set(data.characters.map((c) => c.id));
        for (let k = 2; ids.has(id); k++) id = `${slug(name)}-${k}`;
        data.characters.push({ id, name: game ? name : name, region: regionCode, server: serverName, serverId, ref, game: { ...game, updatedAt: new Date().toISOString() }, energy: null, dungeons: [] });
        data.lastFetch = new Date().toISOString();
      }, `Karakter eklendi: ${name}`);
      closeDialog();
      hooks.status(`${esc(name)} eklendi: ${esc(game.class || '')} Lv${esc(game.level ?? '?')}, iLvl ${esc(game.itemLevel ?? '?')}. Enerjisini kartından gir ya da oyunda bir kutu açınca kendiliğinden gelir.`, 'ok');
    } catch (e) {
      msg(e.message, 'error');
      btn.disabled = false;
    }
  };
  $('#kt-add', d).addEventListener('click', submit);
  $('#kt-name', d).addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
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
  if (!chars.length) { hooks.status('Güncellenecek karakter yok. Önce bir karakter ekle.', 'error'); return; }
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
