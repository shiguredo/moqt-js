# テスト

```bash
vp test
```

E2E テスト (Playwright) の実行方法は [E2E テスト](E2E_TEST.md) を参照してください。

新しい PBT は `@fast-check/vitest` の `test.prop` を使います。既存の `fast-check` と
`fc.assert` による試験も同じ生成・縮小の仕組みを使うため維持し、記法の変更だけを目的とする
一括置換は行いません。各試験内では記法を統一します。
