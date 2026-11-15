import * as gh from './github.js';
import {
  unlock, encryptAccount, hasAccounts, getSession, setSession, clearSession, normUser, DEFAULT_ITERATIONS, MIN_PASSWORD,
} from './auth.js';
import { applyEnergyEdits, editTime } from './merge.js';
import { renderTodos, newTodo } from './todos.js';
import { applyOp, opMessage } from './ops.js';
import { adjustEnergy, setEnergy, adjustBonus, setBonus, energyCfg, spendEnergy } from './energy.js';
import {
  renderCards, updateEnergyLive, renderCompare, effEnergy, fmtAgo, fmtDate, esc, itemDetailHtml, charDialogHtml, CHAR_TABS,
} from './render.js';
import { renderBosses, fireNotifications, bossById, parseKillInput } from './bosses.js';
import { renderHome } from './home.js';
import { LOCAL, bridge, refreshBridge, appApi, appChip, renderAppView } from './izleyici.js';
import { APP, initLocalApp, loadAppUser, openAddCharacter, removeCharacter, refreshAll } from './local-app.js';
let appVersion = '';

const $ = (s) => document.querySelector(s);
const LS_EDITS = 'aion2.edits';
const LS_VIEW = 'aion2.view';
const LS_SORT = 'aion2.sort';
const LS_BOSS = 'aion2.bossPrefs';

const VIEWS = ['home', 'cards', 'bosses', 'todos', 'compare', 'app'];
const VIEW_TITLES = { home: 'Genel bakış', cards: 'Karakterler', bosses: 'Bosslar', todos: 'Yapılacaklar', compare: 'Karşılaştırma', app: 'Uygulama' };

const state = {
  data: null,       // uzaktaki (kaydedilmiş) veri — bekleyen düzenlemeler HARİÇ
  sha: null,        // data.json'un son bilinen SHA'sı (sadece API'den okununca)
  etag: null,       // canlı yenileme için son ETag
  source: null,     // 'api' | 'pages'
  edits: loadEdits(), // { [charId]: { value, setAt, setBy } } — kaydedilmemiş enerji girişleri
  login: getSession()?.user || null, // giriş yapan site kullanıcısı (commit mesajlarında görünür)
  view: VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : (VIEWS.includes(lsGet(LS_VIEW)) ? lsGet(LS_VIEW) : 'home'),
  sortKey: lsGet(LS_SORT) || 'itemLevel',
  busy: false,
  boss: { filter: 'all', onlyWatched: false, lead: 5, ...(() => { try { return JSON.parse(localStorage.getItem(LS_BOSS) || '{}'); } catch { return {}; } })() },
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
      const f = await gh.getFileIfChanged(null);
      state.data = JSON.parse(f.text);
      state.sha = f.sha;
      state.etag = f.etag;
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
  if (APP) { $('#login').hidden = true; $('#app').hidden = false; return; }
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
    const sess = { user: s.user, token: s.token, owner: s.owner, repo: s.repo, branch: s.branch || 'main' };
    setSession(sess, LOCAL || $('#login-remember').checked);
    // Uygulama penceresindeyse: ekran izleyici de aynı hesapla bağlansın (tek giriş).
    if (LOCAL) appApi.session(sess).then(refreshApp).catch((er) => status(`Uygulamaya bağlanılamadı: ${esc(er.message)}`, 'error'));
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
  $('#side-sub').textContent = ['AION 2', cfg.server, (cfg.regionCode || '').toUpperCase()].filter(Boolean).join(' · ');
  $('#sample-banner').hidden = !(d.sample || (d.characters || []).some((c) => c.sample));

  renderTodosNow();
  renderCards($('#view-cards'), d, ctx());
  if (APP) $('#view-cards').insertAdjacentHTML('beforeend', '<button type="button" class="card kt-add-card" data-kt-add>＋<span>Karakter ekle</span></button>');
  if (charDlg.open && charCur) showChar(charCur.id, charCur.tab); // veri yenilendiyse pencereyi de yenile
  if (state.view === 'compare') renderCompare($('#rank-table'), $('#gear-matrix'), d, state.sortKey, ctx());
  renderChrome();
  renderBossesNow();
  renderHomeNow();
  renderAppNow();
}

