import * as gh from './github.js';
import {
  unlock, encryptAccount, hasAccounts, getSession, setSession, clearSession, normUser, DEFAULT_ITERATIONS, MIN_PASSWORD,
} from './auth.js';
import { applyEnergyEdits, editTime } from './merge.js';
import { adjustEnergy, setEnergy, adjustBonus, setBonus, energyCfg } from './energy.js';
import {
  renderCards, updateEnergyLive, renderCompare, effEnergy, fmtAgo, fmtDate, esc, itemDetailHtml, charDialogHtml, CHAR_TABS,
} from './render.js';

const $ = (s) => document.querySelector(s);
const LS_EDITS = 'aion2.edits';
const LS_VIEW = 'aion2.view';
const LS_SORT = 'aion2.sort';

const state = {
  data: null,       // uzaktaki (kaydedilmiş) veri — bekleyen düzenlemeler HARİÇ
  sha: null,        // data.json'un son bilinen SHA'sı (sadece API'den okununca)
  source: null,     // 'api' | 'pages'
  edits: loadEdits(), // { [charId]: { value, setAt, setBy } } — kaydedilmemiş enerji girişleri
  login: getSession()?.user || null, // giriş yapan site kullanıcısı (commit mesajlarında görünür)
  view: ['cards', 'compare'].includes(location.hash.slice(1)) ? location.hash.slice(1) : (lsGet(LS_VIEW) || 'cards'),
  sortKey: lsGet(LS_SORT) || 'itemLevel',
  busy: false,
};

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* yoksay */ } }
function loadEdits() { try { return JSON.parse(localStorage.getItem(LS_EDITS) || '{}'); } catch { return {}; } }
function saveEdits() { lsSet(LS_EDITS, JSON.stringify(state.edits)); }

// Giriş yapılmış mı (oturumda çözülmüş token + repo var mı)? Giriş yapan herkes tam yetkili.
const hasAccess = () => !!gh.getToken() && !!gh.getRepo().owner && !!gh.getRepo().repo;
const canEdit = hasAccess;
const ctx = () => ({ editable: canEdit(), edits: state.edits });

// ---------------- Durum mesajı ----------------
let statusTimer;
function status(msg, kind = '', sticky = false) {
  const el = $('#status');
  clearTimeout(statusTimer);
  if (!msg) { el.hidden = true; return; }
  el.hidden = false;
  el.className = `status ${kind}`;
  el.innerHTML = msg;
  if (!sticky) statusTimer = setTimeout(() => { el.hidden = true; }, 7000);
}

