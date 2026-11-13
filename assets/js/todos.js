// Ortak yapılacaklar listesi: data.json → todos: [{ id, text, done, by, at, doneBy, doneAt }]
//
// Her işlem bir "op" olarak tanımlanır ve hem yerelde hem de kaydederken uzaktaki EN GÜNCEL
// dosyanın üstüne uygulanır. Böylece iki kişi aynı anda işlem yapsa da kimsenin maddesi kaybolmaz.
//   { type: 'add', item }               → yeni madde (aynı id varsa tekrar eklenmez)
//   { type: 'toggle', id, done, by, at } → işaretle / işareti kaldır
//   { type: 'delete', id }               → sil
//   { type: 'clearDone' }                → tamamlananların hepsini sil

import { esc, fmtAgo } from './render.js';

export const MAX_TODO = 200;

export function newTodo(text, by) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  return { id, text: String(text).trim().slice(0, MAX_TODO), done: false, by: by || null, at: new Date().toISOString() };
}

// data'yı yerinde değiştirir; bir şey değiştiyse true döner.
export function applyTodoOp(data, op) {
  data.todos ||= [];
  const list = data.todos;
  const i = op.id ? list.findIndex((t) => t.id === op.id) : -1;
  switch (op.type) {
    case 'add':
      if (list.some((t) => t.id === op.item.id)) return false;
      list.push({ ...op.item });
      return true;
    case 'toggle':
      if (i < 0 || list[i].done === op.done) return false;
      list[i] = op.done
        ? { ...list[i], done: true, doneBy: op.by || null, doneAt: op.at }
        : (({ doneBy, doneAt, ...rest }) => ({ ...rest, done: false }))(list[i]);
      return true;
    case 'delete':
      if (i < 0) return false;
      list.splice(i, 1);
      return true;
    case 'clearDone': {
      const before = list.length;
      data.todos = list.filter((t) => !t.done);
      return data.todos.length !== before;
    }
    default:
      return false;
  }
}

export function todoCommitMessage(op, data, by) {
  const who = by ? ` (${by})` : '';
  const short = (s) => (s.length > 50 ? `${s.slice(0, 50)}…` : s);
  const textOf = (id) => short(data.todos?.find((t) => t.id === id)?.text || '');
  switch (op.type) {
    case 'add': return `Yapılacak eklendi: ${short(op.item.text)}${who}`;
    case 'toggle': return `Yapılacak ${op.done ? 'tamamlandı' : 'geri açıldı'}: ${textOf(op.id)}${who}`;
    case 'delete': return `Yapılacak silindi${who}`;
    case 'clearDone': return `Tamamlanan yapılacaklar temizlendi${who}`;
    default: return `Yapılacaklar güncellendi${who}`;
  }
}

export function renderTodos(root, data, { editable, pending }) {
  const todos = data.todos || [];
  const open = todos.filter((t) => !t.done);
  const done = todos.filter((t) => t.done).sort((a, b) => Date.parse(b.doneAt || 0) - Date.parse(a.doneAt || 0));
  const dis = editable ? '' : 'disabled';

  const item = (t) => `
    <li class="todo ${t.done ? 'done' : ''}" data-id="${esc(t.id)}">
      <label class="todo-main">
        <input type="checkbox" class="todo-check" ${t.done ? 'checked' : ''} ${dis} aria-label="Tamamlandı">
        <span class="todo-text">${esc(t.text)}</span>
      </label>
      <span class="todo-meta" title="${esc(t.at || '')}">${esc(t.done ? `✓ ${t.doneBy || ''} · ${fmtAgo(t.doneAt)}` : `${t.by || ''} · ${fmtAgo(t.at)}`)}</span>
      ${editable ? '<button type="button" class="todo-del" title="Sil" aria-label="Sil">✕</button>' : ''}
    </li>`;

  root.innerHTML = `
    <div class="todo-head">
      <h2>Yapılacaklar <span class="muted">${open.length} açık${done.length ? ` · ${done.length} tamamlandı` : ''}</span></h2>
      ${pending ? '<span class="todo-sync">kaydediliyor…</span>'
    : editable ? '<span class="todo-live" title="Değişiklikler 15 saniyede bir otomatik yenilenir">● canlı</span>' : ''}
    </div>
    ${editable ? `
    <form class="todo-form" id="todo-form">
      <input type="text" id="todo-input" maxlength="${MAX_TODO}" placeholder="Yeni madde yaz ve Enter'a bas…" autocomplete="off">
      <button type="submit" class="btn primary">Ekle</button>
    </form>` : '<p class="hint">Liste eklemek ve düzenlemek için giriş yap.</p>'}
    ${todos.length ? `
    <ul class="todo-list">${open.map(item).join('')}</ul>
    ${done.length ? `
    <details class="todo-done" ${done.length <= 3 ? 'open' : ''}>
      <summary>Tamamlananlar (${done.length})</summary>
      <ul class="todo-list">${done.map(item).join('')}</ul>
      ${editable ? '<button type="button" class="btn sm" id="todo-clear">Tamamlananları temizle</button>' : ''}
    </details>` : ''}` : '<p class="hint todo-empty">Liste boş.</p>'}`;
}