function renderChrome() {
  const editable = canEdit();
  const pill = $('#mode-pill');
  if (!pill.classList.contains('run')) {
    pill.textContent = APP ? `Kullanıcı: ${getSession()?.user || '?'}` : editable ? `Giriş: ${state.login || '?'}` : 'Salt okunur';
    pill.title = editable ? 'Tam yetki: enerji düzenleme ve gear güncelleme' : 'Giriş yapılmadı';
    pill.className = `pill ${editable ? 'edit' : ''}`;
  }
  $('#btn-save').hidden = !editable;
  $('#btn-fetch').hidden = !editable;
  const n = Object.keys(state.edits).length;
  $('#btn-save').disabled = !n || state.busy;
  $('#btn-save').textContent = n ? `Kaydet (${n})` : 'Kaydet';

  for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.view === state.view));
  for (const v of VIEWS) $(`#view-${v}`).hidden = state.view !== v;
  $('#page-title').textContent = VIEW_TITLES[state.view] || '';
  document.title = `${VIEW_TITLES[state.view] || ''} · Karip Traker`;
  $('#sort-key').value = state.sortKey;

  const r = gh.getRepo();
  $('#foot').innerHTML = [
    APP ? 'Veriler bu bilgisayarda (yerel)' : state.source === 'api' ? 'Kaynak: GitHub API (anlık)' : 'Kaynak: GitHub Pages (≈10 dk önbellekli olabilir)',
    APP ? `Karip Traker ${esc(appVersion || '')}` : r.owner && r.repo ? `<a href="https://github.com/${esc(r.owner)}/${esc(r.repo)}" style="color:inherit">${esc(r.owner)}/${esc(r.repo)}</a>` : 'repo ayarlı değil',
  ].join(' · ');
}

function tick() {
  if (!state.data) return;
  updateEnergyLive($('#view-cards'), state.data, ctx());
  renderHomeNow();
  if (state.view === 'compare') renderCompare($('#rank-table'), $('#gear-matrix'), state.data, state.sortKey, ctx());
  renderBossesNow();
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
  // "Harca" butonları: önce zamanla dolan, sonra ek (+) kısımdan düşer.
  const sp = e.target.closest('[data-spend]');
  if (sp && canEdit()) {
    const id = sp.closest('.card').dataset.id;
    const ch = state.data.characters.find((c) => c.id === id);
    const r = spendEnergy(effEnergy(ch, state.edits), energyCfg(state.data, ch), Number(sp.dataset.spend));
    setEdit(id, { value: r.value, setAt: r.setAt, bonus: r.bonus });
    if (r.short) status(`${esc(ch.name)}: enerji yetmedi, ${r.short} eksik kaldı (değer 0'a indi).`, 'error');
    return;
  }
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

// ---------------- Yapılacaklar ----------------
// Her işlem anında ekrana yansır ve arka planda sırayla commit'lenir.
const pendingTodoOps = [];
let todoChain = Promise.resolve();

function renderTodosNow() {
  if (!state.data) return;
  const root = $('#todos');
  // Yazılmakta olan metni ve odağı koru (arka planda yenileme olabilir).
  const input = $('#todo-input');
  const draft = input?.value || '';
  const focused = document.activeElement === input;
  renderTodos(root, state.data, { editable: canEdit(), pending: pendingTodoOps.length > 0 });
  const again = $('#todo-input');
  if (again) { again.value = draft; if (focused) again.focus(); }
}

// Anında kaydedilen işlemler (yapılacaklar + zindan sayaçları) için ortak giriş.
function todoAction(op) {
  if (!canEdit() || !state.data) return;
  applyOp(state.data, op); // iyimser: hemen göster
  pendingTodoOps.push(op);
  renderTodosNow();
  renderBossesNow();
  if (charDlg.open && charCur) showChar(charCur.id, charCur.tab);
  todoChain = todoChain.then(() => commitTodo(op));
}
const dataAction = todoAction;

async function commitTodo(op) {
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const f = await gh.getFile();
      const remote = JSON.parse(f.text);
      if (!applyOp(remote, op)) { adoptRemote(remote, f.sha, op); return; } // zaten uygulanmış / madde yok
      const msg = opMessage(op, remote, state.login); // uygulandıktan sonra: yeni değerler mesajda görünsün
      try {
        const r = await gh.putFile(gh.stringifyData(remote), f.sha, msg);
        adoptRemote(remote, r.sha, op);
        return;
      } catch (e) {
        if (e.status === 409 || (e.status === 422 && /sha/i.test(e.message))) continue;
        throw e;
      }
    }
    throw new Error('Dosya art arda değişti, tekrar dene');
  } catch (e) {
    pendingTodoOps.splice(pendingTodoOps.indexOf(op), 1);
    status(`Kaydedilemedi: ${esc(e.message)}`, 'error', true);
    await load();
  }
}