// ---------------- Veri yükleme ----------------
async function load() {
  status('Veri yükleniyor…', '', true);
  let usedApi = false;
  if (hasAccess()) {
    try {
      const f = await gh.getFile();
      state.data = JSON.parse(f.text);
      state.sha = f.sha;
      state.source = 'api';
      usedApi = true;
    } catch (e) {
      if (e.status === 401 || e.status === 403 || e.status === 404) {
        // Token geçersiz / süresi dolmuş / yetkisi alınmış → oturumu kapat, girişe dön.
        clearSession();
        state.login = null;
        loginError = 'Oturum geçersiz: GitHub token\'ının süresi dolmuş ya da yetkisi kaldırılmış olabilir. Site sahibi "Hesap kurulumu" ile yeni token girmeli.';
      } else {
        status(`GitHub API'den okunamadı (${esc(e.message)}). Pages kopyası gösteriliyor.`, 'error', true);
      }
    }
  }
  if (!usedApi) {
    try {
      const res = await fetch(`${gh.DATA_PATH}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.data = await res.json();
      state.sha = null;
      state.source = 'pages';
    } catch (e) {
      status(`data.json yüklenemedi: ${esc(e.message)}. (Dosyayı doğrudan açtıysan README'deki "Lokal test" adımına bak.)`, 'error', true);
      return;
    }
  }
  // API hatası mesajı varsa (Pages'e düşüldüyse) ekranda kalsın.
  if (usedApi || !hasAccess()) status('');
  pruneEdits();
  renderAll();
  gate();
}

// ---------------- Giriş kapısı ----------------
// Hesap kuruluysa ve oturum yoksa → giriş ekranı. Hesap hiç kurulmamışsa → salt okunur + uyarı.
let loginError = '';
function gate() {
  const locked = hasAccounts(state.data) && !hasAccess();
  $('#login').hidden = !locked;
  $('#app').hidden = locked;
  $('#login-err').textContent = loginError;
  if (locked) setTimeout(() => $('#login-user').focus(), 0);
  if (!hasAccounts(state.data)) {
    status('Henüz hesap kurulmamış: site salt okunur. ⚙ → <b>Hesap kurulumu</b> ile kendi ve arkadaşının hesabını oluştur.', '', true);
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-btn');
  btn.disabled = true;
  btn.textContent = 'Kontrol ediliyor…';
  loginError = '';
  $('#login-err').textContent = '';
  try {
    const s = await unlock(state.data.auth, $('#login-user').value, $('#login-pass').value);
    setSession({ user: s.user, token: s.token, owner: s.owner, repo: s.repo, branch: s.branch || 'main' }, $('#login-remember').checked);
    state.login = s.user;
    $('#login-pass').value = '';
    await load(); // artık API'den (güncel) okunur
  } catch (err) {
    $('#login-err').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Giriş yap';
  }
});

// Uzakta zaten aynı ya da daha yeni değer varsa bekleyen düzenlemeyi at.
function pruneEdits() {
  const ids = new Set((state.data.characters || []).map((c) => c.id));
  for (const [id, ed] of Object.entries(state.edits)) {
    const remote = state.data.characters.find((c) => c.id === id)?.energy;
    if (!ids.has(id) || (remote && editTime(remote) >= editTime(ed))) delete state.edits[id];
  }
  saveEdits();
}

// ---------------- Çizim ----------------
function renderAll() {
  const d = state.data;
  if (!d) return;
  const cfg = d.config || {};
  $('#subtitle').textContent = [cfg.region, cfg.server, `veri: ${fmtAgo(d.lastFetch)}`].filter(Boolean).join(' · ');
  $('#subtitle').title = `Son gear değişikliği: ${fmtDate(d.lastFetch)}`;
  $('#sample-banner').hidden = !(d.sample || (d.characters || []).some((c) => c.sample));

  renderCards($('#view-cards'), d, ctx());
  if (charDlg.open && charCur) showChar(charCur.id, charCur.tab); // veri yenilendiyse pencereyi de yenile
  if (state.view === 'compare') renderCompare($('#rank-table'), $('#gear-matrix'), d, state.sortKey, ctx());
  renderChrome();
}

function renderChrome() {
  const editable = canEdit();
  const pill = $('#mode-pill');
  if (!pill.classList.contains('run')) {
    pill.textContent = editable ? `Giriş: ${state.login || '?'}` : 'Salt okunur';
    pill.title = editable ? 'Tam yetki: enerji düzenleme ve gear güncelleme' : 'Giriş yapılmadı';
    pill.className = `pill ${editable ? 'edit' : ''}`;
  }
  $('#btn-save').hidden = !editable;
  $('#btn-fetch').hidden = !editable;
  const n = Object.keys(state.edits).length;
  $('#btn-save').disabled = !n || state.busy;
  $('#btn-save').textContent = n ? `Kaydet (${n})` : 'Kaydet';

  for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.view === state.view));
  $('#view-cards').hidden = state.view !== 'cards';
  $('#view-compare').hidden = state.view !== 'compare';
  $('#sort-key').value = state.sortKey;

  const r = gh.getRepo();
  $('#foot').innerHTML = [
    state.source === 'api' ? 'Kaynak: GitHub API (anlık)' : 'Kaynak: GitHub Pages (≈10 dk önbellekli olabilir)',
    r.owner && r.repo ? `<a href="https://github.com/${esc(r.owner)}/${esc(r.repo)}" style="color:inherit">${esc(r.owner)}/${esc(r.repo)}</a>` : 'repo ayarlı değil',
  ].join(' · ');
}

function tick() {
  if (!state.data) return;
  updateEnergyLive($('#view-cards'), state.data, ctx());
  if (state.view === 'compare') renderCompare($('#rank-table'), $('#gear-matrix'), state.data, state.sortKey, ctx());
}

