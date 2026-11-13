// Anında kaydedilen işlemlerin (yapılacaklar, zindan sayaçları, harcamalar) ortak giriş noktası.
// Her op hem yerelde (hemen göstermek için) hem de kaydederken uzaktaki güncel dosyaya uygulanır.

import { applyTodoOp, todoCommitMessage } from './todos.js';
import { applyDungeonOp, dungeonOpMessage } from './dungeons.js';

export function applyOp(data, op) {
  const r = applyDungeonOp(data, op);
  return r === null ? applyTodoOp(data, op) : r;
}

export function opMessage(op, data, by) {
  return op.type.startsWith('dungeon') || op.type.startsWith('energy')
    ? dungeonOpMessage(op, data, by)
    : todoCommitMessage(op, data, by);
}
