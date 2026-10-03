// src/db/tx.js
//
// node:sqlite 没有 better-sqlite3 的 db.transaction()。
// 这里自己实现，支持嵌套（用 SAVEPOINT），同步函数专用。
//
const { db } = require('./index');

let depth = 0;

function transaction(fn) {
  return (...args) => {
    const isOuter = depth === 0;
    const sp = `sp_${depth}`;

    if (isOuter) db.exec('BEGIN IMMEDIATE');
    else         db.exec(`SAVEPOINT ${sp}`);

    depth++;
    try {
      const result = fn(...args);
      depth--;
      if (isOuter) db.exec('COMMIT');
      else         db.exec(`RELEASE ${sp}`);
      return result;
    } catch (err) {
      depth--;
      try {
        if (isOuter) db.exec('ROLLBACK');
        else {
          db.exec(`ROLLBACK TO ${sp}`);
          db.exec(`RELEASE ${sp}`);
        }
      } catch (rollbackErr) {
        console.error('[tx] rollback failed:', rollbackErr);
      }
      throw err;
    }
  };
}

module.exports = { transaction };