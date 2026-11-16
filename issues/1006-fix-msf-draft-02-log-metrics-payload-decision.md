# log / metrics の payload 契約の不一致を決着させる

- Created: 2026-11-16
- Completed: {YYYY-MM-DD}
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

D-32 を決着させる。MSF 本文 §9.1 / §10.1 は companion draft に従う MUST を置くが、§9.3 / §10.3 は独自契約も定めており実装と一致しない。

## 設計方針

- companion draft (log-04 / metrics-03) を正とする
- 決定を `docs/IMPLEMENTATION_STATUS.md` と `docs/MSF.md` に明記する
- MSF 本文の独自契約に合わせる変更は行わない

## 完了条件

- 決定が docs に明記されている
- 実装のコメントが決定と一致している
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る
