# docs/MSF.md を draft-01 向けに縮小更新する

- Priority: Medium
- Created: 2026-07-24
- Completed: YYYY-MM-DD
- Model: Composer
- Branch: feature/update-msf-md-draft-01
- Polished: YYYY-MM-DD

## 目的

`docs/MSF.md` が draft-00 / transport-15 前提のまま残っており、存在しない `refs/moq/draft-ietf-moq-msf.md` や撤廃済み `options.gzip` を参照している。正本 `refs/moq/draft-ietf-moq-msf-01.txt` に合わせ、陳腐化した記述を削除して現行 API への短いポインタに縮小する。

## 優先度根拠

ドキュメント信頼性が損なわれている。コード追従自体は `#0316` 等で進んでいるが、docs が旧仕様を示すと実装者・利用者が誤る。コード変更を伴わないため Medium。

## 現状

- 正本は `refs/moq/draft-ietf-moq-msf-01.txt`（`.md` はリポジトリに無い）
- `docs/MSF.md` に draft-00 の `deltaUpdate` boolean / `addTracks` / `initData`、transport-15 読み替え表、`options.gzip`、存在しない `createMsfPublisher` 等が残る
- Timeline の `options.gzip` はコードから撤廃済み（`#0316`）
- README の MSF 節は `54d350a` で draft-01 向け更新済み。本 issue の対象外

## 設計方針

1. 全面の仕様再録ではなく **縮小**する
2. 正本参照を `refs/moq/draft-ietf-moq-msf-01.txt` に差し替える
3. draft-00 記述・存在しない `.md`・transport-15 表・`options.gzip`・存在しない `createMsfPublisher` 等を削除する
4. 現行公開 API（`createMediaPublisher` / `createMediaSubscriber` / Catalog helper）への短いポインタを残す
5. README は更新しない
6. `CHANGES.md` には書かない（changelog 規約: `.md` 変更は CHANGES 非記載）

## 完了条件

- `docs/MSF.md` から draft-00 / 存在しない `refs/moq/draft-ietf-moq-msf.md` 前提の記述が消えている
- 正本パスと現行 API へのポインタが残っている

## 解決方法

1. `docs/MSF.md` を上記方針で書き換え・削除する

## 関連

- `#0316` (closed) MSF draft-01 コード追従
- `#0345` Catalog delta / Joining FETCH（本 docs 更新とは独立）
- `refs/moq/draft-ietf-moq-msf-01.txt`
