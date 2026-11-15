// Giriş sistemi: GitHub token'ı her hesabın şifresiyle ayrı ayrı şifrelenip data.json → auth'a yazılır.
// Gerçek token ve şifreler hiçbir yerde saklanmaz; doğru şifre girilince token tarayıcıda çözülür.
//
// Şifreleme: PBKDF2-SHA256 (600.000 tur) ile şifreden anahtar → AES-GCM 256.
// Kullanıcı adı "ek veri" (AAD) olarak bağlanır: bir hesabın kaydı başka kullanıcı adıyla açılamaz.
//
// data.json:
//   "auth": { "v": 1, "iterations": 600000, "accounts": [ { "user", "salt", "iv", "ct" } ] }
// Çözülen içerik: { token, owner, repo, branch }

const enc = new TextEncoder();
const dec = new TextDecoder();
export const DEFAULT_ITERATIONS = 600_000;
export const MIN_PASSWORD = 10;

const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const normUser = (u) => String(u || '').trim().toLowerCase();

function subtle() {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Tarayıcı şifrelemeyi desteklemiyor. Site https:// (GitHub Pages) ya da localhost üzerinden açılmalı.');
  }
  return globalThis.crypto.subtle;
}

async function deriveKey(password, salt, iterations) {
  const base = await subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptAccount(user, password, payload, iterations = DEFAULT_ITERATIONS) {
  const u = normUser(user);
  if (!u) throw new Error('Kullanıcı adı boş olamaz');
  if (String(password).length < MIN_PASSWORD) throw new Error(`"${u}" için şifre en az ${MIN_PASSWORD} karakter olmalı`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iterations);
  const ct = new Uint8Array(await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(u) },
    key,
    enc.encode(JSON.stringify(payload)),
  ));
  return { user: u, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

const BAD_LOGIN = 'Kullanıcı adı ya da şifre hatalı';

export async function unlock(auth, user, password) {
  const u = normUser(user);
  const acc = (auth?.accounts || []).find((a) => a.user === u);
  // Kullanıcı yoksa da aynı süre/hata: hangi kullanıcı adlarının var olduğu belli olmasın.
  const iterations = auth?.iterations || DEFAULT_ITERATIONS;
  const target = acc || { salt: b64(new Uint8Array(16)), iv: b64(new Uint8Array(12)), ct: b64(new Uint8Array(32)) };
  try {
    const key = await deriveKey(password, unb64(target.salt), iterations);
    const plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: unb64(target.iv), additionalData: enc.encode(u) },
      key,
      unb64(target.ct),
    );
    if (!acc) throw new Error(BAD_LOGIN);
    const payload = JSON.parse(dec.decode(plain));
    if (!payload?.token) throw new Error(BAD_LOGIN);
    return { user: u, ...payload };
  } catch {
    throw new Error(BAD_LOGIN);
  }
}

export const hasAccounts = (data) => (data?.auth?.accounts || []).length > 0;

// ---- Oturum (çözülmüş token) ----
// "Beni hatırla" işaretliyse localStorage (tarayıcı kapanınca da kalır), değilse sessionStorage (sekme kapanınca silinir).
const KEY = 'aion2.session';
const store = (s) => { try { return s(); } catch { return null; } };

// Masaüstü uygulaması: veri kullanıcının kendi bilgisayarında; giriş/hesap yok, kullanıcı adı uygulamadan gelir.
export const APP = typeof location !== 'undefined' && location.hostname === 'app.karip';
let appUser = 'ben';
export function setAppUser(name) { if (name) appUser = name; }
export function getSession() {
  if (APP) return { user: appUser, token: 'local', owner: 'local', repo: 'local', branch: 'main' };
  const raw = store(() => sessionStorage.getItem(KEY)) || store(() => localStorage.getItem(KEY));
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export function setSession(session, remember) {
  clearSession();
  const raw = JSON.stringify(session);
  store(() => (remember ? localStorage : sessionStorage).setItem(KEY, raw));
}
export function clearSession() {
  store(() => sessionStorage.removeItem(KEY));
  store(() => localStorage.removeItem(KEY));
  store(() => localStorage.removeItem('aion2.token')); // eski sürümden kalan token
}
