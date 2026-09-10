# Prior Group ID Gap / Prior Object ID Gap の Track 横断追跡検証を実装する

- Created: 2026-09-10
- Completed: {YYYY-MM-DD}
- Branch: feature/add-prior-gap-track-tracking
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §10.8 / §10.9 の malformed Track 条件のうち、複数 Object と Track 単位の受信状態を必要とする以下の 5 条件が未実装である。違反 Track を malformed として扱えず、§12.1 の MUST (購読 / FETCH の cancel) が機能しない。

- §10.8: A Group contains more than one Object with different values for Prior Group ID Gap
- §10.8: An endpoint receives an Object with a Prior Group ID Gap covering an Object it previously received
- §10.8: An endpoint receives an Object with a Group ID within a previously communicated gap
- §10.9: An endpoint receives an Object with a Prior Object ID Gap covering an Object it previously received
- §10.9: An endpoint receives an Object with an Object ID within a previously communicated gap

## 現状

- `src/properties.ts` の `assertPriorIdGapInObjectProperties` は単一 Object で判定できる「gap が Group ID / Object ID より大きい」のみ検証する。未実装の 5 条件は関数の doc コメントに列挙されている。
- Track 単位で「受信済み Object の Location」と「通知済み gap 範囲」を保持する状態がない。
- malformed 検出後の cancel は `src/session/bidi.ts` の `cancelMalformedTrackPeers` が Full Track Name 単位で購読 / FETCH を cancel する経路として既にある。

## 設計方針

1. Full Track Name 単位の追跡状態を追加する。受信済み Object の Location 集合と、通知された gap の範囲を保持する。同一 Track の複数購読 / FETCH をまたぐ必要があるため、購読単位ではなく Track 単位に置く。
2. 「gap が過去に受信した Object を覆う」は、gap が指す範囲 [現在の ID - gap, 現在の ID - 1] に受信済み Location が含まれる場合として判定する。`src/properties.ts` の `calculateSkippedGroups` / `calculateSkippedObjects` の考え方を再利用する。
3. 「過去に通知された gap 内の ID」は、後続 Object の Group ID / Object ID が既知の gap 範囲に含まれる場合として判定する。
4. 「同一 Group 内で異なる gap 値」は、Group 単位で最初に観測した gap 値を保持して比較する。
5. 検出時は `MalformedTrackError` を投げ、既存の malformed 処理 (`cancelMalformedTrackPeers` 等) に乗せる。
6. 追跡状態のメモリ上限と破棄タイミング (購読 / FETCH 終了、Track 終了) を定める。

## 完了条件

- 上記 5 条件それぞれについて malformed として検出されること。
- 検出時に同一 Track の購読 / FETCH が cancel され、セッションは閉じないこと。
- 正常系 (gap が既知の条件に該当しない場合) で誤検出しないこと。
- 上記を検証するテストがあること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` に `[ADD]` があること。

## 参照

- `refs/moq/draft-ietf-moq-transport-21.txt` §10.8 / §10.9 (Prior Group ID Gap / Prior Object ID Gap) / §12.1 (Malformed Tracks)
- `assertPriorIdGapInObjectProperties` / `calculateSkippedGroups` / `calculateSkippedObjects` (`src/properties.ts`)
- `cancelMalformedTrackPeers` (`src/session/bidi.ts`)
- `issues/0568-bug-prior-gap-duplicate-not-detected.md` (同一 Object 内の出現回数。本 issue は Track 横断)
- `issues/0561-add-end-of-group-tracking.md` (同じく Track 横断の malformed 追跡)
