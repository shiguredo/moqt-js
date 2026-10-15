/**
 * 空きポートを取って 1 行ずつ出力する
 *
 * `playwright.config.ts` が同期でポートを取るために使う。Playwright の設定は同期の
 * オブジェクトでなければならない (`async` の関数を返すと "Configuration file must export
 * a single object" で起動できない。実測) ため、`bind(0)` で OS に選ばせて番号を読む処理
 * だけをこの子プロセスで行い、結果を同期で受け取る。
 *
 * 使い方: `node tests/e2e/free-ports.mjs 3` (3 行出力する)
 */
import { createServer } from "node:net";

const count = Number(process.argv[2] ?? "1");

/** 空きポートを 1 つ取る (`bind(0)` で OS に選ばせ、番号を読んでから閉じる) */
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("the address could not be read");
  }
  const port = address.port;
  await new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

const ports = await Promise.all(Array.from({ length: count }, () => freePort()));
process.stdout.write(ports.join("\n"));
