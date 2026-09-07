# subgroup と fetch の fan-out にも通知と継続の防御を検討する

- Created: 2026-09-07
- Completed: YYYY-MM-DD
- Branch: feature/fix-fanout-error-continue
- Polished: YYYY-MM-DD

## 目的

同一 alias の複数購読への配送で 1 件目のアプリ例外が残りの配送とストリーム処理を止める。datagram 経路と同様に通知して継続するか仕様整理する必要がある。

## 現状

- `src/session/stream.ts` の subgroup 配送は捕捉なしで回すため、1 件目のアプリ例外で 2 件目に届かず当該ストリーム全体も中断する。
- fetch の配送も同形である。
- datagram 経路は通知して継続する対応済みのため、同一 alias 複数購読の振る舞いが経路間で分かれている。

## 設計方針

1. subgroup と fetch に datagram と同形の防御（通知して継続する、ないし仕様整理する）を検討する。

## 完了条件

- 方針が決まり各経路の振る舞いが統一されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §5.1 / §2.2
