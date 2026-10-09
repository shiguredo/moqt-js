# 受信データストリームのバッファ上限がストリーム単位でしか無い

- Created: 2026-09-24
- Completed: 2026-10-09
- Branch: feature/fix-session-wide-data-stream-buffer-cap
- Polished: 2026-09-24

## 目的

closed の `0646-bug-data-stream-buffer-limit.md` で、確立後の受信データストリームにストリーム単位のバッファ上限 (`DEFAULT_DATA_STREAM_MAX_BUFFER_BYTES` 32 MiB、`session.dataStreamMaxBufferBytes`) を入れたが、セッション全体の合計上限は無い。上限近くまで溜めたストリームを同時に何本も開けば合計は上限 × 本数まで増える。ストリームの本数を制限する箇所も無いため、本数はピアが決められる。1 本あたりを小さく保ったまま本数を増やせば合計でメモリを消費させる経路が残る。0646 の「残した課題」にも per-session の合計上限が対象外として記録されている。

## 現状

- `src/session/dataStreamIncoming.ts` の `isDataStreamBufferOverLimit` (1138-1143 行目) は `session.dataStreamMaxBufferBytes > 0 && bufferedBytes > session.dataStreamMaxBufferBytes` を返す。引数の `bufferedBytes` は呼び出し元の 1 本のストリームの残バッファ長であり、複数ストリームの合計を数える箇所はセッション全体に無い
- 上限判定は 3 経路にある。FETCH は `dataStreamAbortFetchOnBufferOverflow` (685-715 行目。呼び出しは 338-348 行目)、fill fetch は `dataStreamAbortFillOnBufferOverflow` (1106-1126 行目。呼び出しは 465-475 行目と 485-495 行目)、Subgroup の subscriber mode はループ先頭の直接判定 (984-1003 行目) である。いずれも `buffer.byteLength` だけを見る
- ストリームの本数を制限する箇所は無い。`dataStreamStartIncomingStreamLoop` (85-113 行目) は `transport.incomingUnidirectionalStreams` から読むたびに `dataStreamHandleIncomingStream` を fire-and-forget で起動する。`statsSubscriberStreamsActive` (72 行目) は 152 行目で加算し 421 行目で減算するだけで、上限判定に使っていない
- 合計バイトの上限に相当するものは `src/pendingSubgroupBuffer.ts` の `PendingSubgroupBufferOptions.perSessionMaxBytes` (32 行目。既定 16 MiB は `DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS` 46 行目、判定は `appendChunk` 153 行目) だけである。これは Track Alias 未確立の pending mode 専用で、確立後の受信経路は通らない
- catalog 専用のバイト上限も無い。catalog は `src/createMediaSubscriber.ts` の `subscribeCatalog` (604 行目) が通常の subscribe と fetch で受けるため、ストリーム単位の上限だけが効く。同ファイルの `pendingCatalogObjects` (312 行目) は FETCH フェーズ中の live Object を配列へ積むが、受信バッファとは別の保持であり本 issue の対象外とする
- オプションの経路は `ConnectOptions.dataStreamMaxBufferBytes` (`src/session/publicTypes.ts` 195-204 行目) → `src/connect.ts` の `connect` (111-113 行目) → `ConnectionInitializeOptions.dataStreamMaxBufferBytes` (`src/session/connection.ts` 85-92 行目) → `connectionApplyTimeoutOptions` (595-610 行目。608-609 行目で `session.dataStreamMaxBufferBytes` に代入) の 1 本である
- `docs/LOW_LEVEL_API.md` の `ConnectOptions` 表 (65 行目) はストリーム単位の上限だけを説明している
- 0646 の「残した課題」に「per-session の合計上限は対象外 (多数のストリームを同時に開かれれば合計は上限 × 本数まで増える。`pendingSubgroupBuffer` には per-session 16 MiB がある)」と記録されている
- open の `0659-perf-incoming-data-stream-buffer-growth.md` は、1 本のストリームでチャンクが届くたびに累積バッファ全体をコピーし直す二次のコスト (処理時間) を扱う。メモリ量の上限は扱わず、複数ストリームの合計も対象にしない。本 issue は合計メモリの上限だけを扱い、1 本あたりのコピー回数には触れない

## 設計方針

