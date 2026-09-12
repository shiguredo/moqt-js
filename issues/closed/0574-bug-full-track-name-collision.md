# getFullTrackName の文字列連結が非単射で無関係な Track を cross-cancel し得る

- Created: 2026-09-12
- Completed: 2026-09-12
- Branch: feature/fix-full-track-name-collision
- Polished: 2026-09-12

## 目的

Track の同一性判定は Full Track Name (trackNamespace + trackName) で行う (draft-ietf-moq-transport-21 §2.4.1)。現状は namespace 配列を `/` で連結した文字列で比較しており、単射でないため異なる Track が同じ文字列になる。malformed 検出時の cross-cancel はこの文字列一致だけで cancel 対象を決めるため、悪意あるピアが malformed を発生させて無関係な既存購読 / FETCH を巻き込める。本 issue は moqt-js の string 表現上の衝突 (区切り文字の曖昧さ) の解消に限定する。wire バイト列の厳密同一性 (§2.4.1 の "comparison ... is done by exact comparison of the bytes") は、受信経路が不正 UTF-8 を U+FFFD に置換しており別問題のため対象外とする。

## 再現手順

1. namespace `["a"]` + trackName `"b/c"` の Track A を SUBSCRIBE で確立する
2. namespace `["a","b"]` + trackName `"c"` の Track B を SUBSCRIBE で確立する (両方 `"a/b/c"` になる)
3. Track B の同一 Track に対する SUBSCRIBE_OK に未知 Mandatory Track Property を含めて malformed を検出させる
4. 現状は Track A の購読まで cancel される (本来は Track B だけが cancel されるべき)
5. FETCH でも同様 (同じ衝突で無関係な FETCH が cancel される)

## 現状

- `src/subscriber.ts` の `SubscriberImpl.getFullTrackName` と `src/fetcher.ts` の `FetcherImpl.getFullTrackName` は `${namespace.join("/")}/${trackName}` を返す。
- Track Namespace の各要素と Track Name に `/` を許すため、namespace `["a"]` + trackName `"b/c"` と namespace `["a","b"]` + trackName `"c"` が同じ `"a/b/c"` になる。
- この文字列は `cancelMalformedTrackPeers` の走査 (`src/session/bidi.ts`)、`bidiReadSubscribeResponse` の Track Alias 重複判定 (`src/session/bidi.ts`)、受信 PUBLISH の Track Alias 重複判定 (`src/session.ts` の `handleIncomingBidirectionalStream`)、`src/session/incoming.ts` の Track 特定で使われる。
- 受信 PUBLISH の重複判定は `getFullTrackName` を呼ばず `${publishTrackNamespace.join("/")}/${publishTrackName}` をインライン構築して比較しているため、`getFullTrackName` の実装だけを変更すると旧形式と新形式の比較になり、同一 Track への複数 PUBLISH (draft-ietf-moq-transport-21 §3.1 で許容) でも DUPLICATE_TRACK_ALIAS でセッションを閉じる退行になる。
- 0571 (クローズ済み) で `cancelMalformedTrackPeers` に `pendingSubscribe` / `pendingFetch` の比較が増えている。

## 設計方針

1. Full Track Name の比較キーをフィールド境界が曖昧にならない長さ付きキーに統一する。各 namespace 要素を `${length}:${value}` の形で連結し、trackName も長さ付きにする (例: namespace `["a"]` + trackName `"b/c"` は `1:a|3:b/c`、namespace `["a","b"]` + trackName `"c"` は `1:a|1:b|1:c`)。`getFullTrackName` の戻り値の形式を変更し、同一性判定はこのキーの完全一致で行う。
2. キー生成を共通ヘルパー (`fullTrackNameKey` 等) に集約し、`getFullTrackName` の実装と受信 PUBLISH のインライン構築を共通ヘルパー経由に統一する。比較箇所は `cancelMalformedTrackPeers` / `bidiReadSubscribeResponse` の Track Alias 重複判定 / 受信 PUBLISH の Track Alias 重複判定 / `src/session/incoming.ts` の Track 特定 / `bidiReadFetchResponse` から `cancelMalformedTrackPeers` への受け渡しを洗い出す。
3. キーの単射性 (異なる Full Track Name が同じキーにならない) と同一性 (同じ Full Track Name は同じキーになる) の両方を検証するテストを追加する。同一 Track への複数 PUBLISH が引き続き許容されることも検証する。
4. 衝突する組み合わせで cross-cancel が波及しないことを検証するテストを追加する。