// Kaydedilen güncel dosyayı benimse; henüz kaydedilmemiş diğer işlemleri üstüne yeniden uygula.
function adoptRemote(remote, sha, doneOp) {
  pendingTodoOps.splice(pendingTodoOps.indexOf(doneOp), 1);
  for (const op of pendingTodoOps) applyOp(remote, op);
  state.data = remote;
  state.sha = sha;
  state.source = 'api';
  renderTodosNow();
  tick();
  checkBossNotifications();
  if (charDlg.open && charCur) showChar(charCur.id, charCur.tab); // zindan sayaçları vb.
}

$('#todos').addEventListener('submit', (e) => {
  if (e.target.id !== 'todo-form') return;
  e.preventDefault();
  const input = $('#todo-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  todoAction({ type: 'add', item: newTodo(text, state.login) });
  $('#todo-input')?.focus();
});
$('#todos').addEventListener('change', (e) => {
  const cb = e.target.closest('.todo-check');
  if (!cb) return;
  todoAction({ type: 'toggle', id: cb.closest('.todo').dataset.id, done: cb.checked, by: state.login, at: new Date().toISOString() });
});
$('#todos').addEventListener('click', (e) => {
  const del = e.target.closest('.todo-del');
  if (del) {
    const li = del.closest('.todo');
    const text = li.querySelector('.todo-text')?.textContent || '';
    if (confirm(`Silinsin mi?\n\n${text}`)) todoAction({ type: 'delete', id: li.dataset.id });
  }
  if (e.target.closest('#todo-clear') && confirm('Tamamlanan tüm maddeler silinsin mi?')) todoAction({ type: 'clearDone' });
});

// ---------------- Canlı yenileme ----------------
// Giriş yapılmışken 15 sn'de bir data.json değişti mi diye bakılır (ETag → değişmediyse 304, limitten düşmez).
// Değiştiyse: sadece liste değiştiyse listeyi, başka şey de değiştiyse tüm ekranı yeniler.
// Kullanıcı bir enerji kutusuna yazıyorsa kartlar o kutudan çıkana kadar yenilenmez.
const POLL_MS = 15_000;
let polling = false;
let deferredRender = false;

const withoutTodos = (d) => JSON.stringify({ ...d, todos: undefined });
const typingEnergy = () => !!document.activeElement?.closest?.('#view-cards input');

let hiddenPolls = 0;
async function poll() {
  if (document.hidden && (++hiddenPolls % 4)) return; // arka planda dakikada bir
  if (!hasAccess() || !state.data || polling || state.busy || pendingTodoOps.length) return;
  polling = true;
  try {
    const f = await gh.getFileIfChanged(state.etag);
    if (!f) return;                       // 304: değişiklik yok
    state.etag = f.etag;
    if (f.sha === state.sha) return;      // kendi kaydımız
    if (pendingTodoOps.length || state.busy) return; // bu arada bir kayıt başladı → sonraki turda
    const remote = JSON.parse(f.text);
    const todosOnly = withoutTodos(remote) === withoutTodos(state.data);
    state.data = remote;
    state.sha = f.sha;
    state.source = 'api';
    pruneEdits();
    checkBossNotifications();
    if (todosOnly) { renderTodosNow(); return; }
    if (typingEnergy()) { renderTodosNow(); tick(); deferredRender = true; return; }
    renderAll();
  } catch (e) {
    if (e.status === 401 || e.status === 403 || e.status === 404) load(); // oturum geçersiz → load girişe döndürür
  } finally {
    polling = false;
  }
}

setInterval(poll, POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
$('#view-cards').addEventListener('focusout', () => {
  setTimeout(() => { if (deferredRender && !typingEnergy()) { deferredRender = false; renderAll(); } }, 0);
});

// ---------------- Genel kayıt (masaüstü uygulaması ve izleyici kayıtları) ----------------
// mutator(data) güncel veriyi yerinde değiştirir; false dönerse yazılmaz.
async function commitMutation(mutator, message) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const f = await gh.getFile();
    const remote = JSON.parse(f.text);
    if (mutator(remote) === false) return false;
    try {
      const r = await gh.putFile(gh.stringifyData(remote), f.sha, message);
      state.data = remote; state.sha = r.sha; state.etag = r.sha; state.source = 'api';
      pruneEdits(); renderAll();
      return true;
    } catch (e) {
      if (e.status === 409) continue;
      throw e;
    }
  }
  throw new Error('Veri art arda değişti, tekrar dene.');
}

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
  if (APP) {
    btn.disabled = true;
    try { await refreshAll((t) => { pill.textContent = `Güncelleniyor: ${t}`; pill.className = 'pill run'; }); }
    catch (e) { status(`Güncellenemedi: ${esc(e.message)}`, 'error', true); }
    finally { btn.disabled = false; pill.classList.remove('run'); renderChrome(); }
    return;
  }
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
  if (LOCAL) appApi.logout().then(refreshApp).catch(() => {});
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
  $('#char-body').innerHTML = charDialogHtml(ch, tab, { editable: canEdit() })
    + (APP ? `<div class="row end kt-char-actions"><button type="button" class="btn danger" data-kt-remove="${esc(ch.id)}">Karakteri kaldır</button></div>` : '');
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

  // Zindanlar sekmesi: −1 / +1 / düzenle / sil
  const b = e.target.closest('[data-dg]');
  if (b && charCur && canEdit()) {
    const name = b.closest('[data-dungeon]').dataset.dungeon;
    const ch = state.data.characters.find((c) => c.id === charCur.id);
    const d = (ch.dungeons || []).find((x) => x.name === name);
    const base = { charId: ch.id, name, at: new Date().toISOString(), by: state.login };
    if (b.dataset.dg === 'inc') dataAction({ ...base, type: 'dungeonDelta', delta: 1 });
    if (b.dataset.dg === 'dec') dataAction({ ...base, type: 'dungeonDelta', delta: -1 });
    if (b.dataset.dg === 'del' && confirm(`${name} sayacı silinsin mi?`)) dataAction({ ...base, type: 'dungeonDelete' });
    if (b.dataset.dg === 'edit') {
      const v = prompt(`${name} — yeni değer (şu an / sınır):`, `${d?.count ?? 0}/${d?.max ?? ''}`);
      const m = v && v.match(/^\s*(\d+)\s*(?:\/\s*(\d+))?\s*$/);
      if (v != null && !m) status('Değer "16/28" biçiminde olmalı.', 'error');
      if (m) dataAction({ ...base, type: 'dungeonSet', count: Number(m[1]), max: Number(m[2] ?? d?.max ?? 0) });
    }
  }
});
charDlg.addEventListener('submit', (e) => {
  const f = e.target.closest('[data-dg-form]');
  if (!f || !charCur || !canEdit()) return;
  e.preventDefault();
  const fd = new FormData(f);
  const name = String(fd.get('name') || '').trim();
  if (!name) return;
  dataAction({
    type: 'dungeonSet', charId: charCur.id, name,
    count: Number(fd.get('count') || 0), max: Number(fd.get('max') || 0),
    at: new Date().toISOString(), by: state.login,
  });
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

// ---------------- Genel bakış ve Uygulama ----------------
function goView(v) {
  if (!VIEWS.includes(v)) return;
  state.view = v;
  lsSet(LS_VIEW, v);
  renderAll();
  window.scrollTo(0, 0);
  if (v === 'app') refreshApp();
}

function renderHomeNow() {
  if (!state.data || state.view !== 'home') return;
  renderHome($('#view-home'), state.data, { edits: state.edits, user: state.login, bridge });
}

let appSig = '';
function renderAppNow(force = true) {
  const sig = JSON.stringify([bridge.online, bridge.s]);
  if (!force && sig === appSig) return; // değişiklik yoksa yeniden çizme (fare üstündeki buton titremesin)
  appSig = sig;
  $('#app-chip').innerHTML = appChip(bridge);
  if (state.view === 'app') renderAppView($('#view-app'), bridge, { repo: gh.getRepo() });
  if (state.view === 'home') renderHomeNow();
}

async function refreshApp() {
  if (!LOCAL) return;
  await refreshBridge();
  renderAppNow(false);
}
if (LOCAL) setInterval(() => { if (!document.hidden) refreshApp(); }, 2000);

$('#view-home').addEventListener('click', (e) => {
  const g = e.target.closest('[data-go]');
  if (g) { goView(g.dataset.go); return; }
  const c = e.target.closest('[data-char]');
  if (c) showChar(c.dataset.char, 'gear');
});

$('#view-app').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-app], [data-app-char]');
  if (!b || b.disabled) return;
  b.disabled = true;
  try {
    if (b.dataset.appChar) await appApi.char(b.dataset.appChar);
    else if (b.dataset.app === 'pause') await appApi.pause(!bridge.s?.paused);
    else if (b.dataset.app === 'overlay') await appApi.overlay({ action: 'hub' });
    else if (b.dataset.app === 'neton' || b.dataset.app === 'netoff') await appApi.net({ action: 'enable', on: b.dataset.app === 'neton' });
    else if (b.dataset.app === 'netrec') await appApi.net({ action: 'record', on: !bridge.s?.net?.recording });
    else if (b.dataset.app === 'ovmode') await appApi.overlay({ action: 'edit' });
    else if (b.dataset.app === 'undo') {
      if (confirm('Son kutu kaydı geri alınsın mı? (Enerji ve garanti sayacı kutudan önceki haline döner.)')) await appApi.undo();
    } else if (b.dataset.app === 'test') {
      await appApi.test();
      status('Ekran okundu; sonuç Kayıtlar listesinde.', 'ok');
    }
  } catch (err) {
    status(`Uygulama: ${esc(err.message)}`, 'error');
  } finally {
    await refreshApp();
    renderAppNow(true);
  }
});