- セッションに合計バイト数のフィールド (仮に `dataStreamBufferedBytesTotal`) を持たせ、受信ループが「チャンクを追記したバイト数」を加算し「バッファから消費したバイト数」を減算する。上限は `dataStreamMaxTotalBufferBytes` として `ConnectOptions` から指定できるようにする
- 増減は受信ループの中で直接行わず、`dataStreamBufferBytesAdd` / `dataStreamBufferBytesRelease` の 2 関数に閉じる。open の 0659 が同じループのバッファ管理を offset 方式へ書き換えるため、`buffer.byteLength` の差分から数える実装にすると衝突する。追記時と消費時に明示的に呼ぶ形にすれば、0659 の実装後もループの書き換え箇所へ 1 対で残せる
- 超過時は「その時点で追記したストリーム」を既存の打ち切り手順で落とす。経路ごとの後始末 (FETCH の `dataStreamAbortFetchOnBufferOverflow`、fill の `dataStreamAbortFillOnBufferOverflow`、Subgroup subscriber mode の購読 cancel) は変えず、判定条件に合計を加える。アプリへ渡す error の `streamErrorCode` は `DataStreamErrorCode.EXCESSIVE_LOAD` (0x9、`src/error.ts` 163 行目) のままにする
- 1 本落とした時点で合計が上限以下に戻るなら他のストリームは継続する。合計は 1 本ずつ減るため全滅しない。1 本だけで上限を超える場合はストリーム単位の上限と同じ結果になる
- ストリームの終了 (FIN / peer reset / cancel / 例外) では、そのストリームが保持していたバイトを必ず減算する。`dataStreamHandleIncomingStream` (419-423 行目) と `dataStreamHandleSubgroupStream` (1068-1070 行目) は既存の `finally` で解放する。`dataStreamHandleFillFetchStream` (438-583 行目) は `finally` を持たないため、`finally` を新設して正常終了 (516-533 行目) と `catch` (534 行目以降) の両方を通る 1 か所に寄せる。減算漏れで合計が単調増加しないようにする
- pending mode のバイトは `pendingSubgroupBuffer` の per-session 上限 (16 MiB) が既に管理しているため合計に含めない (二重計上しない)。subscriber mode へ合流した時点で合計へ載せる
- 既定値は 64 MiB とする。媒体フレームが通常 1 MiB 未満であり、ストリーム単位の既定 32 MiB の 2 本ぶんを同時に受けられ、0659 が測定に使う 16 MiB の Object を複数本同時に受けられる値である。0 以下で上限なしとする (ストリーム単位の上限と同じ規約)
- `DEFAULT_DATA_STREAM_MAX_TOTAL_BUFFER_BYTES` を `src/session/connection.ts` に置き、`ConnectOptions` → `ConnectionInitializeOptions` → `connectionApplyTimeoutOptions` の既存の経路に載せる。`docs/LOW_LEVEL_API.md` の `ConnectOptions` 表にも載せる
- 高レベル API (`MediaSubscriberOptions` / `MediaPublisherOptions`) からは指定できない。既存のタイムアウトとストリーム単位の上限と同じ扱いとし、必要な場合は低レベル API を使う
- `CHANGES.md` の `## develop` に `[FIX]` を追記する
- テストは `src/session.test.ts` の上限テスト群 (6283 行目以降) の隣に追加する。複数ストリームの合計超過で後から追記した 1 本だけが落ちること、他のストリームが継続すること、ストリーム終了で合計が減ること、上限ちょうどは落ちないこと、`initialize` 経由のオプション反映、既定値を固定する
- 対象は `src` と `docs` と `CHANGES.md` とする。0659 と同じファイルを触るため、実装順は 0659 を先にするか、後から conflict を解消する

## 完了条件

- 2 本以上の受信データストリームの残バッファ合計が `dataStreamMaxTotalBufferBytes` を超えると、超過の原因になったストリームが `EXCESSIVE_LOAD` で打ち切られる
- 打ち切られていない他のストリームは受信を継続し、セッションは閉じない
- 合計が上限以下のときは従来どおり受信でき、上限ちょうどは打ち切らない
- ストリームの終了 (FIN / reset / 例外) でそのストリームの保持バイトが合計から減り、合計が単調増加しない
- pending mode の保持バイトが合計に二重計上されない
- `ConnectOptions.dataStreamMaxTotalBufferBytes` が `initialize` 経由で反映され、未指定なら既定 64 MiB、0 以下で上限なしになる
- `docs/LOW_LEVEL_API.md` の `ConnectOptions` 表に新しい上限が載っている
- `CHANGES.md` の `## develop` に `[FIX]` が入る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-transport-21 §12.5 (Stream Reset Error Codes。EXCESSIVE_LOAD 0x9 は endpoint が過負荷でストリームを reset する場合)。本文は `refs/moq/draft-ietf-moq-transport-21.txt` の 6675-6710 行目
- draft-ietf-moq-transport-21 §11.3.1 (Track Alias 未確立ストリームを brief period だけ buffer してよい。pending mode の per-session 上限の根拠)
- closed `0646-bug-data-stream-buffer-limit.md` (ストリーム単位の上限。残した課題に per-session の合計上限がある)
- open `0659-perf-incoming-data-stream-buffer-growth.md` (1 本のストリーム内のコピーコスト。本 issue とは対象が違う)
- `src/pendingSubgroupBuffer.ts` の `perSessionMaxBytes` (per-session の合計上限の先例)

