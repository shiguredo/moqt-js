# 受信 PUBLISH 経路の REQUEST_UPDATE に含まれる FILL_PARAMETERS の受理挙動を固定する

- Created: 2026-09-09
- Completed: 2026-09-09
- Branch: feature/refactor-received-publish-fill
- Polished: 2026-09-09

## 目的

受信 PUBLISH 経路（moqt-js が subscriber、peer が publisher）の REQUEST_UPDATE に FILL_PARAMETERS が含まれる場合の挙動を、仕様根拠つきでコメントとテストに固定する。現状は検証後に受理して REQUEST_OK を返し、fill fetch ストリームの関連付けは行わない。この挙動が §3.4.1 の fill 開設主体の定義と整合することを保証する。

## 現状

- `src/session/bidi.ts` の `bidiHandlePublishRequestUpdate` は受信 PUBLISH ストリーム上の REQUEST_UPDATE を処理する。`src/session.ts` の `runPublishStreamSubLoop` が `SubscriberImpl` を渡して呼ぶため、この経路で moqt-js は subscriber、peer は publisher である。
- FILL_PARAMETERS は `validateLocationAndFillParameters` で内側を検証したうえで受理され、空 parameters の REQUEST_OK を返す。fill fetch ストリームの関連付けは行わない。
- `session.fillFetchTargets` への登録は、moqt-js が送信した SUBSCRIBE（初期 fill、`src/session.ts` の `subscribe`）と REQUEST_UPDATE（`bidiSendRequestUpdate` / `registerRawFillFetchTarget`）の経路で行われる。受信 PUBLISH 経路では行わない。
- 仕様: draft-ietf-moq-transport-21 §3.4.1 は「A publisher opens a fill fetch stream when it processes a SUBSCRIBE or REQUEST_UPDATE that carries FILL_PARAMETERS while Forward State is 1.」と定める。受信 PUBLISH 経路で FILL_PARAMETERS を処理するのは moqt-js（subscriber）であり、fill fetch ストリームを開く主体は送信側の peer publisher ではないため、この方向では fill ストリームは開かれない。
- 送信 PUBLISH 側（`role === "publish"`）は moqt-js が publisher であり fill fetch ストリームを開けないため、`applyPublishRequestUpdate` が REQUEST_ERROR (NOT_SUPPORTED) で拒否する。役割が逆のため判定が非対称になるが、これは仕様上の主体差による正当な非対称である。

## 設計方針

1. 受信 PUBLISH 経路の FILL_PARAMETERS は、moqt-js が subscriber であり fill fetch ストリームを開く主体でないため、検証後に受理して REQUEST_OK を返し、`fillFetchTargets` へは登録しない。
2. `bidiHandlePublishRequestUpdate` に、送信 PUBLISH 側で拒否する判定との非対称が役割差によるものであることを §3.4.1 の根拠つきでコメントする。
3. 受信 PUBLISH 経路の FILL_PARAMETERS を含む REQUEST_UPDATE で REQUEST_OK が返り、`fillFetchTargets` に登録されないことを検証するテストを追加する。

## 完了条件

- 受信 PUBLISH 経路の FILL_PARAMETERS を含む REQUEST_UPDATE で REQUEST_OK が返り、`fillFetchTargets` に登録されないことをテストで固定していること。
- 送信 PUBLISH 側との非対称の理由が §3.4.1 の根拠つきでコメントされていること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-21 §3.4 / §3.4.1 / §9.5 / §9.5.1 / §9.20.16
- `bidiHandlePublishRequestUpdate`（`src/session/bidi.ts`）
- `runPublishStreamSubLoop` / `fillFetchTargets` / `subscribe`（`src/session.ts`）
- `registerRawFillFetchTarget` / `bidiSendRequestUpdate` / `applyPublishRequestUpdate`（`src/session/bidi.ts`）
- `issues/closed/0450-draft-20-add-fill-parameters-and-fill-fetch.md`
- `issues/closed/0541-bug-fill-parameters-no-fill-stream.md`

## 解決方法

受信 PUBLISH 経路の FILL_PARAMETERS 受理挙動を仕様根拠つきで固定した。

- `src/session/bidi.ts` の `bidiHandlePublishRequestUpdate` に、§3.4.1 の fill 開設主体の定義と、送信 PUBLISH 側 (`applyPublishRequestUpdate`) が REQUEST_ERROR (NOT_SUPPORTED) で拒否する役割差による正当な非対称であることをコメントする
- `src/session/bidi.test.ts` に、受信 PUBLISH 経路の FILL_PARAMETERS を含む REQUEST_UPDATE で REQUEST_OK が返り、`fillFetchTargets` に登録されないことを検証するテストを追加する
- `vp check` / `tsc --noEmit` / `vp test run` が通ることを確認する