// ---------------- Enerji düzenleme ----------------
// patch: doğal kısım için { value, setAt }, ek kısım için { bonus }.
// Mevcut enerjinin üstüne birleştirilir; bir havuzu değiştirmek diğerini bozmaz.
function setEdit(id, patch) {
  const ch = state.data.characters.find((c) => c.id === id);
  // setAt = enerji hesabının referans anı (tik fazı için geçmişe çekilebilir),
  // editedAt = düzenlemenin gerçek zamanı (çakışmada hangisi daha yeni, buna bakılır).
  state.edits[id] = {
    ...(effEnergy(ch, state.edits) || {}),
    ...patch,
    editedAt: new Date().toISOString(),
    ...(state.login ? { setBy: state.login } : {}),
  };
  saveEdits();
  tick();
  renderChrome();
}

$('#view-cards').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-delta]');
  if (!btn || !canEdit()) return;
  const id = btn.closest('.card').dataset.id;
  const ch = state.data.characters.find((c) => c.id === id);
  const en = effEnergy(ch, state.edits);
  const delta = Number(btn.dataset.delta);
  setEdit(id, btn.closest('[data-pool]').dataset.pool === 'bonus'
    ? adjustBonus(en, delta)
    : adjustEnergy(en, energyCfg(state.data, ch), delta));
});

const ENERGY_INPUTS = 'input[data-e="input"], input[data-e="bonus"]';

$('#view-cards').addEventListener('change', (e) => {
  const input = e.target.closest(ENERGY_INPUTS);
  if (!input || !canEdit() || input.value === '') return;
  const id = input.closest('.card').dataset.id;
  setEdit(id, input.dataset.e === 'bonus' ? setBonus(input.value) : setEnergy(input.value));
  input.blur();
});

$('#view-cards').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches(ENERGY_INPUTS)) e.target.dispatchEvent(new Event('change', { bubbles: true }));
});

// ---------------- Kaydet (commit) ----------------
async function save() {
  const pending = { ...state.edits };
  if (!Object.keys(pending).length || state.busy) return;
  state.busy = true; renderChrome();
  status('Kaydediliyor…', '', true);

  try {
    let remote = state.data;
    let sha = state.sha;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!sha || attempt > 0) {
        const f = await gh.getFile();
        remote = JSON.parse(f.text);
        sha = f.sha;
      }
      const { data, applied, skipped } = applyEnergyEdits(remote, pending);
      const skippedTxt = skipped.length ? `<br>Atlanan: ${skipped.map((s) => `${esc(s.name || s.id)} (${esc(s.reason)})`).join(', ')}` : '';

      if (!applied.length) {
        finishSave(remote, sha, pending);
        status(`Kaydedilecek değişiklik kalmadı.${skippedTxt}`, '', true);
        return;
      }
      const msg = `Enerji: ${applied.map((a) => `${a.name} ${a.value}`).join(', ')}${state.login ? ` (${state.login})` : ''}`;
      try {
        const r = await gh.putFile(gh.stringifyData(data), sha, msg);
        finishSave(data, r.sha, pending);
        status(`Kaydedildi ✔ ${esc(msg)}${skippedTxt}`, 'ok', !!skipped.length);
        return;
      } catch (e) {
        // 409: SHA eskimiş (dosya bu arada değişmiş) → güncel dosyayı çekip tekrar birleştir.
        if (e.status === 409 || (e.status === 422 && /sha/i.test(e.message))) continue;
        throw e;
      }
    }
    throw new Error('Dosya art arda değişti, birkaç saniye sonra tekrar dene.');
  } catch (e) {
    const hint = e.status === 401 ? ' GitHub token\'ının süresi dolmuş olabilir: site sahibi "Hesap kurulumu" ile yenilemeli.'
      : e.status === 403 || e.status === 404 ? ' Token\'ın bu repoda "Contents: Read and write" yetkisi var mı?' : '';
    status(`Kaydedilemedi: ${esc(e.message)}.${hint} Değişikliklerin bu tarayıcıda duruyor.`, 'error', true);
  } finally {
    state.busy = false;
    renderChrome();
  }
}

function finishSave(data, sha, pending) {
  state.data = data;
  state.sha = sha;
  state.source = 'api';
  // Kayıt sırasında yeni bir düzenleme yapıldıysa onu silme.
  for (const [id, ed] of Object.entries(pending)) {
    if (state.edits[id] === ed || JSON.stringify(state.edits[id]) === JSON.stringify(ed)) delete state.edits[id];
  }
  saveEdits();
  renderAll();
}

