# devtools のフッターが draft-15 を参照している

Created: 2026-03-29
Model: Opus 4.6

## 概要

devtools のフッターに表示されている RFC リンクとテキストが draft-15 のままになっている。実装は draft-17 ベースであるため更新が必要。

## RFC 根拠

本ライブラリは draft-ietf-moq-transport-17 に基づいて実装されている。ソースコード中のコメント (`src/session.ts`, `src/dataStream.ts` 等) や SETUP メッセージのバージョンネゴシエーションも draft-17 を対象としている。devtools のフッターが draft-15 を参照していると、ユーザーに誤った情報を与える。

## 該当箇所

- `devtools/src/App.tsx` 行 181-186

```tsx
href="https://datatracker.ietf.org/doc/html/draft-ietf-moq-transport-15"
...
draft-ietf-moq-transport-15
```

## 修正方針

draft-ietf-moq-transport-17 へリンクとテキストを更新する。
