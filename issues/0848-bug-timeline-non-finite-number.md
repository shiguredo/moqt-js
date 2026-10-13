# Media / Event Timeline の数値が非有限数でも受理され、再 encode で自分で decode できなくなる

- Created: 2026-10-14
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-timeline-non-finite-number

## 目的

`decodeMediaTimeline` / `decodeEventTimeline` は数値の型 (`typeof === "number"`) だけを見るため、桁あふれした数値リテラル (`1e999`) を `Infinity` として受理する。受理した値を `encodeMediaTimeline` / `encodeEventTimeline` に渡すと `JSON.stringify` が非有限数を `null` にし、その出力を自分の decode が拒否する。Catalog では同じ穴を `assertFiniteNumber` で塞いだ (issues/closed/0693-bug-encode-catalog-validation.md) が、Timeline には残っている。

## 現状

- `src/msf/timeline.ts` の `isMediaTimelineEntry` は `mediaPts` / `location` の 2 要素 / `wallclock` の型だけを見る (有限性は見ない)
- `src/msf/timeline.ts` の `isEventTimelineEntry` は `t` / `l` の 2 要素 / `m` の型だけを見る (有限性は見ない)
- 実測: `decodeMediaTimeline(new TextEncoder().encode("[[1e999,[0,0],0]]"))` は `Infinity` を返し、その戻り値を `encodeMediaTimeline` に渡すと `[[null,[0,0],0]]` になり、`decodeMediaTimeline` が `invalid media timeline entry at index 0` で拒否する。Event Timeline の `t` / `m` も同様である
- `src/msf/json.ts` の `assertFiniteNumber` は値が有限でなければ `Error` を投げる。Catalog の track 検証 (`src/msf/catalogTrackValidation.ts`) と `generatedAt` の検証 (`src/msf/catalogValidation.ts` / `src/msf/catalogCodec.ts`) から使っている
- `JSON.parse` は桁あふれした数値リテラルを `Infinity` にするため、decode 経路でも同じ値が現れる

## 設計方針

- `isMediaTimelineEntry` / `isEventTimelineEntry` で `Number.isFinite` を見る (`assertFiniteNumber` は Catalog のエラー文言用の helper であり、Timeline の検証は boolean を返す関数のため、ここでは `Number.isFinite` を直接使う)
- 非有限数は「自分で decode できない値」であるため受理しない。Catalog と同じく decode の受理集合が狭くなる (従来 `1e999` を受理していた入力が throw になる)
- 対象は `src/msf/timeline.ts` と `src/msf.prop.ts` / 単体テスト。公開 API のシグネチャは変わらない (throw が増える)

## 完了条件

- `decodeMediaTimeline` が `[[1e999,[0,0],0]]` を reject する
- `decodeEventTimeline` が `[{"t":1e999,"data":"x"}]` と `[{"m":1e999,"data":"x"}]` を reject する
- 有限数の round-trip は従来どおり通る (PBT を含む)
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 参照

- ECMA-262 の `JSON.stringify` (非有限数を null にする) / `JSON.parse` (桁あふれした数値リテラルを Infinity にする)
- draft-ietf-moq-msf-01 §7.1 (Media Timeline の wire 形式) / §8.1 (Event Timeline の wire 形式)
- `src/msf/timeline.ts` の `encodeMediaTimeline` / `decodeMediaTimeline` / `isMediaTimelineEntry` / `encodeEventTimeline` / `decodeEventTimeline` / `isEventTimelineEntry`
- `src/msf/json.ts` の `assertFiniteNumber`
- closed `0693-bug-encode-catalog-validation.md` (Catalog で同じ穴を塞いだ。「残した課題」に本件がある)

## 解決方法

{未着手}
