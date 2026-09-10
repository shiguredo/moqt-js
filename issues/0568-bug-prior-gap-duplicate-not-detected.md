# 同一 Object 内の Prior Group ID Gap / Prior Object ID Gap の複数出現が受信経路で検出されない

- Created: 2026-09-10
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-prior-gap-duplicate-detection
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §10.8 / §10.9 は「An Object contains more than one instance of Prior Group ID Gap / Prior Object ID Gap」を malformed Track の条件として定める。しかし現状、この検出は `src/properties.ts` の `parseProperties` にしかなく、受信経路が使う検証関数から呼ばれないため、違反した Object を受信しても malformed として扱われない。§12.1 の MUST (malformed Track の購読 / FETCH cancel) が機能しない。

## 現状

- 受信経路 (`src/dataStream.ts` の `decodeObjectFields` / `decodeObjectDatagram` / `decodeFetchObjectFields`) は `assertNoMandatoryTrackPropertyInObjectProperties` と `assertPriorIdGapInObjectProperties` を呼ぶ。
- `assertNoMandatoryTrackPropertyInObjectProperties` は内部で `assertObjectPropertyList` を呼び、Mandatory Track Property の混入と IMMUTABLE_PROPERTIES の複数出現・再帰のみを検証する。Prior Gap の出現回数は見ない。
- `assertPriorIdGapInObjectProperties` は `assertPriorIdGapInProperties` で「gap が Group ID / Object ID より大きい」ことだけを検証し、出現回数は見ない。
- 同一 Object 内の Prior Gap の複数出現を検出するコードは `parseProperties` にあるが、`parseProperties` は `src/properties.prop.ts` / `src/properties.test.ts` からのみ参照され、ランタイムの受信経路からは呼ばれない。
- 受信経路の検証関数 2 つに、同一 Object 内に PRIOR_GROUP_ID_GAP を 2 つ含む Properties を渡しても例外にならないことを確認済み。
- `parseProperties` の検出はトップレベルの Property 列のみを対象とし、IMMUTABLE_PROPERTIES 配下との合算は見ない。

## 設計方針

1. 受信経路の検証関数に Prior Gap の出現回数の検証を追加する。`assertObjectPropertyList` が IMMUTABLE_PROPERTIES 配下を再帰的に走査しているため、ここに PRIOR_GROUP_ID_GAP / PRIOR_OBJECT_ID_GAP のカウントを追加し、2 個目で `MalformedTrackError` を投げる。mutable list と IMMUTABLE_PROPERTIES 配下を合算して数える (§10.7)。
2. 受信経路の呼び出し構造は変更しない (`assertNoMandatoryTrackPropertyInObjectProperties` が subgroup / datagram / FETCH の全経路から呼ばれている)。
3. `parseProperties` の重複検出はテスト専用のため、ランタイムの検出は受信経路に一本化する。`parseProperties` 側の扱い (残す / 削除する) は実装時に判断する。

## 完了条件

- 同一 Object に PRIOR_GROUP_ID_GAP / PRIOR_OBJECT_ID_GAP が 2 回現れる Properties を subgroup / datagram / FETCH の各経路で受信した場合、malformed track として扱われること。
- mutable list と IMMUTABLE_PROPERTIES 配下を合わせて 2 回現れる場合も検出されること。
- 上記を検証するテストがあること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。

## 参照

- `refs/moq/draft-ietf-moq-transport-21.txt` §10.8 / §10.9 (Prior Group ID Gap / Prior Object ID Gap) / §10.7 (Immutable Properties) / §12.1 (Malformed Tracks)
- `assertObjectPropertyList` / `assertNoMandatoryTrackPropertyInObjectProperties` / `assertPriorIdGapInObjectProperties` / `parseProperties` (`src/properties.ts`)
- `decodeObjectFields` / `decodeObjectDatagram` / `decodeFetchObjectFields` (`src/dataStream.ts`)
- `issues/closed/0122-bug-immutable-properties-malformed-track-detection.md` (同一 Object 内の単一出現検証を追加した先行 issue)
- `issues/0569-add-prior-gap-track-tracking.md` (Track 横断の追跡検証。本 issue は単一 Object 内の出現回数)
