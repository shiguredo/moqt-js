# Event Timeline デコードが §8.1 のインデックス必須を検証していない

Created: 2026-04-04
Model: Composer 2 Fast

## なぜこの対応が必要か

[draft-ietf-moq-msf-00 §8.1](https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf-00#section-8.1) では、各レコードに **壁時計 `t` / Location `l` / Media PTS `m` のいずれか 1 つ** が必須とされ、同一レコード内で複数のインデックスは使えない。

`isEventTimelineEntry` は `data` の存在と型を主に見ており、`t` / `l` / `m` が **ちょうど 1 つ**であることの検証がない。コメントには「少なくとも 1 つが必要」とあるが、コードがそれを満たしていない（仕様の「ちょうど 1 つ」とも異なる）。

## 参照

- 実装: `src/msf.ts` の `isEventTimelineEntry`、`decodeEventTimeline`
- 仕様: [draft-ietf-moq-msf-00 §8.1 Event Timeline data format](https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf-00#section-8.1)

## 優先度

確認済み一覧の 2 位（issue 候補 B）。