## 完了条件

- 長さ付きキーにより、異なる Full Track Name が同じキーにならないこと。
- 同じ Full Track Name は同じキーになること (同一 Track への複数 PUBLISH が DUPLICATE_TRACK_ALIAS にならないこと)。
- 衝突する組み合わせで無関係な Track の購読 / FETCH が cancel されないこと。
- 上記を検証するテストがあること (`src/session/bidi.test.ts`、必要に応じて `src/session.test.ts` / `src/subscriber.test.ts` / `src/fetcher.test.ts`)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` に `[FIX]` を追加すること。

## 関連

- draft-ietf-moq-transport-21 §2.4.1 / §3.1 / §3.1.2
- `SubscriberImpl.getFullTrackName` (`src/subscriber.ts`) / `FetcherImpl.getFullTrackName` (`src/fetcher.ts`)
- `cancelMalformedTrackPeers` / `bidiReadSubscribeResponse` / `bidiReadFetchResponse` (`src/session/bidi.ts`) / `handleIncomingBidirectionalStream` (`src/session.ts`) / `src/session/incoming.ts`
- `issues/closed/0571-bug-pending-track-cross-cancel-missing.md` (pending の cross-cancel 追加)
- `issues/0575-bug-track-status-malformed-handling.md` (TRACK_STATUS_OK の malformed で本キー方式に追随する)
- `issues/closed/0557-bug-malformed-track-cross-cancel.md` (Full Track Name 比較の導入)

## 解決方法

Full Track Name の比較キーを、フィールド境界が一意に定まる長さ付きキーに統一し、区切り文字の曖昧さによる無関係な Track の cross-cancel を解消した。

- `src/fullTrackName.ts` に `fullTrackNameKey` を追加し、各 Track Namespace Field と Track Name を `${length}:${value}` の形で `"|"` 連結する比較キーを生成する (`draft-ietf-moq-transport-21` §2.4.1 のバイト列完全一致を JS 文字列表現で単射に写す)
- `SubscriberImpl.getFullTrackName` / `FetcherImpl.getFullTrackName` の戻り値を `fullTrackNameKey` が生成する比較キーに変更する (戻り値が Full Track Name そのものではないことを JSDoc に明記)
- 受信 PUBLISH の Track Alias 重複判定がインラインで `"/"` 連結していたのを `fullTrackNameKey` 経由に統一し、`getFullTrackName` と形式がずれて同一 Track への複数 PUBLISH が DUPLICATE_TRACK_ALIAS で閉じる退行を防ぐ
- `cancelMalformedTrackPeers` の引数名を `trackKey` に変更し、比較キーを渡すこと (生の Full Track Name を組み立てて渡さないこと) を JSDoc に明記する
- `src/fullTrackName.prop.ts` に同一性と単射性の PBT を追加し、`src/fullTrackName.test.ts` に旧実装が衝突していた具体例と空フィールド境界の回帰テストを追加する
- `src/session/bidi.test.ts` に区切り文字が衝突する別 Track を cross-cancel しないテストを、`src/session.test.ts` に同一 Track への複数 PUBLISH が DUPLICATE_TRACK_ALIAS にならないテストと衝突する別 Track が DUPLICATE_TRACK_ALIAS になるテストを追加する
- `CHANGES.md` の `## develop` に `[FIX]` を追加した
