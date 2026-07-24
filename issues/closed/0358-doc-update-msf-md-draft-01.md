# docs/MSF.md を draft-01 向けに縮小更新する

- Priority: Medium
- Created: 2026-07-24
- Completed: 2026-07-24
- Model: Composer
- Branch: feature/update-msf-md-draft-01
- Polished: 2026-07-24

## 目的

`docs/MSF.md` が draft-00 / transport-15 前提のまま残っており、存在しない `refs/moq/draft-ietf-moq-msf.md` や撤廃済み gzip API、存在しない `createMsfPublisher` などを参照している。正本 `refs/moq/draft-ietf-moq-msf-01.txt` と現行公開 API への短い入口に縮小し、誤誘導を止める。

## 優先度根拠

ドキュメント信頼性が損なわれている。コード追従自体は `#0316` 等で進んでいるが、docs が旧仕様を示すと実装者・利用者が誤る。コード変更を伴わないため Medium。

## 現状

- 正本は `refs/moq/draft-ietf-moq-msf-01.txt`（`.md` はリポジトリに無い）
- `docs/MSF.md`（約 330 行）に次が残る:
  - 存在しない `refs/moq/draft-ietf-moq-msf.md`（L7）
  - transport-15 読み替え表・`SUBSCRIBE_DONE` 読み替え説明（L9–L21）。Filter Type 名も transport-19 と不一致
  - draft-00 Catalog: `version` Number、`deltaUpdate` Boolean、`addTracks` / `removeTracks` / `cloneTracks`、track 直下 `initData`（L54–L76）
  - Timeline の draft-00 gzip 文、「gzip 圧縮してよい」、`options.gzip`、decode の gzip マジック自動展開（L168 / L191–L220）
  - `## 概要` / `## 構成要素`、および仕様再録（Catalog 表・JSON 例・メディア伝送・ワークフロー・レイテンシレベル）
  - 実装状況表の誤名 `decodeCatalog()`（実体は `decodeCatalogMessage`）、未実装扱いの `createMsfPublisher` / `createMsfSubscriber`（L269 / L286）。高レベル API は既に `createMediaPublisher` / `createMediaSubscriber` として実装済み
  - 偽 API サンプル `createMsfPublisher` / `createMsfSubscriber`（L303–L332）
  - ワークフロー終了手順の再録: MSF-01 §11.3 はまだ `SUBSCRIBE_DONE`（参照 transport-18）、transport-19 は `PUBLISH_DONE`（§10.11）。再録を残すと誤誘導が続く
- Timeline の `options.gzip` と gzip マジック自動検出はコードから撤廃済み（`#0316`、`src/msf.ts`）。仕様上の代替は MSF_COMPRESSION（§5.5 / §7.1 / §8.1 / §12.1）だが実装は pending `#0355`
- draft-01 への破壊的差分（docs から消す根拠。正本の節番号のみ）: §5.1.1 / §5.1.6 / §5.1.7 / §5.2.13 / §12.1
- README の MSF 節は `54d350a` で draft-01 向け更新済み。本 issue の対象外
- 高レベル API の詳細は既に `docs/HIGH_LEVEL_API.md`。本 issue では変更しない

## 設計方針

1. **仕様再録しない。入口に縮小する。** フィールド表・JSON 例・メディア伝送・ワークフロー・レイテンシレベル・実装状況の詳細表は書かない
2. **完成する `docs/MSF.md` に issue 番号（`#NNNN`）を書かない**（`shiguredo-issues`）
3. **下記「完成文面」は docs にそのまま載せる本文だけとする。** パス規約・禁則・検証手順などのメタは完成文面の外（本節・完了条件・解決方法）に置く
4. **リンクの採用形を固定する:** 正本・HIGH_LEVEL・README は Markdown リンクにする。リポジトリパスをバッククォートだけで併記しない
5. 完成文面（このブロックを `docs/MSF.md` の中身にする。これ以外の見出しは残さない）:

