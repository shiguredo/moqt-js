# 同一 Object 内の Prior Group ID Gap / Prior Object ID Gap の複数出現が受信経路で検出されない

- Created: 2026-09-10
- Completed: 2026-09-12
- Branch: feature/fix-prior-gap-duplicate-detection
- Polished: 2026-09-11

## 目的

draft-ietf-moq-transport-21 §10.8 / §10.9 は「An Object contains more than one instance of Prior Group ID Gap / Prior Object ID Gap」を malformed Track の条件として定める。しかし現状、この検出は `src/properties.ts` の `parseProperties` にしかなく、受信経路が使う検証関数から呼ばれないため、違反した Object を受信しても malformed として扱われない。§12.1 の MUST (malformed Track の購読 / FETCH cancel) が機能しない。

## 現状

- 受信経路は `assertNoMandatoryTrackPropertyInObjectProperties` と `assertPriorIdGapInObjectProperties` を呼ぶ。内訳は `src/dataStream.ts` の `decodeObjectDatagram` と `decodeFetchObjectFields` が両方を呼び、subgroup 経路は `decodeObjectFields` が前者を、`src/session/stream.ts` の `processSubgroupObjects` が後者を分担して呼ぶ。
- `assertNoMandatoryTrackPropertyInObjectProperties` は内部で `assertObjectPropertyList` を呼び、Mandatory Track Property の混入と IMMUTABLE_PROPERTIES の複数出現・再帰のみを検証する。Prior Gap の出現回数は見ない。
- `assertPriorIdGapInObjectProperties` は `assertPriorIdGapInProperties` で「gap が Group ID / Object ID より大きい」ことだけを検証し、出現回数は見ない。
- 同一 Object 内の Prior Gap の複数出現を検出するコードは `parseProperties` にあるが、`parseProperties` は `src/properties.prop.ts` / `src/properties.test.ts` からのみ参照され、ランタイムの受信経路からは呼ばれない。
- 受信経路の検証関数 2 つに、同一 Object 内に PRIOR_GROUP_ID_GAP を 2 つ含む Properties を渡しても例外にならないことを確認済み。
- `parseProperties` の検出はトップレベルの Property 列のみを対象とし、IMMUTABLE_PROPERTIES 配下との合算は見ない。

## 設計方針

1. 受信経路の検証関数に Prior Gap の出現回数の検証を追加する。`assertObjectPropertyList` が IMMUTABLE_PROPERTIES 配下を再帰的に走査しているため、ここに PRIOR_GROUP_ID_GAP / PRIOR_OBJECT_ID_GAP のカウントを追加し、2 個目で `MalformedTrackError` を投げる。カウントは再帰呼び出しを跨いで共有する (引数または戻り値で受け渡す。既存の `immutableCount` のようなローカル変数では内側と外側の合算ができない)。mutable list と IMMUTABLE_PROPERTIES 配下を合算して数える (§10.7 / §10.8 / §10.9)。
2. 受信経路の呼び出し構造は変更しない (`assertNoMandatoryTrackPropertyInObjectProperties` が subgroup / datagram / FETCH の全経路から呼ばれている)。
3. `parseProperties` はテスト専用 (`src/properties.prop.ts` / `src/properties.test.ts` からのみ参照され、`src/index.ts` で再エクスポートされない) のため、本 issue では変更しない。ランタイムの出現回数検出は受信経路の検証関数に追加し、`parseProperties` 側はテスト専用の厳密パーサとして現状維持する (テスト 18 件の改修を伴う削除・統合は本 issue の範囲外)。

## 完了条件

- 同一 Object に PRIOR_GROUP_ID_GAP / PRIOR_OBJECT_ID_GAP が 2 回現れる Properties を subgroup / datagram / FETCH の各経路で受信した場合、malformed track として扱われること。
- mutable list と IMMUTABLE_PROPERTIES 配下を合わせて 2 回現れる場合も検出されること。
- 上記を検証するテストがあること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。

## 参照

- `refs/moq/draft-ietf-moq-transport-21.txt` §10.8 / §10.9 (Prior Group ID Gap / Prior Object ID Gap) / §10.7 (Immutable Properties) / §12.1 (Malformed Tracks)
- `assertObjectPropertyList` / `assertNoMandatoryTrackPropertyInObjectProperties` / `assertPriorIdGapInObjectProperties` / `parseProperties` (`src/properties.ts`)
- `decodeObjectFields` / `decodeObjectDatagram` / `decodeFetchObjectFields` (`src/dataStream.ts`) / `processSubgroupObjects` (`src/session/stream.ts`)
- `issues/closed/0122-bug-immutable-properties-malformed-track-detection.md` (同一 Object 内の単一出現検証を追加した先行 issue)
- `issues/0569-add-prior-gap-track-tracking.md` (Track 横断の追跡検証。本 issue は単一 Object 内の出現回数)

## 解決方法

- `src/properties.ts` の `assertObjectPropertyList` に Prior Gap の出現回数の検証を追加した。`PRIOR_GROUP_ID_GAP` / `PRIOR_OBJECT_ID_GAP` を数え、2 個目で `MalformedTrackError` を送出する。カウントは省略可能な引数 (`priorGapCounts`) で再帰呼び出しに持ち回り、mutable list と `IMMUTABLE_PROPERTIES` 配下を合算する (§10.7 の「双方を検索する」)。トップレベルの呼び出しでは新しいカウンタを作るため Object をまたいで持ち越さない。
- 受信経路の呼び出し構造 (`assertNoMandatoryTrackPropertyInObjectProperties` を subgroup / datagram / FETCH から呼ぶ) と、テスト専用の `parseProperties` 側の実装は変更していない。
- テストを 11 件追加した。`assertNoMandatoryTrackPropertyInObjectProperties` の単体 5 件 (mutable list の複数出現 × 2 / mutable と `IMMUTABLE_PROPERTIES` の合算 / `IMMUTABLE_PROPERTIES` 内の 2 回 / 各 1 回は誤検出しない) と、経路別 6 件 (`decodeObjectFields` / `processSubgroupObjects` / `decodeObjectDatagram` / `decodeFetchObjectFields`) である。修正前のコードでは 11 件すべてが失敗する。
- 触ったファイル: `src/properties.ts`、`src/properties.test.ts`、`src/dataStream.subgroup.test.ts`、`src/dataStream.datagram.test.ts`、`src/dataStream.fetch.test.ts`、`src/session/stream.test.ts`、`CHANGES.md`。
