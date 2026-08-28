# data stream が未完成 Object の途中で FIN された場合にセッションを閉じない

- Created: 2026-08-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-data-stream-fin-incomplete-object
- Polished: 2026-08-28

## 目的

draft-ietf-moq-transport-19 §11.4 (Streams) の SHOULD「If a stream ends gracefully (i.e., the stream terminates with a FIN) in the middle of a serialized Object, the session SHOULD be closed with a PROTOCOL_VIOLATION.」に従い、Fetch / Subgroup ストリームが未完成 Object の途中でピアの FIN により終了した場合に、PROTOCOL_VIOLATION でセッションを閉じるように修正する。現在は未完成 Object が黙殺され、セッションは開いたままになる。

## 現状

- 受信データストリームは `handleIncomingStream` (`src/session.ts`) が Fetch と Subgroup を分岐して処理する。オブジェクトのパースは `processFetchObjects` / `processSubgroupObjects` (`src/session/stream.ts` の値渡し関数、session.ts の private ラッパーを経由) が行い、`IncompleteDataError` (データ不足) を検出すると関数内で break して次チャンクを待つ。
- `toProtocolViolationSessionError` (`src/session/errors.ts`) は 0409 の変更で `IncompleteDataError` も変換対象に含めているが、data stream 経路では上記の関数内 catch と `handleIncomingStream` の外側 catch 内でも `IncompleteDataError` が本関数に到達しないよう処理される（errors.ts の doc コメント「data stream (Section 11) では ... 変換は適用されない」）。したがって「データ不足 = 次チャンク待ち」の通常シグナル動作は 0409 で変わっていない。
- Subgroup 経路: `handleSubgroupStream` (`src/session.ts`) の subscriber mode ループは `result.done` (ピア FIN) を検出して break し、直前の `processSubgroupObjects` が返した `remainingBuffer` (未完成 Object の途中から) を局所変数に保持したまま関数リターンで破棄する。
- Fetch 経路: `handleIncomingStream` のループ終了後の `if (isFetchStream && fetcher)` 分岐で残バッファを `processFetchObjects` にもう一度渡すが、戻り値 (`remainingBuffer`) は受け取らず捨て、`fetcher.handleEnd()` を無条件に呼んでオブジェクトは欠落したまま終了する。
- どちらの経路もセッションは閉じず、§11.4 の SHOULD に反する挙動になる (アプリはオブジェクト欠落を検知できない)。
- なお `handleSubgroupStream` の pending mode (subscribers 未登録時) は payload をデコードしていないため未完成 Object を機械的に判定できず、FIN は `end-of-stream` 通知で abandon 経路 (`cancelStreamQuiet`) に落ちる。

## 設計方針

- FIN 検出時に caller 側で残バッファ (未完成 Object) がある場合のみ、`PROTOCOL_VIOLATION` (`SessionErrorCode.PROTOCOL_VIOLATION`) でセッションを閉じる。残バッファが無い (Object が完全に受信済み) 場合の正常終了は従来どおりセッションを閉じない。
- 具体的には `handleSubgroupStream` の subscriber mode ループの `result.done` 分岐と、`handleIncomingStream` の Fetch 終了分岐で `processFetchObjects` / `processSubgroupObjects` が返す `remainingBuffer` の非空判定を行い、非空なら `closeWithError(PROTOCOL_VIOLATION)` する。
- pure 関数 (`processFetchObjects` / `processSubgroupObjects` in `src/session/stream.ts`) は変更しない。関数内で `IncompleteDataError` を吸収して `remainingBuffer` を返す現行契約を維持し、FIN 判定は caller 側の残バッファ非空チェックで実装する。
- 既存の `toProtocolViolationSessionError` の変換ロジック (`IncompleteDataError` を含む) は変更しない。data stream 経路では従来どおり関数内 / 外側 catch 内で `IncompleteDataError` を本関数に到達させないため、変換の適用条件は変わらない。
- チャンク分割の途中 (FIN なし) の `IncompleteDataError` は従来どおり「次チャンク待ち」として扱う (関数内 break で吸収)。
- `handleSubgroupStream` の pending mode (subscribers 未登録時) は本 issue のスコープ外とし、従来どおり `end-of-stream` 通知で `cancelStreamQuiet` により abandon する。subscribers 登録前は payload を decode していないため未完成 Object 判定ができず、また subscribers 未登録のためオブジェクト欠落は発生しないためである。
- 変更対象: `handleSubgroupStream` (`src/session.ts`)、`handleIncomingStream` の Fetch 終了分岐 (`src/session.ts`)、対応テスト (`src/session.test.ts` の実 W3C ストリーム注入方式)、`CHANGES.md`。`src/session/stream.test.ts` は変更しない。

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
- 関連: `issues/closed/0409-bug-publish-stream-request-update-decode-failure.md` (制御メッセージ層で同種の黙殺経路を PROTOCOL_VIOLATION 化した先例。`toProtocolViolationSessionError` に `IncompleteDataError` を追加した根拠と、data stream 側は関数内で吸収するため巻き込まれない設計上の切り分けが確立している)
