# Object Property の Mandatory Track Property を malformed として検出する

- Created: 2026-09-08
- Completed: YYYY-MM-DD
- Branch: feature/fix-object-mandatory-track-property
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-transport-20 §2.5.1 は「An Object received with a Mandatory Track Property as an Object Property is malformed (see Section 2.4.2).」と定める。現状は Object Properties の ID を解釈しないため、Mandatory Track Property (0x4000-0x7FFF) を含む不正な Object を受理してしまう。

## 現状

- `src/dataStream.ts` の `decodeObjectFields` は Properties を宣言バイト数で切り出すだけで、Property ID をデコードしない。
- Object Properties を解釈する唯一の経路 `src/properties.ts` の `decodeObjectPropertiesTolerant` にも 0x4000-0x7FFF の判定がない。
- 対照的に Track Properties 側は `parseProperties` / `decodeProperties` が 0x4000-0x7FFF で `MalformedTrackError` を投げる。
- `decodeObjectPropertiesTolerant` は delta 加算の 2^64-1 超過検査も行わない（§1.4.3 の MUST）。

## 設計方針

1. Object Properties を受信する経路で、Mandatory Track Property 範囲の Property を検出したら `MalformedTrackError` とする。
2. §2.4.2 に従い、購読経路で検出した malformed track は当該購読を cancel する（既存の MalformedTrack 処理方針と揃える）。FETCH 経路の扱いも §2.4.2 に合わせる。
3. `decodeObjectPropertiesTolerant` に delta 加算の 2^64-1 超過検査を追加する。寛容デコードは LOC 抽出用に維持しつつ、malformed 判定は別経路で行う。
4. Mandatory Track Property を含む Object Property が malformed として扱われるテストを追加する。

## 完了条件

- Object Property に 0x4000-0x7FFF の未知 Property を含む Object が malformed として扱われること。
- 当該購読 / fetch が §2.4.2 に従って cancel されること。
- `decodeObjectPropertiesTolerant` が delta 加算の 2^64-1 超過で `ProtocolViolationError` を投げること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §2.5.1 / §2.4.2 / §1.4.3 / §12.7
- `decodeObjectFields` / `processSubgroupObjects`
- `decodeObjectPropertiesTolerant` / `parseProperties` / `decodeProperties`
