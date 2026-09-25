# moqt-devtools のタイトルから、対応している MOQT の draft が分からない

- Created: 2026-09-25
- Completed: 2026-09-25
- Branch: feature/update-devtools-title-draft-version
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-devtools の見出しは「MOQT DevTools」だけで、どの draft の MOQT に対応しているかは画面の下の方 (フッター) にしか出ていない。利用者から「たいとるの MOQT DevTools に MOQT DevTools (draft-21) みたいな感じでアピールして、draft-21 にはリンクを」と要望があった。見出しに対応している draft を出し、draft の文書へのリンクにする。

## 現状

- `devtools/src/App.tsx` の見出し (`h1`) は「MOQT DevTools」
- 同じファイルのフッターに、draft-ietf-moq-transport-21 の文書 (`https://datatracker.ietf.org/doc/html/draft-ietf-moq-transport-21`) へのリンクがある
- `devtools/index.html` の `<title>` も「MOQT DevTools」

## 設計方針

- 見出しを「MOQT DevTools (draft-21)」にし、「draft-21」を draft-ietf-moq-transport-21 の文書へのリンク (新しいタブで開く) にする
- ページの `<title>` も「MOQT DevTools (draft-21)」にそろえる
- 文書の URL は、見出しとフッターで同じ定数を使う

## 完了条件

- 見出しに「MOQT DevTools (draft-21)」が出て、「draft-21」から draft-ietf-moq-transport-21 の文書を開ける
- `vp check` / `tsc --noEmit` / `vp test run` / 既存の Playwright の E2E が通る

## 解決方法

- `devtools/src/App.tsx` の見出しを「MOQT DevTools (draft-21)」にし、「draft-21」を draft-ietf-moq-transport-21 の文書へのリンク (新しいタブで開く、`data-testid="moqt-draft-link"`) にした。文書の URL は定数 `MOQT_TRANSPORT_DRAFT_URL` にし、見出しとフッターで使う
- `devtools/index.html` の `<title>` も「MOQT DevTools (draft-21)」にした
- 手元の devtools で、見出しとページのタイトルが「MOQT DevTools (draft-21)」になり、リンク先が draft-ietf-moq-transport-21 の文書であることを確かめた
- `vp check` / `tsc --noEmit` / `vp test run` (2807 件) / 既存の Playwright の E2E (40 件) が通った
