# 受信 PUBLISH 経路の REQUEST_UPDATE に含まれる FILL_PARAMETERS の扱いを確定する

- Created: 2026-09-09
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publish-request-update-fill
- Polished: {YYYY-MM-DD}

## 目的

受信 PUBLISH 経路（moqt-js が subscriber、peer が publisher）の REQUEST_UPDATE に FILL_PARAMETERS が含まれる場合、現状は検証後に受理して REQUEST_OK を返すだけで、fill fetch ストリームの関連付けを行わない。仕様上の要求方向を確定し、現状の accept-then-ignore が正しいかを明らかにする。

## 現状

- `src/session/bidi.ts` の `bidiHandlePublishRequestUpdate` は受信 PUBLISH ストリーム上の REQUEST_UPDATE を処理する。FILL_PARAMETERS は `validateLocationAndFillParameters` で内側を検証したうえで受理され、空 parameters の REQUEST_OK を返す。fill ストリームの関連付けは行わない。
- `session.fillFetchTargets` への登録は、moqt-js が送信した REQUEST_UPDATE の経路（`bidiSendRequestUpdate` / `registerRawFillFetchTarget`）でのみ行われる。
- 受信 FETCH ストリーム処理（`src/session.ts` の `handleIncomingStream`）は `fillFetchTargets.get(header.requestId)` を引き、該当が無ければ `waitForFetcher` へフォールバックし、タイムアウトで `reader.cancel` する。peer が同じ Request ID で fill fetch ストリームを開いた場合、この経路では購読に関連付けられない。
- 仕様: draft-ietf-moq-transport-21 §9.5.1 は subscriber の REQUEST_UPDATE が fill を要求すると定め、§3.4.1 は publisher が FILL_PARAMETERS を含む SUBSCRIBE / REQUEST_UPDATE を処理したときに fill fetch ストリームを開くと定める。publisher 発の REQUEST_UPDATE に FILL_PARAMETERS が載る場合の意味は明確でない。
- 送信 PUBLISH 側（`role === "publish"`）は issue 0541 で FILL_PARAMETERS を REQUEST_ERROR (NOT_SUPPORTED) で拒否するようにした。受信 PUBLISH 側とは判定が非対称である。

## 設計方針

1. publisher 発 REQUEST_UPDATE の FILL_PARAMETERS が fill fetch ストリームを伴うかを §3.4 / §3.4.1 / §9.5.1 に照らして確定する。
2. 伴わない場合は、受理して REQUEST_OK を返す現状が正しいことを仕様根拠つきのコメントとテストで固定する。
3. 伴う場合は、Request ID をキーに fill 対象を関連付ける経路を追加し、subscriber が受信する fill ストリームの処理へ接続する。
4. どちらの結論でも、送信 PUBLISH 側で拒否する判定との非対称の理由をコメントに残す。

## 完了条件

- publisher 発 REQUEST_UPDATE の FILL_PARAMETERS の扱いが仕様根拠つきで確定していること。
- 確定した挙動を検証するテストがあること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-21 §3.4 / §3.4.1 / §9.5 / §9.5.1 / §9.20.16
- `bidiHandlePublishRequestUpdate`（`src/session/bidi.ts`）
- `fillFetchTargets` / `handleIncomingStream` / `waitForFetcher`（`src/session.ts`）
- `registerRawFillFetchTarget` / `bidiSendRequestUpdate`（`src/session/bidi.ts`）
- `issues/closed/0541-bug-fill-parameters-no-fill-stream.md`（送信 PUBLISH 側の拒否）
