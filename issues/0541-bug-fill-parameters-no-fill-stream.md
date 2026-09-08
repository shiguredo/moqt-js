# Publisher が FILL_PARAMETERS を受理したら fill fetch ストリームを開くか拒否する

- Created: 2026-09-08
- Completed: YYYY-MM-DD
- Branch: feature/fix-fill-parameters-publisher
- Polished: 2026-09-08

## 目的

draft-ietf-moq-transport-20 §5.1.3.1 は「A publisher opens a fill fetch stream when it processes a SUBSCRIBE or REQUEST_UPDATE that carries FILL_PARAMETERS while Forward State is 1.」と定める。現状は publish ロールの REQUEST_UPDATE で FILL_PARAMETERS を受理して REQUEST_OK を返しながら fill fetch ストリームを開かないため、購読側が fill を待ち続ける。

## 現状

- `src/session/bidi.ts` の publish ロールの REQUEST_UPDATE 処理は、FILL_PARAMETERS を含む更新を検証通過後に受理し、空パラメータの REQUEST_OK を返す。コード上のコメントも「moqt-js は publisher として fill ストリームを開かない」「accept-then-ignore」と明記している。
- publisher が fill fetch ストリームを開く実装は存在しない。`createUnidirectionalStream` は制御ストリーム送信（`src/session.ts`）と subgroup 送信（`src/session/publish.ts`）でのみ使われる。
- moqt-js は WebTransport クライアントであり、受信 SUBSCRIBE は `src/session/incoming.ts` で `"unsupported-request"` に分類され、FILL_PARAMETERS の有無に関係なく REQUEST_ERROR(NOT_SUPPORTED) + FIN で既に拒否される。closed の `issues/closed/0450-draft-20-add-fill-parameters-and-fill-fetch.md` も「送信側が SUBSCRIBE を受けて fill を開く義務は、moqt-js が SUBSCRIBE 受信を持たないため対象外」としている。
- §5.1.3.1 は「FILL_PARAMETERS carried while Forward State is 0 opens no fill fetch stream.」「Transitioning to Forward State 1 without re-sending FILL_PARAMETERS does not open one either.」と定め、§5.1.3 は「If the fill range is empty, or starts after Largest Object, the publisher does not open a fill fetch stream.」と定める。FILL_PARAMETERS の存在だけでは fill ストリームは開かれない。
- 既存テスト `src/session/bidi.test.ts` の「正常な FILL_PARAMETERS の REQUEST_UPDATE (publish ロール) で REQUEST_OK が応答される」が現挙動（REQUEST_OK）を固定している。

## 設計方針

1. 対象は publish ロールの REQUEST_UPDATE に限定する。受信 SUBSCRIBE は既存の NOT_SUPPORTED 経路で拒否されるため対象外とし、SUBSCRIBE への PUBLISH_DONE は送らない。
2. 更新適用後の Forward State が 1 で、fill 範囲が空でない場合に限り、REQUEST_ERROR と PUBLISH_DONE(UPDATE_FAILED) を返す。Forward State が 0、または fill 範囲が空・Largest Object より後の場合は fill ストリームを開かないため、REQUEST_OK を返してよい。fill 範囲の評価は購読の Location Filter / FILL_PARAMETERS 内の LOCATION_FILTER を `resolveFilter` で解決して行う。
3. FILL_PARAMETERS 内側パラメータの検証（§10.2.15 の一覧外パラメータの PROTOCOL_VIOLATION、Range Filter 違反の INVALID_FILTER、LOCATION_FILTER の End Group 超過）は拒否判定より先に行う。検証順序を変えて MUST 違反のテストを壊さない。
4. REQUEST_ERROR の error code は、publisher が fill をサポートしないことを示す `NOT_SUPPORTED` とする。既存の `bidiTerminatePublishSubscriptionWithUpdateFailed` を再利用して PUBLISH_DONE(UPDATE_FAILED) を送る。
5. `src/session/bidi.test.ts` の REQUEST_OK を固定している既存テストを新挙動に反転し、Forward State=0 の FILL_PARAMETERS は受理されることも検証する。
6. fill fetch ストリーム送信の実装は別 issue に分離する（本 issue は「受理して黙殺」をやめて明示的に拒否するところまで）。
7. `CHANGES.md` の `## develop` に `[CHANGE]` を追記する。publisher の応答が REQUEST_OK から REQUEST_ERROR に変わる後方互換のない挙動変更である。

## 完了条件

- publisher が、Forward State=1 かつ fill 範囲が空でない FILL_PARAMETERS を含む更新を黙殺しないこと（REQUEST_ERROR(NOT_SUPPORTED) + PUBLISH_DONE(UPDATE_FAILED) を返すこと）。
- Forward State=0 または fill 範囲が空の FILL_PARAMETERS は REQUEST_OK で受理されること。
- FILL_PARAMETERS 内側パラメータの既存検証（PROTOCOL_VIOLATION / INVALID_FILTER）が拒否判定より先に働くこと。
- 購読側が fill 完了を待ち続けないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §5.1.3 / §5.1.3.1 / §10.2.15 / §10.9.1
- `bidiReadRequestStreamMessages`（`src/session/bidi.ts`）
- `bidiTerminatePublishSubscriptionWithUpdateFailed`（`src/session/bidi.ts`）
- `resolveFilter`（`src/filter.ts`）
- `src/session/bidi.test.ts`
- `issues/closed/0450-draft-20-add-fill-parameters-and-fill-fetch.md`（SUBSCRIBE 対象外の先行判断）
