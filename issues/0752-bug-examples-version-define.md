# examples のページが `__MOQT_JS_VERSION__` の未定義で読み込みの時点で止まる

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-examples-version-define
- Polished: {YYYY-MM-DD}

## 目的

`examples/high-level-api` のページを開くと、`ReferenceError: __MOQT_JS_VERSION__ is not defined` でモジュールの評価が止まり、ボタンを押しても何も起きない。examples は moqt-js のソースを直接参照するが、ソースの `src/version.ts` が参照するバージョン定数を埋め込んでいない。高レベル API (`createMediaPublisher` / `createMediaSubscriber`) の動作を手元で確かめる手段が使えない。

## 現状

- `src/version.ts` は `declare const __MOQT_JS_VERSION__: string` を `version` として export する。値はビルドの `define` で埋め込む
- ルートの `vite.config.ts` と `devtools/vite.config.ts` は `define` で `__MOQT_JS_VERSION__` に `package.json` の version を埋め込む
- `examples/vite.config.ts` は `moqt-js` を `../src/index.ts` へ alias するが、`define` が無い

## 再現手順

1. `vp run dev:examples` で examples の開発サーバーを起動する
2. `http://localhost:5174/high-level-api/` を開く
3. console に `__MOQT_JS_VERSION__ is not defined` が出て、Start Publish / Start Subscribe を押しても何も起きない

## 設計方針

- `examples/vite.config.ts` に、`devtools/vite.config.ts` と同じく `define` で `__MOQT_JS_VERSION__` を `package.json` の version から埋め込む

## 完了条件

- examples の開発サーバーでページを開いて、console にエラーが出ず、Start Subscribe で接続を始める
- `vp run build:examples` が通る
- `vp check` / `tsc --noEmit` / `vp test run` が通る
