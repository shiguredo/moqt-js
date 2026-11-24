# shaka-player vendor build

`shaka-player.experimental.js.gz` と `shaka-player.transmuxer-worker.js.gz` は、
開発環境で shaka-player をビルドしなくても `vp run dev` を起動できるようにする
ためのフォールバックです。

- 元 commit: `ef7e1bf63845df228665af0f93a77667fb84f8b0`
- 生成元: shaka-player の `python3 build/all.py --force --release` が出力する
  `dist/shaka-player.experimental.js` と `dist/shaka-player.transmuxer-worker.js`
- `SHAKA_DIST` を指定した場合は、そちらのビルドが優先されます
- 更新するときは同じ commit で shaka-player をビルドし、`gzip -9 -n` で置き換えます
- ライセンスはリポジトリの `LICENSE` と `THIRD_PARTY_LICENSES.md` を参照してください