// ---------------- Şimdi güncelle (workflow_dispatch) ----------------
const RUN_LABELS = { queued: 'Sırada', waiting: 'Bekliyor', pending: 'Bekliyor', requested: 'İstendi', in_progress: 'Çalışıyor' };

async function triggerFetch() {
  const btn = $('#btn-fetch');
  const pill = $('#mode-pill');
  btn.disabled = true;
  const since = Date.now();
  const setPill = (t) => { pill.textContent = t; pill.className = 'pill run'; };

  try {
    await gh.dispatchWorkflow();
    setPill('Güncelleme: istendi');
    status('Güncelleme tetiklendi. GitHub Actions işi başlatıyor…', '', true);

    const deadline = since + 15 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      const run = await gh.latestDispatchRun(since).catch(() => null);
      if (!run) continue;
      const link = `<a href="${esc(run.html_url)}" target="_blank" rel="noopener" style="color:inherit">kayıtlar</a>`;
      if (run.status !== 'completed') {
        setPill(`Güncelleme: ${RUN_LABELS[run.status] || run.status}`);
        status(`Güncelleme ${RUN_LABELS[run.status] || run.status}… (${link})`, '', true);
        continue;
      }
      pill.classList.remove('run');
      if (run.conclusion === 'success') {
        status(`Güncelleme bitti ✔ Veri yeniden yükleniyor… (${link})`, 'ok');
        await new Promise((r) => setTimeout(r, 2000));
        await load();
      } else {
        status(`Güncelleme başarısız: ${esc(run.conclusion)} (${link})`, 'error', true);
      }
      return;
    }
    status('Güncelleme 15 dakikada bitmedi, Actions sekmesine bak.', 'error', true);
  } catch (e) {
    const hint = e.status === 403 || e.status === 404 ? ' Token\'ın "Actions: Read and write" yetkisi var mı? Workflow dosyası repoda mı?' : '';
    status(`Tetiklenemedi: ${esc(e.message)}.${hint}`, 'error', true);
  } finally {
    pill.classList.remove('run');
    btn.disabled = false;
    renderChrome();
  }
}

// ---------------- Ayarlar ----------------
const dlg = $('#settings');

$('#btn-settings').addEventListener('click', () => {
  const s = getSession();
  $('#session-info').innerHTML = s
    ? `<b>${esc(s.user)}</b> olarak giriş yapıldı · repo: ${esc(s.owner)}/${esc(s.repo)}`
    : 'Giriş yapılmadı (site salt okunur).';
  $('#btn-logout').hidden = !s;
  dlg.showModal();
});

$('#btn-logout').addEventListener('click', () => {
  clearSession();
  state.login = null;
  loginError = '';
  dlg.close();
  load();
});

// ---------------- Hesap kurulumu ----------------
// Token + hesap listesi → her hesap için token şifrelenir → data.json'daki auth bölümü değiştirilir.
const setupDlg = $('#setup');

function accountRow(user = '') {
  const row = document.createElement('div');
  row.className = 'acc-row';
  row.innerHTML = `
    <input type="text" class="acc-user" placeholder="kullanıcı adı" value="${esc(user)}" autocapitalize="none" spellcheck="false" autocomplete="off">
    <input type="password" class="acc-pass" placeholder="şifre" autocomplete="new-password">
    <input type="password" class="acc-pass2" placeholder="şifre (tekrar)" autocomplete="new-password">
    <button type="button" class="btn sm danger acc-del" title="Hesabı kaldır">✕</button>`;
  row.querySelector('.acc-del').addEventListener('click', () => row.remove());
  return row;
}

function openSetup() {
  if (dlg.open) dlg.close();
  const s = getSession();
  const guess = gh.guessRepoFromLocation();
  $('#setup-token').value = '';
  $('#setup-owner').value = s?.owner || guess.owner || '';
  $('#setup-repo').value = s?.repo || guess.repo || '';
  $('#setup-branch').value = s?.branch || 'main';
  $('#setup-result').textContent = '';
  const box = $('#setup-accounts');
  box.innerHTML = '';
  const existing = (state.data?.auth?.accounts || []).map((a) => a.user);
  (existing.length ? existing : ['', '']).forEach((u) => box.append(accountRow(u)));
  setupDlg.showModal();
}