// ---------------- Bosslar ----------------
const notifState = () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
const saveBossPrefs = () => lsSet(LS_BOSS, JSON.stringify(state.boss));

function renderBossesNow() {
  if (!state.data || state.view !== 'bosses') return;
  const root = $('#view-bosses');
  if (root.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return; // açık listeyi kapatma
  renderBosses(root, state.data, {
    editable: canEdit(), user: state.login, notif: notifState(), ...state.boss,
  });
}

function checkBossNotifications() {
  if (!state.data || !state.login) return;
  fireNotifications(state.data, state.login, state.boss.lead, (title, body) => status(`🔔 <b>${esc(title)}</b> — ${esc(body)}`, 'ok', true));
}

$('#view-bosses').addEventListener('click', async (e) => {
  if (e.target.closest('#boss-notif')) {
    try { await Notification.requestPermission(); } catch { /* yoksay */ }
    renderBossesNow();
    if (notifState() === 'granted') {
      try { new Notification('Karip Traker', { body: 'Bildirimler açık. Takip ettiğin bosslar için haber vereceğim.' }); } catch { /* yoksay */ }
    }
    return;
  }
  const btn = e.target.closest('[data-boss]');
  if (!btn || !canEdit()) return;
  const id = btn.closest('.boss').dataset.id;
  const b = bossById(id);
  const act = btn.dataset.boss;
  if (act === 'watch') {
    const on = !(state.data.bosses?.watch?.[state.login] || []).includes(id);
    dataAction({ type: 'bossWatch', user: state.login, id, on });
  } else if (act === 'kill') {
    dataAction({ type: 'bossKill', id, at: new Date().toISOString(), by: state.login });
  } else if (act === 'time') {
    const v = prompt(`${b.name}\n\n• Ölüm saati: 14:35\n• Kaç dakika önce öldü: 25\n• Oyundaki kalan süre: +2:15 ya da +40`, '');
    if (v == null) return;
    const at = parseKillInput(v, b.respawn);
    if (at == null) { alert('Anlaşılmadı. Örnekler: 14:35 · 25 · +2:15'); return; }
    dataAction({ type: 'bossKill', id, at: new Date(at).toISOString(), by: state.login });
  } else if (act === 'reset' && confirm(`${b.name} sayacı silinsin mi?`)) {
    dataAction({ type: 'bossReset', id });
  }
});
$('#view-bosses').addEventListener('change', (e) => {
  if (e.target.id === 'boss-filter') state.boss.filter = e.target.value;
  else if (e.target.id === 'boss-only') state.boss.onlyWatched = e.target.checked;
  else if (e.target.id === 'boss-lead') state.boss.lead = Number(e.target.value);
  else return;
  saveBossPrefs();
  e.target.blur();
  renderBossesNow();
});
setInterval(() => { renderBossesNow(); checkBossNotifications(); }, 20_000);

// ---------------- Diğer olaylar ----------------
for (const t of document.querySelectorAll('.tab')) {
  t.addEventListener('click', () => {
    goView(t.dataset.view);
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
  if (APP) {
    appVersion = (await loadAppUser()).version || '';
    state.login = getSession()?.user || null;
    initLocalApp({ getData: () => state.data, commit: commitMutation, status });
    document.addEventListener('click', async (e) => {
      if (e.target.closest('[data-kt-add]')) { openAddCharacter(); return; }
      const rm = e.target.closest('[data-kt-remove]');
      if (rm && await removeCharacter(rm.dataset.ktRemove)) charDlg.close();
    });
    // Uygulamanın motorlarından (ekran/ağ okuma) gelen kayıtlar: sitenin kurallarıyla uygulanıp kaydedilir
    window.chrome?.webview?.addEventListener('message', async (ev) => {
      const m = ev.data;
      if (m?.type === 'ops' && Array.isArray(m.ops)) {
        try { await commitMutation((d) => { let any = false; for (const op of m.ops) any = applyOp(d, op) || any; return any; }, m.summary || 'Uygulama kaydı'); }
        catch (err) { status(`Uygulama kaydı yazılamadı: ${esc(err.message)}`, 'error'); }
        window.chrome.webview.postMessage({ type: 'opsDone', id: m.id });
      } else if (m?.type === 'reload') load();
    });
  }
  // Uygulama penceresinde: izleyicinin kayıtlı oturumu varsa site de onunla açılır (tek giriş).
  if (LOCAL && !APP) {
    await refreshBridge();
    if (!getSession()) {
      try {
        const s = await appApi.getSession();
        if (s?.token) { setSession(s, true); state.login = s.user; }
      } catch { /* oturum yok → giriş ekranı */ }
    }
  }
  await load();
  if (APP && !(state.data?.characters || []).length) openAddCharacter({ first: true });
  if (APP) window.chrome?.webview?.postMessage({ type: 'ready' });   // uygulama bekleyen kayıtları göndersin
  // Doğrudan bağlantılar:
  //   #char/<karakterId>/<sekme>  (ör. #char/kyrakia/skills)
  //   #item/<karakterId>/<sıra>   (ör. #item/kyrakia/0)
  const c = location.hash.match(/^#char\/([^/]+)(?:\/(\w+))?$/);
  if (c) showChar(decodeURIComponent(c[1]), c[2] || 'gear');
  const m = location.hash.match(/^#item\/([^/]+)\/(\d+)$/);
  if (m) showItem(decodeURIComponent(m[1]), Number(m[2]));
})();
