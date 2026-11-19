import { cp } from 'node:fs/promises';

// HTML・CSS・同梱ライブラリは変換せず、生成したブラウザ用 JS と同じディレクトリに置く。
await cp(new URL('../public/', import.meta.url), new URL('../dist/public/', import.meta.url), {
  recursive: true
});