## 解決方法

- `src/session.ts` に、すべての受信データストリームが保持しているバイト数の合計 `dataStreamBufferedBytesTotal` と、その上限 `dataStreamMaxTotalBufferBytes` を足した。増減は `src/session/dataStreamIncoming.ts` の `dataStreamBufferBytesAdd` / `dataStreamBufferBytesRelease` の 2 関数に閉じ、`src/session/connection.ts` の `DEFAULT_DATA_STREAM_MAX_TOTAL_BUFFER_BYTES` (64 MiB) を既定にした
- 受信ループ (FETCH / fill fetch / Subgroup) はそれぞれ `streamBufferedBytes` を持ち、`dataStreamAppendChunk` でチャンクを追記したバイト数を加算、ヘッダーの解析と Object の配信で消費したバイト数を減算し、ストリームの終了 (FIN / peer reset / cancel / 例外) の `finally` で残りを必ず解放する。fill fetch ストリームには `finally` を新設した。ハンドラ間の受け渡しは「ヘッダー分だけ解放し、残りは所有権ごと渡す」形にして二重計上を防いだ
- Track Alias 未確立 (pending mode) の保持バイトは `pendingSubgroupBuffer` の per-session 上限が管理するため合計に載せず、subscriber mode へ合流した時点 (`dataStreamMergePendingSubgroupChunks`) で計上する。pending に溜めている間は合計 0 である
- 上限の判定は、チャンクを追記した直後の await を挟まない同期区間で行う (FETCH は FETCH_OK を待つ前、pending は合流の直後、fill は追記の直後)。超過したら超過の原因になったストリームだけを既存の打ち切り手順 (FETCH は `handleError` と STOP_SENDING、fill は `fillError`、Subgroup は購読の cancel) で落とし、他のストリームとセッションは継続する。上限ちょうどは打ち切らない。アプリへ渡す error の `streamErrorCode` は `EXCESSIVE_LOAD` (0x9) のままで、診断の `limit=` / `totalLimit=` / `total=` は判定時の値を載せる
- 打ち切りを決めたストリームの計上分は、打ち切りの await (cancel と Fetcher の cancel) の前に `dataStreamReleaseStreamBytesOnAbort` で解放する。解放を `finally` まで待つと、await 中も合計が上限超過のままになり、その間に追記した無関係なストリームが巻き添えで打ち切られて連鎖する (レビューで 3 つの窓を見つけて塞いだ)
- `ConnectOptions.dataStreamMaxTotalBufferBytes` を `connect` → `ConnectionInitializeOptions` → `connectionApplyTimeoutOptions` の既存経路に載せた。0 以下で上限なし。高レベル API からは指定できない (ストリーム単位の上限と同じ扱い)。`docs/LOW_LEVEL_API.md` の `ConnectOptions` 表にも書いた
- テスト: `src/session.test.ts` に、合計超過で超過の原因の 1 本だけが打ち切られ他は継続すること、上限ちょうどは打ち切らないこと、0 以下で上限なしになること、終了 (peer reset / 例外 / 未完成 Object の FIN) で合計が減ること、pending の二重計上が無いこと、fill fetch と FETCH の打ち切り、打ち切りの await 中・FETCH_OK 待ちの間・pending の合流の直後に追記した他のストリームが巻き添えにならないこと、FIN しない padding ストリームのバイトが合計に残らないこと、Fetcher が登録済みでも同じタスクの他ストリームが巻き添えにならないこと、`initialize` 経由の反映と既定値 64 MiB を足した
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` / `npx vp run build` が通ることを確認した (199 ファイル / 3671 テスト)
