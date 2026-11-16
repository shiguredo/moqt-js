# accessibleWindowTime を実装する

- Created: 2026-11-16
- Completed: {YYYY-MM-DD}
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

draft-02 §5.2.45 は track フィールド `accessibleWindowTime` を追加した。ライブエッジから何ミリ秒後ろまで内容が取得できるかを表し、DVR 窓の実装に使う。§7 は publisher に media timeline を accessible window に合わせて trim することを SHOULD、subscriber に media timeline に基づく取得の前に本値を適用することを MUST とする。§5.2.45 は同じ alternate group のトラックが同じ値を持つことを MUST とする。

現行実装に本フィールドは無く、DVR 窓の概念も無い。

## 現状

- `src/msf/types.ts` の `CatalogTrack` に `accessibleWindowTime` が無い
- `src/msf/catalogTrackValidation.ts` は本フィールドを未知フィールドとして保持するだけで、型も範囲も検証しない
- `src/msf/timeline.ts` の `decodeMediaTimeline` は media time 順であることを検証せず、accessible window の適用も無い
- `src/playout/` は media timeline を参照しないため、DVR 窓の制約を受けていない
- `src/createMediaPublisher.ts` は media timeline track を生成しない

## 設計方針

- `CatalogTrack.accessibleWindowTime` を `number` として追加し、有限で非負であることを検証する
- `altGroup` が同じ track どうしで値が一致することを検証する。`assertTrackNameUnique` と同じく catalog 全体を見る層で検査する
- media timeline を取得する経路で、現在の wallclock から `accessibleWindowTime` を引いた閾値より前のエントリを除外できるようにする。判定は純関数として切り出し、単体テストで固定する
- publisher は media timeline を生成していないため、trim の SHOULD は本 issue では実装しない。media timeline の生成に着手するときに併せて扱う
- `isLive` が false の track では本値を無視する

## 完了条件

- `accessibleWindowTime` を持つ track を encode / decode でき、負値と非有限値を拒否する。単体テストで固定する
- 同じ `altGroup` で `accessibleWindowTime` が異なる catalog を拒否する。単体テストで固定する
- accessible window の閾値計算と、閾値より前の media timeline エントリの除外を単体テストで固定する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る
