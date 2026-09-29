# 検証の範囲を実装に合わせて広げる

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/update-ci-verification-scope
- Polished: 2026-09-30

## 目的

CI / prek / カバレッジの検証範囲がリポジトリの実態より狭い。壊れた変更を検出できない経路と、実装と一致しない検証表示が残っている。`AGENTS.md` は GitHub Actions を扱うとき `shiguredo-github-actions` スキルを参照することを求めており、実装時は同スキルに従うこと。

## 現状

- `.github/workflows/ci.yml` の build job は `vp test` と `vp run build` だけを実行する。`vp run build` は `package.json` の `build` (`vp pack`) であり、ライブラリのバンドルのみを検証する。`build:devtools` (`vp build devtools`) と `build:examples` (`vp build examples`) は ci.yml のどの job でも実行されない。devtools は `deploy-cloudflare.yml` (workflow_dispatch、手動) のときだけビルドされ、examples はどのワークフローでもビルドされない
- devtools は `src/` の内部モジュールを直接 import している (`devtools/src/hooks/usePublisher.ts` の `../../../src/createMediaPublisher.ts`、`devtools/src/codec-test/video.ts` の `../../../src/codec/VideoEncoder.ts` など)。内部の変更で devtools のビルドだけが壊れても、ci.yml の job はビルドしないため検出できない (`vp test` は vitest であり、e2e は devtools を `vp dev` で起動する)
- `prek.toml` の `vp-check` は `types_or = ["ts", "tsx", "javascript", "jsx", "css", "json"]` であり、markdown が無い。ドキュメントだけのコミットでは pre-commit の整形検証 (`vp check`) が走らない。CI の lint job はファイル指定なしで `vp check` を実行するため `.md` の整形は既に検証される (closed 0603、`ci.yml` のコメント。`paths-ignore` も `**.md` / `**.txt` を除外していない)。残るギャップは pre-commit (prek) のローカル検証だけである。`.md` は oxfmt の整形対象であり、`npx vp fmt` が箇条書きの記号と空行と行末空白を実際に書き換えることを確認した
- `vite.config.ts` の `test.coverage.exclude` が `src/message/debug.ts` を除外している。同ファイルの `getMessageTypeName` は `src/session/namespaces.ts` / `src/session/lifecycle.ts` / `src/session/namespaceLoops.ts` が使う本番コードであり、`src/message/session.test.ts` が `getMessageTypeName` を直接テストしている。テスト済みの本番実装がカバレッジ表示から 1 ファイル欠ける

## 設計方針

- CI に devtools / examples のビルド検証を追加する。job を増やすか既存の build job に足すかは `shiguredo-github-actions` スキルに従って決める
- `prek.toml` の `vp-check` の `types_or` に markdown を追加し、ドキュメントだけのコミットでも pre-commit の整形検証が走るようにする
- `vite.config.ts` の `test.coverage.exclude` から `src/message/debug.ts` を外す。除外はテスト設定の導入時 (`moq-transport-17 対応`) から理由の記録なしで存在しており、除外が必要な正当な理由が別にある場合は、その理由をコメントに残す

## 完了条件

- devtools / examples のビルドが CI で検証される
- markdown の整形が prek (pre-commit の `vp-check`) で検証される
- `vp test --coverage` のカバレッジ表示に `src/message/debug.ts` が含まれる
- CI の全 job が success になる

## 参照

- `.github/workflows/ci.yml` / `.github/workflows/deploy-cloudflare.yml` / `prek.toml` / `vite.config.ts` / `package.json`
- closed 0603 (CI の品質ゲート。`vp check` が `.md` の整形まで検証する根拠) / closed 0509 (devtools / examples のビルドをローカルで検証した実績)
- `AGENTS.md` (GitHub Actions では `shiguredo-github-actions` スキルを参照すること)

## 解決方法

{未着手}
