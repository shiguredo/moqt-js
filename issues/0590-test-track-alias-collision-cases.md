# Track 同一性判定の区切り文字衝突ケースを SUBSCRIBE_OK / FETCH_OK / TRACK_STATUS_OK / Datagram 経路にも追加する

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/test-track-alias-collision-cases
- Polished: {YYYY-MM-DD}

## 目的

Track の同一性判定は `fullTrackNameKey` が生成する比較キーの完全一致で行う。キーの単射性は PBT で検証されているが、経路ごとの判定が「区切り文字の曖昧さで衝突しやすい組み合わせ」を正しく分離することは、`cancelMalformedTrackPeers` と受信 PUBLISH の 2 経路しか固定されていない。他の経路で 0574 と同種の退行 (別 Track を同一とみなす / 同一 Track を別とみなす) が再発しても検出できない。

## 現状

- 区切り文字衝突の組み合わせ (Track Namespace `["a"]` + Track Name `"b/c"` と Track Namespace `["a","b"]` + Track Name `"c"`) を使うテストは、`src/session/bidi.test.ts` の `cancelMalformedTrackPeers` と `src/session.test.ts` の受信 PUBLISH の 2 経路のみ。
- `src/session/bidi.ts` の `bidiReadSubscribeResponse` の Track Alias 重複判定 (`DUPLICATE_TRACK_ALIAS`) のテストは `["test"], "track"` と `["other"], "track"` の単純不一致のみで、衝突する組み合わせを固定していない。
- `src/session/bidi.ts` の `bidiReadFetchResponse` の malformed 応答 (FETCH_OK の未知 Mandatory Track Property) の cross-cancel テストは単一 Track のみで、衝突する別 Track を巻き込まないことを固定していない。
- `src/session/bidi.ts` の `bidiReadTrackStatusResponse` の malformed 応答 (TRACK_STATUS_OK の未知 Mandatory Track Property) の cross-cancel テストも単一 Track (`["test"], "track"`) のみ。
- `src/session/incoming.ts` の `incomingHandleDatagram` の malformed 検出は、`subscribersByAlias` から得た購読の比較キーで対象 Track を決めるが、衝突する別 Track が同一 alias にぶら下がるケースのテストが無い。

## 設計方針

1. 各経路に「区切り文字は衝突するが別 Track である 2 件」を用意し、対象 Track だけが判定される (誤って一致しない) ことを検証する。
2. 追加先は `src/session/bidi.test.ts` (SUBSCRIBE_OK / FETCH_OK / TRACK_STATUS_OK) と `src/session/incoming.test.ts` (Datagram)。既存テストと同じく `SubscriberImpl` / `FetcherImpl` を直接組み立て、`ReadableStream` / `WritableStream` を実体で用意する (モック・スタブは使わない)。
3. 各テストは比較キーの生成を `"/"` 連結に差し替えると落ちることを実装時に確認する (0574 の退行を検出できるテストであることの裏付け)。
4. 判定の実装は変えない (テスト追加のみ)。

## 完了条件

- 4 経路それぞれに区切り文字衝突ケースのテストがあること。
- 各テストが比較キー生成を `"/"` 連結に戻すと落ちること (実装時に確認する)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加すること (テスト追加のため)。

## 関連

- `bidiReadSubscribeResponse` / `bidiReadFetchResponse` / `bidiReadTrackStatusResponse` / `cancelMalformedTrackPeers` (`src/session/bidi.ts`)
- `incomingHandleDatagram` (`src/session/incoming.ts`) / `fullTrackNameKey` (`src/fullTrackName.ts`)
- `issues/closed/0574-bug-full-track-name-collision.md` (比較キーを長さ付きにした issue)
- `issues/0579-test-bidi-response-missing-branches.md` (bidi 応答読み取りの未カバー分岐のテスト追加)