```markdown
# MOQT Streaming Format (MSF)

MOQT Streaming Format (MSF) は、Media Over QUIC Transport (MOQT) 上で
メディアコンテンツを配信するためのストリーミングフォーマットである。
フィールド定義・ワイヤ形式・手順の詳細は正本を参照すること。本ドキュメントは
moqt-js からの入口のみを示す。

## 仕様参照

- 正本: [`refs/moq/draft-ietf-moq-msf-01.txt`](../refs/moq/draft-ietf-moq-msf-01.txt)
- 公開版: [draft-ietf-moq-msf-01](https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf-01)
- LOC: [draft-ietf-moq-loc-04](https://datatracker.ietf.org/doc/html/draft-ietf-moq-loc-04)

## moqt-js での公開 API

- 高レベル: [`createMediaPublisher`](HIGH_LEVEL_API.md) / [`createMediaSubscriber`](HIGH_LEVEL_API.md)
- Catalog（主要エントリポイント）: `encodeCatalog` / `encodeCatalogDelta` / `decodeCatalogMessage` / `applyCatalogDelta` / `createCatalog` / `createCompleteCatalog` / `MSF_VERSION` / `CATALOG_TRACK_NAME`（`src/msf.ts`）
- Timeline（いずれも `async`）: `encodeMediaTimeline` / `decodeMediaTimeline` / `encodeEventTimeline` / `decodeEventTimeline`（`src/msf.ts`）
- 現行 Timeline encode/decode は無圧縮 JSON のみ。ペイロード圧縮のシグナリングは仕様の MSF_COMPRESSION（未実装）
- draft-00 の Catalog wire 形式および Timeline 圧縮オプションとは非互換
- 実装状況の詳細は [README の MOQT Streaming Format 節](../README.md#moqt-streaming-format) を参照

## 関連ドキュメント

- [高レベル API](HIGH_LEVEL_API.md)
- [README の MOQT Streaming Format 節](../README.md#moqt-streaming-format)
```

6. 現行から削除する内容（完成文面に無い見出しはすべて削除）:
   - 存在しない `.md` 参照、github.com/moq-wg/msf のみの曖昧リンク
   - `## draft-15 での変更点`、`## 概要`、`## 構成要素`
   - Catalog / Timeline のフィールド表・JSON 例・gzip 関連記述
   - `## メディア伝送` / `## ワークフロー` / `## レイテンシレベル`
   - `## moqt-js 実装状況` / `## moqt-js での実装方針` / `### 期待される API`
7. **圧縮:** draft-00 の裸 gzip / encode オプション gzip / decode 自動展開はすべて削除。MSF_COMPRESSION の仕様再録はしない（実装は `#0355`）。完成文面の禁則語なし一文のみ
8. **transport メッセージ名:** 読み替え表も説明も書かない。本 docs ではメッセージ名を再録しない。実装側の名称は transport-19 対応のコード / README を見よ
9. 変更ファイルは `docs/MSF.md` のみ。README・`CHANGES.md`・`src/`・テストは触らない（changelog 規約: `.md` 変更は CHANGES 非記載）

## 完了条件

- 変更ファイルは `docs/MSF.md` のみ。ランタイム・公開 API への影響なし。テスト追加・変更は不要
- `docs/MSF.md` の本文が上記「完成文面」と実質同一（メタ注記・禁則語・issue 番号が混入していない）
- 完成文面に無い見出し（`## Catalog` / `## 概要` / `## ワークフロー` 等）が残っていない
- 次が残っていないこと（`rg`。`decodeCatalogMessage` は許容。旧名は括弧付きのみ禁則）:
  - `refs/moq/draft-ietf-moq-msf.md`
  - `draft-15` / `SUBSCRIBE_DONE` / `LatestGroup` / `LatestObject`
  - `addTracks` / `removeTracks` / `cloneTracks` / `deltaUpdate`
  - `options.gzip` / `gzip: true` / `0x1F` / `0x8B` / 「gzip 圧縮してよい」
  - `decodeCatalog()`
  - `createMsfPublisher` / `createMsfSubscriber`
  - `#0316` / `#0355` / その他 `#` + 数字の issue 番号
- Markdown リンクが解決する: `../refs/moq/draft-ietf-moq-msf-01.txt`、`HIGH_LEVEL_API.md`、`../README.md#moqt-streaming-format`、datatracker 絶対 URL
- `decodeCatalogMessage` があり、`createMediaPublisher` / `createMediaSubscriber` への誘導がある

## 解決方法

`docs/MSF.md` を設計方針の「完成文面」で全文置き換えた（約 330 行 → 26 行）。

- 変更ファイルは `docs/MSF.md` のみ。`README.md` / `CHANGES.md` / `src/` / テストは未変更
- 旧見出し（`## draft-15 での変更点` / `## 概要` / `## Catalog` / `## ワークフロー` / `## moqt-js 実装状況` 等）と gzip / `createMsfPublisher` 等の禁則語を削除した
- 正本 `refs/moq/draft-ietf-moq-msf-01.txt`、公開版 datatracker、LOC-04、`createMediaPublisher` / `createMediaSubscriber`、`decodeCatalogMessage` への誘導を残した
- 完了条件の禁則を `rg` で確認し、相対リンク先（正本・HIGH_LEVEL_API・README アンカー）の実在を確認した
- `.md` のみの変更のため `CHANGES.md` は追記していない（changelog 規約）

## 関連

- `#0316` (closed) MSF draft-01 コード追従
- `#0345` (closed) から docs 縮小を本 issue へ切り出し
- `#0355` (pending) MSF_COMPRESSION（docs 本文には issue 番号を書かない）
- `refs/moq/draft-ietf-moq-msf-01.txt`
- `docs/HIGH_LEVEL_API.md` / README の MSF 節（本 issue では変更しない）