document.addEventListener('click', (e) => { if (e.target.closest('[data-open-setup]')) openSetup(); });
$('#setup-add').addEventListener('click', () => $('#setup-accounts').append(accountRow()));
$('#setup-cancel').addEventListener('click', () => setupDlg.close());

$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('#setup-result');
  const btn = $('#setup-save');
  const repoCtx = {
    token: $('#setup-token').value.trim(),
    owner: $('#setup-owner').value.trim(),
    repo: $('#setup-repo').value.trim(),
    branch: $('#setup-branch').value.trim() || 'main',
  };

  // Form kontrolü
  const rows = [...document.querySelectorAll('#setup-accounts .acc-row')].map((r) => ({
    user: normUser(r.querySelector('.acc-user').value),
    pass: r.querySelector('.acc-pass').value,
    pass2: r.querySelector('.acc-pass2').value,
  })).filter((r) => r.user || r.pass);
  const problems = [];
  if (!rows.length) problems.push('En az bir hesap gerekli.');
  const seen = new Set();
  for (const r of rows) {
    if (!r.user) problems.push('Kullanıcı adı boş olan satır var.');
    else if (seen.has(r.user)) problems.push(`"${r.user}" iki kez yazılmış.`);
    seen.add(r.user);
    if (r.pass.length < MIN_PASSWORD) problems.push(`"${r.user || '?'}" şifresi en az ${MIN_PASSWORD} karakter olmalı.`);
    else if (r.pass !== r.pass2) problems.push(`"${r.user}" şifreleri birbirini tutmuyor.`);
  }
  if (problems.length) { out.textContent = `✖ ${problems.join(' ')}`; return; }

  btn.disabled = true;
  try {
    out.textContent = 'Token kontrol ediliyor…';
    await gh.testToken(repoCtx);

    out.textContent = 'Şifreleniyor…';
    const payload = { token: repoCtx.token, owner: repoCtx.owner, repo: repoCtx.repo, branch: repoCtx.branch };
    const accounts = [];
    for (const r of rows) accounts.push(await encryptAccount(r.user, r.pass, payload, DEFAULT_ITERATIONS));
    const auth = { v: 1, iterations: DEFAULT_ITERATIONS, accounts };

    out.textContent = 'Repoya kaydediliyor…';
    let saved = null;
    for (let attempt = 0; attempt < 3 && !saved; attempt++) {
      const f = await gh.getFile(gh.DATA_PATH, repoCtx);
      const data = JSON.parse(f.text);
      data.auth = auth;
      if (data.config) delete data.config.editors; // eski izin listesi (artık kullanılmıyor)
      try {
        const r = await gh.putFile(gh.stringifyData(data), f.sha, `Hesaplar güncellendi (${accounts.length} hesap)`, gh.DATA_PATH, repoCtx);
        saved = { data, sha: r.sha };
      } catch (err) {
        if (err.status !== 409 && !(err.status === 422 && /sha/i.test(err.message))) throw err;
      }
    }
    if (!saved) throw new Error('Dosya art arda değişti, tekrar dene.');

    // Oturum açıksa yeni token'la güncelle (kullanıcı hâlâ listedeyse), değilse kapat.
    const s = getSession();
    if (s) {
      if (accounts.some((a) => a.user === s.user)) setSession({ ...s, ...payload }, !!localStorage.getItem('aion2.session'));
      else { clearSession(); state.login = null; }
    }
    // Pages kopyası birkaç dakika eski kalabilir; yeni veriyi doğrudan kullan.
    state.data = saved.data;
    state.sha = saved.sha;
    state.source = 'api';
    loginError = '';
    out.textContent = `✔ ${accounts.length} hesap kaydedildi: ${accounts.map((a) => a.user).join(', ')}`;
    $('#setup-token').value = '';
    for (const i of document.querySelectorAll('#setup-accounts input[type=password]')) i.value = '';
    setTimeout(() => { setupDlg.close(); renderAll(); gate(); }, 1200);
  } catch (err) {
    out.textContent = `✖ ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});
// ---------------- Karakter penceresi (Gear / Arcana / Skill) ----------------
const charDlg = $('#char-dlg');
let charCur = null; // { id, tab }

function showChar(id, tab = charCur?.tab || 'gear') {
  const ch = state.data?.characters.find((c) => c.id === id);
  if (!ch) return;
  if (!CHAR_TABS.some((t) => t.id === tab)) tab = 'gear';
  charCur = { id, tab };
  lsSet('aion2.charTab', tab);
  $('#char-body').innerHTML = charDialogHtml(ch, tab);
  if (!charDlg.open) charDlg.showModal();
}

// Kartın üst kısmı / istatistikler / "Detay" butonu → pencere. Enerji alanı açmaz.
$('#view-cards').addEventListener('click', (e) => {
  const trigger = e.target.closest('.card-open, .open-char');
  if (!trigger) return;
  const id = trigger.closest('.card')?.dataset.id;
  if (id) showChar(id, charCur?.tab || lsGet('aion2.charTab') || 'gear');
});
charDlg.addEventListener('click', (e) => {
  const t = e.target.closest('.cd-tab');
  if (t && charCur) showChar(charCur.id, t.dataset.tab);
  if (e.target === charDlg) charDlg.close();
});
$('#char-close').addEventListener('click', () => charDlg.close());

// ---------------- Eşya detay penceresi ----------------
const itemDlg = $('#item-dlg');
let itemCur = null; // { charId, index }

function showItem(charId, index) {
  const ch = state.data?.characters.find((c) => c.id === charId);
  const gear = ch?.game?.gear || [];
  if (!gear.length) return;
  const i = (index + gear.length) % gear.length;
  itemCur = { charId, index: i };
  $('#item-body').innerHTML = itemDetailHtml(ch, gear[i]);
  if (!itemDlg.open) itemDlg.showModal();
}

function openItemFrom(el) {
  const ch = state.data?.characters.find((c) => c.id === el.dataset.char);
  const idx = (ch?.game?.gear || []).findIndex((g) => g.slot === el.dataset.slot);
  if (idx >= 0) showItem(ch.id, idx);
}

// Hem ana sayfadaki hem karakter penceresindeki parçalar için tek dinleyici.
document.addEventListener('click', (e) => {
  const el = e.target.closest('.clickable[data-char][data-slot]');
  if (el) openItemFrom(el);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const el = e.target.closest('.clickable[data-char][data-slot]');
  if (el) { e.preventDefault(); openItemFrom(el); }
});
$('#item-close').addEventListener('click', () => itemDlg.close());
$('#item-prev').addEventListener('click', () => itemCur && showItem(itemCur.charId, itemCur.index - 1));
$('#item-next').addEventListener('click', () => itemCur && showItem(itemCur.charId, itemCur.index + 1));
itemDlg.addEventListener('keydown', (e) => {
  if (!itemCur) return;
  if (e.key === 'ArrowLeft') showItem(itemCur.charId, itemCur.index - 1);
  if (e.key === 'ArrowRight') showItem(itemCur.charId, itemCur.index + 1);
});
// Pencerenin dışına (arka plana) tıklayınca kapat.
itemDlg.addEventListener('click', (e) => { if (e.target === itemDlg) itemDlg.close(); });

// ---------------- Diğer olaylar ----------------
for (const t of document.querySelectorAll('.tab')) {
  t.addEventListener('click', () => {
    state.view = t.dataset.view;
    lsSet(LS_VIEW, state.view);
    renderAll();
  });
}
$('#sort-key').addEventListener('change', (e) => {
  state.sortKey = e.target.value;
  lsSet(LS_SORT, state.sortKey);
  tick();
});
$('#btn-save').addEventListener('click', save);
$('#btn-fetch').addEventListener('click', triggerFetch);
$('#btn-refresh').addEventListener('click', load);

window.addEventListener('beforeunload', (e) => {
  if (Object.keys(state.edits).length) { e.preventDefault(); e.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
setInterval(tick, 30_000);

// ---------------- Başlat ----------------
(async () => {
  await load();
  // Doğrudan bağlantılar:
  //   #char/<karakterId>/<sekme>  (ör. #char/kyrakia/skills)
  //   #item/<karakterId>/<sıra>   (ör. #item/kyrakia/0)
  const c = location.hash.match(/^#char\/([^/]+)(?:\/(\w+))?$/);
  if (c) showChar(decodeURIComponent(c[1]), c[2] || 'gear');
  const m = location.hash.match(/^#item\/([^/]+)\/(\d+)$/);
  if (m) showItem(decodeURIComponent(m[1]), Number(m[2]));
})();
