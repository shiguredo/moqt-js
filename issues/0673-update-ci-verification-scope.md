# CI と prek の検証範囲を実装に合わせて広げる

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/update-ci-verification-scope
- Polished: {YYYY-MM-DD}

## 目的

CI と prek の検証範囲がリポジトリの実態より狭く、壊れても検出できない経路がある。`AGENTS.md` は GitHub Actions を扱うとき `shiguredo-github-actions` スキルを参照することを求めており、実装時は同スキルに従うこと。

## 現状

- `.github/workflows/ci.yml` の build job は `vp test` と `vp run build` だけを実行する。`vp run build` は `package.json` の `build` (`vp pack`) であり、ライブラリのバンドルのみを検証する。`build:devtools` (`vp build devtools`) と `build:examples` (`vp build examples`) はどの job でも実行されない
- devtools は `src/` の内部モジュールを直接 import している (`devtools/src/hooks/usePublisher.ts` の `../../../src/createMediaPublisher.ts`、`devtools/src/codec-test/video.ts` の `../../../src/codec/VideoEncoder.ts` など)。内部の変更で devtools のビルドだけが壊れても CI で検出できない
- `prek.toml` の `vp-check` は `types_or = ["ts", "tsx", "javascript", "jsx", "css", "json"]` であり、markdown / yaml / html が無い。ドキュメントだけのコミットでは整形検証が走らない。`.md` は oxfmt の整形対象であり、`npx vp fmt` が箇条書きの記号と空行と行末空白を実際に書き換えることを確認した (`ci.yml` の `paths-ignore` も `**.md` / `**.txt` を vp check の整形検証対象として除外していない)
- `vite.config.ts` の `test.coverage.exclude` が `src/message/debug.ts` を除外している。同ファイルの `getMessageTypeName` は `src/session/namespaces.ts` / `src/session/lifecycle.ts` / `src/session/namespaceLoops.ts` が使う本番コードであり、カバレッジ表示から実装が 1 ファイル欠ける

## 設計方針

- CI に devtools / examples のビルド検証を追加する。job を増やすか既存の build job に足すかは `shiguredo-github-actions` スキルに従って決める
- `prek.toml` の `vp-check` の `types_or` に markdown を追加し、ドキュメントだけのコミットでも整形検証が走るようにする
- `vite.config.ts` の `coverage.exclude` から `src/message/debug.ts` を外す。除外が必要な正当な理由が別にある場合は、その理由をコメントに残す

## 完了条件

- devtools / examples のビルドが CI で検証される
- markdown の整形が prek で検証される
- カバレッジ表示に `src/message/debug.ts` が含まれる
- CI の全 job が success になる

## 参照

- `.github/workflows/ci.yml` / `prek.toml` / `vite.config.ts` / `package.json`
- `AGENTS.md` (GitHub Actions では `shiguredo-github-actions` スキルを参照すること)

## 解決方法

{未着手}
