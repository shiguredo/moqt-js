# getFullTrackName の文字列連結が非単射で無関係な Track を cross-cancel し得る

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-full-track-name-collision
- Polished: {YYYY-MM-DD}

## 目的

Track の同一性判定は Full Track Name (trackNamespace + trackName) で行う (draft-ietf-moq-transport-21 §2.4.1)。現状は namespace 配列を `/` で連結した文字列で比較しており、単射でないため異なる Track が同じ文字列になる。malformed 検出時の cross-cancel はこの文字列一致だけで cancel 対象を決めるため、悪意あるピアが malformed を発生させて無関係な既存購読 / FETCH を巻き込める。

## 現状

- `src/subscriber.ts` の `SubscriberImpl.getFullTrackName` と `src/fetcher.ts` の `FetcherImpl.getFullTrackName` は `${namespace.join("/")}/${trackName}` を返す。
- Track Namespace の各要素と Track Name に `/` を許すため、namespace `["a"]` + trackName `"b/c"` と namespace `["a","b"]` + trackName `"c"` が同じ `"a/b/c"` になる。
- この文字列は `cancelMalformedTrackPeers` の走査 (`src/session/bidi.ts`)、`bidiReadSubscribeResponse` の Track Alias 重複判定、`src/session/incoming.ts` と `src/session.ts` の Track 特定で使われる。
- 同一性判定が衝突すると、malformed 検出時に無関係な Track の購読 / FETCH を cancel し得る。

## 設計方針

1. Full Track Name の同一性判定を非単射でない方法に変更する。namespace 配列と trackName のタプル比較、またはフィールド境界が曖昧にならない長さ付きキーを使う。
2. `getFullTrackName` の呼び出し箇所 (`cancelMalformedTrackPeers` / `bidiReadSubscribeResponse` / `incoming` / `session`) を洗い出し、比較方法を統一する。
3. 衝突する組み合わせで cross-cancel が波及しないことを検証するテストを追加する。

## 完了条件

- 異なる Full Track Name が同じキーにならないこと。
- 衝突する組み合わせで無関係な Track の購読 / FETCH が cancel されないこと。
- 上記を検証するテストがあること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` に `[FIX]` を追加すること。

## 関連

- draft-ietf-moq-transport-21 §2.4.1
- `SubscriberImpl.getFullTrackName` (`src/subscriber.ts`) / `FetcherImpl.getFullTrackName` (`src/fetcher.ts`)
- `cancelMalformedTrackPeers` (`src/session/bidi.ts`) / `src/session/incoming.ts` / `src/session.ts`
- `issues/closed/0557-bug-malformed-track-cross-cancel.md` (Full Track Name 比較の導入)
