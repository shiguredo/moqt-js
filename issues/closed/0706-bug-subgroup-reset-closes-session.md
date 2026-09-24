# Subgroup データストリームのピア RESET_STREAM でセッションを閉じてしまう

- Created: 2026-09-24
- Completed: 2026-09-24
- Branch: feature/fix-subgroup-reset-tolerance
- Polished: {YYYY-MM-DD}

## 目的

relay が Subgroup の続きを配らずに閉じるとき、受信側 (moqt-js) がセッションごと INTERNAL_ERROR で閉じてしまい、購読が `エラー: Received RESET_STREAM.` で停止する。RESET_STREAM は仕様上「その Subgroup の残りを配らない」という正常な終端通知であり、受信側は残りの Subgroup / Group の stream で再生を続けなければならない。配備 relay では cache の上限超過や replay の live fan-out 引き継ぎで Subgroup stream の reset が起きるため、この欠陥は視聴の停止に直結する。

## 現状

- `src/session/dataStreamIncoming.ts` の `handleIncomingStream` は、Subgroup データストリームの読み取りが reject すると `toSessionCloseError` が null のエラーを「予期しないエラー」として扱い、セッションを INTERNAL_ERROR で閉じる
- `dataStreamHandleSubgroupStream` は読み取りエラーを処理しない。`reader.read()` の reject (WebTransport の `Received RESET_STREAM.`) はそのまま呼び出し元へ伝播する
- pending mode (購読が未登録) でも `reader.read()` の reject が同じ経路でセッションを閉じる
- 既存のテストは Subgroup ストリームの reset を固定していない (fill fetch stream の reset だけを固定している)

## 設計方針

- draft-ietf-moq-transport-21 §11.3.2 (Closing Subgroup Streams): "If a sender closes the stream before delivering all such objects to the QUIC stream, it MUST reset the stream." 受信側は reset を正常な終端として扱う
- subscriber mode では、ピア起因のストリームエラー (`isPeerStreamError`) を「この stream の終端」として扱い、配信済みの Object を保つ。途中まで受けた Object の残りバイトは捨てる (未完成 Object で FIN されたときの PROTOCOL_VIOLATION とは異なる)
- pending mode では、ピア起因のストリームエラーで pending entry を `end-of-stream` として abandon する (セッションは閉じない)
- ピア起因でないエラーはこれまでどおり呼び出し元へ投げ直す
- この規則はドラフトに基づくため、コードコメントに「将来変更されうる」ことを明記する

## 完了条件

- 配信済み Object の後に reset された Subgroup ストリームで、Object が保たれセッションが閉じないことを固定する
- Object の途中で reset された場合に、残りバイトを捨ててセッションを閉じないことを固定する
- pending mode の reset で entry が削除されセッションが閉じないことを固定する
- 全テスト (vitest) が通る

## 参照

- `refs/moq/draft-ietf-moq-transport-21.txt` の Section 11.3.2
- `src/session/dataStreamIncoming.ts` の `handleIncomingStream` / `dataStreamHandleSubgroupStream`
- `src/session/errors.ts` の `isPeerStreamError`

## 解決方法

`src/session/dataStreamIncoming.ts` を次のように直した。

- `dataStreamHandleSubgroupStream` の読み取りで、ピア起因のストリームエラー (`isPeerStreamError`) をこの stream の終端として扱い、配信済みの Object を保ったまま処理を終える。セッションは閉じない (`dataStreamHandleSubgroupReadError`)
- pending mode の読み取りエラーでも同じくセッションを閉じず、pending entry を `end-of-stream` として abandon する (`dataStreamHandlePendingSubgroupReadError`)
- ピア起因でないエラーは呼び出し元へ投げ直し、従来のセッション終了経路を変えない

固定したテスト (`src/session.test.ts`):

- 配信済み Object の後に reset: Object が保たれ、`session.state` が connected のまま
- Object の途中で reset: 残りバイトを捨て、Object を配らずに connected のまま
- pending mode の reset: entry が削除され、connected のまま

`vp check` と全テスト (2611 tests) が通ることを確認した。
