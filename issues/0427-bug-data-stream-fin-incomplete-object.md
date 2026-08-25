# data stream が未完成 Object の途中で FIN された場合にセッションを閉じない

- Created: 2026-08-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-data-stream-fin-incomplete-object
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §11.4 (Streams) の SHOULD「If a stream ends gracefully (i.e., the stream terminates with a FIN) in the middle of a serialized Object, the session SHOULD be closed with a PROTOCOL_VIOLATION.」に従い、Fetch / Subgroup ストリームが未完成 Object の途中でピアの FIN により終了した場合に、PROTOCOL_VIOLATION でセッションを閉じるように修正する。現在は未完成 Object が黙殺され、セッションは開いたままになる。

## 現状

- 受信データストリームは `handleIncomingStream` (`src/session.ts`) が Fetch と Subgroup を分岐して処理する。オブジェクトのパースは `processFetchObjects` / `processSubgroupObjects` (`src/session/stream.ts` の値渡し関数、session.ts の private ラッパーを経由) が行い、`IncompleteDataError` (データ不足) を検出すると関数内で break して次チャンクを待つ (データストリームの「データ不足 = 次チャンク待ち」シグナルは close 0409 で確定した変換対象外の経路)。
- Subgroup 経路: `handleSubgroupStream` (`src/session.ts`) は `result.done` (ピア FIN) を検出して break し、`remainingBuffer` (未完成 Object の途中から) を破棄する。
- Fetch 経路: `handleIncomingStream` のループ終了後に `if (isFetchStream && fetcher)` 分岐で残バッファを `processFetchObjects` にもう一度渡すが、未完成なら同様に黙殺され、`fetcher.handleEnd()` が呼ばれてオブジェクトは欠落したまま終了する。
- どちらの経路もセッションは閉じず、`SHOULD` に反する挙動になる (アプリはオブジェクト欠落を検知できない)。

## 設計方針

- FIN 検出時に残バッファ (未完成 Object) がある場合のみ、`PROTOCOL_VIOLATION` (`SessionErrorCode.PROTOCOL_VIOLATION`) でセッションを閉じる。残バッファが無い (Object が完全に受信済み) 場合の正常終了は従来どおりセッションを閉じない。
- チャンク分割の途中 (FIN なし) の `IncompleteDataError` は従来どおり「次チャンク待ち」として扱う (ここを `toProtocolViolationSessionError` の変換対象にするとデータストリームの通常経路が壊れるため、変換には含めず FIN 時点の残バッファ判定で実装する)。
- 変更対象: `handleSubgroupStream` (`src/session.ts`)、`handleIncomingStream` の Fetch 終了分岐 (`src/session.ts`)、対応テスト (`src/session/stream.test.ts` / `src/session.test.ts` の実 W3C ストリーム注入方式)、`CHANGES.md`。

## 完了条件

- Subgroup ストリームが未完成 Object の途中でピア FIN された場合、黙殺されず PROTOCOL_VIOLATION でセッションが閉じること。
- Fetch ストリームでも同様に閉じること。
- 通常終了 (残バッファ 0 の FIN) および複数チャンク分割中 (FIN なし) では従来どおりセッションが閉じないこと (回帰ガード)。
- 上記を検証するテストがあること (実 W3C ストリーム注入方式、モック不使用)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §11.4 (Streams / 「If a stream ends gracefully (i.e., the stream terminates with a FIN) in the middle of a serialized Object, the session SHOULD be closed with a PROTOCOL_VIOLATION.」)
- 関連: `refs/moq/draft-ietf-moq-transport-19.txt`
- 関連: `issues/closed/0409-bug-publish-stream-request-update-decode-failure.md` (同様の黙殺経路を制御メッセージ層で修正済み。data stream の IncompleteDataError が変換対象外であることの設計上の根拠)
