# 再起動時の PRIOR_GROUP_ID_GAP を送信する

- Created: 2026-11-16
- Completed: {YYYY-MM-DD}
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

D-34 を実装する。§6.1 は再起動を跨いで前の Group ID を知っている publisher が gap を通知する SHOULD を定める。

## 現状

- `encodePriorGroupIdGap` と `noteGroupId` はあるが送信経路が無い

## 設計方針

- publisher の開始時に、前回最後に送った Group ID との差が分かる場合、最初の Object に `PRIOR_GROUP_ID_GAP` を載せる
- 新規起動で差が分からない場合は載せない

## 完了条件

- 再開時に最初の Object に gap が載る。単体テストで固定する
- 新規起動では載らない。単体テストで固定する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る
