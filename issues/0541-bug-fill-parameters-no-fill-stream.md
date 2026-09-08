# Publisher が FILL_PARAMETERS を受理したら fill fetch ストリームを開くか拒否する

- Created: 2026-09-08
- Completed: YYYY-MM-DD
- Branch: feature/fix-fill-parameters-publisher
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-transport-20 §5.1.3.1 は「A publisher opens a fill fetch stream when it processes a SUBSCRIBE or REQUEST_UPDATE that carries FILL_PARAMETERS while Forward State is 1.」と定める。現状は REQUEST_UPDATE の FILL_PARAMETERS を受理して REQUEST_OK を返しながら fill fetch ストリームを開かないため、購読側が fill を待ち続ける。

## 現状

- `src/session/bidi.ts` の publish ロールの REQUEST_UPDATE 処理は、FILL_PARAMETERS を含む更新を検証通過後に受理し、空パラメータの REQUEST_OK を返す。コード上のコメントも「moqt-js は publisher として fill ストリームを開かない」「accept-then-ignore」と明記している。
- publisher が fill fetch ストリームを開く実装は存在せず、`createUnidirectionalStream` は subgroup 送信でのみ使われる。
- 仕様上、受理して開かないのは購読側のハングを招く。

## 設計方針

1. まず publisher 側で FILL_PARAMETERS を含む SUBSCRIBE / REQUEST_UPDATE を受理しない方針とし、§10.9.1 に従って REQUEST_ERROR と PUBLISH_DONE(UPDATE_FAILED) を返す。既存の `bidiTerminatePublishSubscriptionWithUpdateFailed` を再利用する。
2. fill fetch ストリーム送信の実装は別 issue に分離する（本 issue は「受理して黙殺」をやめて明示的に拒否するところまで）。
3. 高レベル API / README の FILL_PARAMETERS 対応記述を見直し、publisher 側が非対応であることを明確にする。
4. FILL_PARAMETERS を含む REQUEST_UPDATE が REQUEST_ERROR + PUBLISH_DONE(UPDATE_FAILED) になるテストを追加する。

## 完了条件

- publisher が FILL_PARAMETERS を含む更新を黙殺しないこと（拒否応答を返すこと）。
- 購読側が fill 完了を待ち続けないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §5.1.3 / §5.1.3.1 / §10.2.15 / §10.9.1
- `bidiReadRequestStreamMessages`
- `bidiTerminatePublishSubscriptionWithUpdateFailed`
