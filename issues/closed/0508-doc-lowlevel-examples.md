# LOW_LEVEL_API・examples の整合性を修正する

- Created: 2026-09-06
- Completed: 2026-09-13
- Branch: feature/fix-lowlevel-examples-doc
- Polished: YYYY-MM-DD

## 目的

低レベル文書の API 欠落、動かないサンプル既定値、XSS 性の描画が残る。文書間と現コードの整合が必要である。

## 現状

- `docs/LOW_LEVEL_API.md` に `subscribeTracks()` の記載がない (README は列挙する)。
- `docs/MSF.md` が古い HIGH_LEVEL_API.md へ誘導する (`0507` と連携)。
- `examples/high-level-api/index.html` の既定 URL `https://...` は現コードで即 throw される。
- `examples/high-level-api/main.ts` のログ描画が `innerHTML` で、証明書失敗の表示先が pub 固定である。

## 設計方針

1. 欠落 API を追記し、文書間の列挙を一致させる。
2. サンプル既定値を `moqt://` に直し、描画を `textContent` 構成にする。

## 完了条件

- 文書と現コードの API 列挙が一致し、サンプルが既定値で動くこと。
- `vp check` が通ること (markdownlint 対象のため)。

## 関連

- `0507` (HIGH_LEVEL_API 側の修正)

## 解決方法

設計方針 1・2 に従い、文書と現コードの列挙を一致させ、サンプルを既定値で動くようにした。

### 文書 (`docs/LOW_LEVEL_API.md`)

- `subscribeTracks()` をメソッド表に追加した。実装は `subscribeTracks(namespacePrefix, callbacks, options?)` で、README は列挙しているのに低レベル文書に記載が無かった。
- 冒頭の入口列挙 (`publish()` / `subscribe()` / `fetch()` / `trackStatus()` / `subscribeNamespace()` / `publishNamespace()`) にも `subscribeTracks()` を追加した。
- 内部実装の節に `subscribeTracks()` のループの説明を追加した (`REQUEST_OK` の後は prefix に一致する `PUBLISH` / `PUBLISH_SKIPPED` を受け続ける)。
- `publishNamespace` の引数に `options?` を補った。0507 で追加した `PublishNamespaceOptions` (authorizationToken) に対応する。

### `docs/MSF.md`

起票時は「古い HIGH_LEVEL_API.md へ誘導する」とされていたが、着手時の確認では `HIGH_LEVEL_API.md` への相対リンクと README のアンカー (`#moqt-streaming-format`) はいずれも有効だった (README 159 行目に `### MOQT Streaming Format` が存在)。修正不要と判断した。

### `examples/high-level-api/index.html`

- 既定 URL を `https://localhost:4433/moqt` から `moqt://localhost:4433/moqt` に修正した。現コードの `normalizeMoqtUri` は `moqt://` 以外を `url must start with moqt://` で throw するため、既定値のままでは「開始」ボタンが即失敗していた。`moqt://` + ポート番号は既存テスト (`moqt:// + ポート番号は保持される`) で検証されている形式である。

### `examples/high-level-api/main.ts`

- ログ描画を `innerHTML` から `textContent` に変更した。`log()` は URL・コーデック名・エラーメッセージなど外部入力由来の文字列を埋め込むため、HTML として解釈されない組み立てにした。`log-time` / `log-error` / `log-pub` / `log-sub` の CSS クラスは span 要素に付与して従来の見た目を保っている。`innerHTML` が残るのは `<select>` のクリア (`""` 代入) の 3 箇所のみで、いずれも固定の空文字列である。
- `getCertificateHashes()` に出力先 (`"pub" | "sub"`) を渡すようにした。従来は失敗ログが `log("pub", ...)` 固定で、購読側の証明書ハッシュ不正が publisher のログに出ていた。呼び出し元は `startPublishing` / `startSubscribing` の 2 箇所で、それぞれ `"pub"` / `"sub"` を渡す。

## 検証

- `vp check` が通る (フォーマット 798 ファイル / lint・型チェック 124 ファイル)
- `tsc -p examples/tsconfig.json --noEmit` が通る (examples は root の typecheck 対象外のため個別に確認)
- `pnpm test run`: 70 ファイル / 2,110 テスト全通過 (テストコードの変更なし)
- 差分: 3 ファイル、+22 / -8 行
