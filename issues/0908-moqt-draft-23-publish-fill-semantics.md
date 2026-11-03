# PUBLISH の FILL_PARAMETERS を受理して初期 fill fetch に関連付ける

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-publish-fill-semantics
- Polished: {YYYY-MM-DD}

## 目的

draft 23 §3.4 / §3.4.1 / §9.8 は PUBLISH による初期 fill を追加した。PUBLISH の送信側が FILL_PARAMETERS を提示して fill fetch を開き、その Request ID で購読側が受け取る。現在は許可集合で拒否し、受信先も登録できない。

## 現状

- `src/message/parameterScope.ts` の `PUBLISH_ALLOWED_PARAMS` は FILL_PARAMETERS を含まない
- `src/session/incomingPublish.ts` の `incomingPublishHandleBidirectionalStream` は初期 fill を登録しない
- `src/session/bidi.ts` の `fillFetchTargets` / `registerRawFillFetchTarget` は SUBSCRIBE や REQUEST_UPDATE 起点の関連付けを持つ
- `src/session/params.ts` の `buildPublishParameters` と `PublishOptions` に初期 fill は無い。クライアント publisher は現在、履歴 Object の保存や fill fetch の送信機能を持たない

## 設計方針

- 受信 PUBLISH の FILL_PARAMETERS を正規のパラメータとして検証し、PUBLISH Request ID で初期 fill の受信先を登録する。LARGEST_OBJECT は PUBLISH から解決する
- fill 内側のフィルタ、Group Order、timeout、通常購読との独立した範囲を保持する。PAUSED 中に不要な待機先を残さない
- fill stream が PUBLISH の処理より先に到着する場合も、既存の先着データ処理と合わせて関連付ける。取消し・拒否・GOAWAY・Session 終了で待機状態を解放する
- publisher 送信 API に `fill` だけを足して履歴を送らない実装にしない。本 issue は購読者としての受信対応に絞り、履歴を持たない送信側の機能制限を明記する
- 0895 の count 形式、0896 の PAUSED、0905 の origin ID、0907 の SUBSCRIBE_TRACKS 指定を使う。既存 0865 の高レベル catalog を fill 取得へ変える作業は含めない

## 完了条件

- SUBSCRIBE_TRACKS 由来と unsolicited の受理対象 PUBLISH で、初期 fill が正しい Subscriber へ届く
- fill の先着 / 後着、通常 Object との並行受信、paused、取消し・拒否後の到着を検証する
- fill と通常購読の重複・欠落を新しい誤った範囲解釈で発生させない
- 受信対応と publisher の送信機能制限を公開 API 文書で区別する

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §3.4 / §3.4.1 / §9.8 / §9.19.15
- `src/session/incomingPublish.ts`、`src/session/bidi.ts` の `FillFetchTarget`、`src/session/dataStreamIncoming.ts`
- 0865 は catalog 購読の組み立て変更、ここでは PUBLISH のプロトコル受信を扱う

## 解決方法

{未着手}
