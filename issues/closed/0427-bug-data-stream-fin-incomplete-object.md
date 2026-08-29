# data stream が未完成 Object の途中で FIN された場合にセッションを閉じない

- Created: 2026-08-25
- Completed: 2026-08-29
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
- なお `handleSubgroupStream` の pending mode (subscribers 未登録時) は payload をデコードしていないため未完成 Object を機械的に判定できず、本 issue の判定対象外とする。pending mode の FIN 処理は別経路であり、実態は「end-of-stream 通知で abandon される」ではない (詳細は解決方法の項)。

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

## 解決方法

- `handleSubgroupStream` (`src/session.ts`) の subscriber mode ループ脱出後に残バッファ検査を追加した。ループは `result.done` (ピア FIN) でしか抜けないため、脱出直後に残バッファが非空ならシリアライズされた Object の途中の graceful 終了であり、`SessionError` (PROTOCOL_VIOLATION) で `closeWithError` する。メッセージは `subgroup data stream ended with incomplete object: trackAlias=..., groupId=..., remaining N bytes`。
- `handleIncomingStream` (`src/session.ts`) の Fetch 終了分岐に残バッファ検査を追加した。ループ最終反復で buffer は remainingBuffer に更新済みのため、FIN 時点で非空なら `fetcher.handleEnd()` も `fetchers.delete` も行わず PROTOCOL_VIOLATION でセッションを閉じる (未完成 Object を正常終了として扱わない)。分岐条件をループ内と対称の `isFetchStream && fetcher && fetchHeader` にし、必ず 2 回走る no-op だった終了時の再 `processFetchObjects` を削除した。
- セッション終了済み経路のガード: `transport.closed` ハンドラや `notifyErrorIfActive` は `close()` を経ずに `sessionState` だけ closed に遷移させ得るため、`closeWithError` は `sessionState === "connected"` のときだけ呼ぶ。一方未完成 Object の return は遷移経路を問わず行い、close 済み経路でも `handleEnd()` を通知しない (従来は transport.closed 由来の終了済み経路で end が飛んでいた)。
- ヘッダー parse 途中での FIN (`IncompleteDataError` + done) は Object 開始前のため判定対象外とする break をコメントで明記した (この break は解決済み read() による無限周回防止も兼ねる)。
- `src/session/stream.ts` (pure 関数) と `src/session/errors.ts` (`toProtocolViolationSessionError`) は設計方針どおり変更せず、関数内 `IncompleteDataError` 吸収 → `remainingBuffer` 返却の契約を維持した。 Fetch 側の prior context 引用の節番号を実際の §11.4.4.1 に訂正した。
- テスト: `src/session.test.ts` に実 W3C ReadableStream 注入 (モック不使用) で 12 本追加。未完成 FIN 閉鎖 (Subgroup / Fetch)、分割中に閉じない回帰 (中間アサート付き 3 チャンク)、ヘッダーのみ FIN 正常系 (Subgroup / Fetch)、ヘッダー途中切れ FIN 黙殺 (Subgroup / Fetch)、END_OF_GROUP status 配信済み FIN の誤検出なし / status 途中切れ FIN の閉鎖、セッション close 済み経路の黙殺と end 非通知 (Subgroup / Fetch)。`session.state` / `fetcher.state` / `fetchers.size` も検証に含めた。
- `docs/LOW_LEVEL_API.md` に「Graceful 終了 (FIN) と未完成 Object」節を追加し、失効範囲がセッション全体であること、RESET_STREAM 終了は該当しないこと、sessionState 終了済み経路の黙殺を明記した。`processFetchObjects()` 節の終了処理の記述も実装に更新した。
- 検証結果: `vp check` / `tsc --noEmit` / `vp test run` (1331 本) すべて通過。

### pending mode の FIN 処理の実態 (範囲外の残課題)

- 起票時の「現状」は pending mode の FIN が end-of-stream 通知による abandon 経路 (`cancelStreamQuiet`) に落ちると記述していたが、実コードでは落ちない。完了済み ReadableStream の `read()` は解決済み Promise を返すため、pending mode の `Promise.race` では常に chunk 分岐が勝り、`entry.notify("end-of-stream")` は以後発火せず、`while (subscribers.length === 0)` がマイクロタスクループを回り続けてイベントループを巻き込む (実測でハング)。本 issue の変更は pending mode を触っていないため挙動は従来どおり (対象外) のままだが、この既存の不具合自体は別途対応が必要である。
- 送信側 (`src/session/publish.ts`) は Object Fields と payload を別 write で送信するため、セッション close が間に合うと宣言済み payload を伴わない FIN を送出し得る (受信側が §11.4 で他端を閉じる側のワイヤを自分でも出し得る)。受信側判定の有効化とセットの認識として、送信側の順序整備は別途対応が必要である。
