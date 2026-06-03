# PUBLISH_OK メッセージタイプ (0x1E) を削除し REQUEST_OK (0x7) に統一する

- Priority: High
- Created: 2026-05-13
- Completed: 2026-06-02
- Model: Opus 4.7
- Polished: 2026-06-02
- Branch: feature/draft-18

## 目的

draft-18 で PUBLISH_OK (0x1E) がメッセージタイプから削除され、PUBLISH リクエストへの成功応答も REQUEST_OK (0x7) で表現されるようになった。ワイヤーフォーマット上の重複メッセージタイプを整理する。

## 優先度根拠

- draft-18 準拠のための必須変更
- 存在しないメッセージタイプ (0x1E) を送信し続けるとサーバーとの相互運用に問題が生じる
- 破壊的変更だが影響範囲は限定的

## 現状

現在のコードベースでは PUBLISH への成功応答として PUBLISH_OK (0x1E) を使用している:

- `MessageType.PUBLISH_OK = 0x1E`
- `PublishOk` インターフェース (type: PUBLISH_OK)
- `encodePublishOkPayload` / `decodePublishOkPayload`

draft-ietf-moq-transport-18 §10.5:

> This document uses the shorthand PUBLISH_OK, REQUEST_UPDATE_OK,
> TRACK_STATUS_OK, SUBSCRIBE_NAMESPACE_OK and PUBLISH_NAMESPACE_OK to
> refer to a REQUEST_OK sent in response to the corresponding request
> type.

Wire format 上は REQUEST_OK (0x7) のみが存在し、PUBLISH_OK (0x1E) は廃止された。

## 設計方針

- `MessageType.PUBLISH_OK = 0x1E` を削除する
- `PublishOk` インターフェースの type を `MessageType.REQUEST_OK` に変更する
- 専用の `encodePublishOkPayload` / `decodePublishOkPayload` は維持し、内部実装を `encodeRequestOkPayload` / `decodeRequestOkPayload` に委譲する（API 互換性のため）
- あるいは完全に削除し、呼び出し元で `encodeRequestOkPayload` を直接使う
- PUBLISH 応答受信コードでは `MessageType.PUBLISH_OK` の代わりに `MessageType.REQUEST_OK` で判定する

## 完了条件

- `MessageType.PUBLISH_OK = 0x1E` が削除されている
- `PublishOk` 型の type が `MessageType.REQUEST_OK` になっている
- PUBLISH 応答のエンコード/デコードが REQUEST_OK (0x7) を使っている
- 全 PBT が PUBLISH_OK なしで成功する
- `git grep PUBLISH_OK` がヒットしない（型名としての PublishOk は除く）

## 変更内容

### 1. MessageType から PUBLISH_OK を削除 (`src/message/types.ts`)

- `PUBLISH_OK = 0x1E` を削除

### 2. PublishOk 型を REQUEST_OK ベースに変更 (`src/message/publish.ts`)

- `PublishOk.type` を `typeof MessageType.REQUEST_OK` に変更
- `encodePublishOkPayload` の実装を `encodeRequestOkPayload` の呼び出しに置換
- `decodePublishOkPayload` の実装を `decodeRequestOkPayload` の呼び出しに置換（戻り値の型は `PublishOk` のまま）

### 3. PUBLISH_OK 参照を REQUEST_OK に変更

- `src/session/bidi.ts` (`bidiReadPublishResponse`): `MessageType.PUBLISH_OK` → `MessageType.REQUEST_OK`
- `src/session.ts` (`readPublishResponse`): 同様
- PBT (`src/message/publish.prop.ts`): PUBLISH_OK のテストを REQUEST_OK に変更

## 該当箇所一覧

| ファイル                         | 変更内容                                                          |
| -------------------------------- | ----------------------------------------------------------------- |
| `src/message/types.ts`           | `PUBLISH_OK = 0x1E` を削除                                        |
| `src/message/publish.ts:44-47`   | `PublishOk` 型の type を `MessageType.REQUEST_OK` に変更          |
| `src/message/publish.ts:160-191` | `encodePublishOkPayload` の実装を `encodeRequestOkPayload` に委譲 |
| `src/message/publish.ts:181-191` | `decodePublishOkPayload` の実装を `decodeRequestOkPayload` に委譲 |
| `src/session/bidi.ts`            | `bidiReadPublishResponse`: PUBLISH_OK → REQUEST_OK                |
| `src/session.ts`                 | `readPublishResponse`: PUBLISH_OK → REQUEST_OK                    |
| `src/message/publish.prop.ts`    | PUBLISH_OK テストを REQUEST_OK に変更                             |

## テスト方針

- PBT: `PublishOk` のエンコード/デコードが REQUEST_OK (0x7) を使っていることのラウンドトリップ検証
- 単体: `MessageType` 定数から `PUBLISH_OK` が削除されていることの確認
- 既存の PUBLISH 応答受信テストが引き続き動作することを確認

## 影響範囲

- `MessageType.PUBLISH_OK` 定数が削除される（後方互換なし、参照コードはコンパイルエラー）
- PUBLISH 応答のワイヤーフォーマットが変わる（0x1E → 0x7、後方互換なし）

## 解決方法

- `MessageType.PUBLISH_OK = 0x1e` を削除（wire format 上は REQUEST_OK (0x7) のみに統一）
- `PublishOk` インターフェースの type を `MessageType.REQUEST_OK` に変更
- `bidiReadPublishResponse` で `MessageType.PUBLISH_OK` の代わりに `MessageType.REQUEST_OK` で判定
- PBT: PublishOk テストの型参照を REQUEST_OK に更新
