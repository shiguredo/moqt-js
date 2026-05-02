/**
 * Playwright E2E 用のエントリポイント
 *
 * window.__moqtE2E にヘルパーを露出する。Playwright の page.evaluate からは
 * connectSession() を呼んで Session の `state` を返す。
 *
 * draft-ietf-moq-transport-17 Section 9.4.1 (SETUP Message)
 */

import { connect, AuthorizationTokenAliasType } from "moqt-js";
import type { AuthorizationToken } from "moqt-js";

interface ConnectSessionOptions {
  url: string;
  // TEST_MOQT_AUTH_TOKEN の生文字列。UTF-8 encode して USE_VALUE で送る
  authorizationTokenValue?: string;
}

declare global {
  interface Window {
    __moqtE2E: {
      connectSession(opts: ConnectSessionOptions): Promise<string>;
    };
  }
}

window.__moqtE2E = {
  async connectSession({ url, authorizationTokenValue }) {
    let authorizationToken: AuthorizationToken | undefined;
    if (authorizationTokenValue) {
      authorizationToken = {
        aliasType: AuthorizationTokenAliasType.USE_VALUE,
        tokenType: 0n,
        tokenValue: new TextEncoder().encode(authorizationTokenValue),
      };
    }

    const session = await connect(
      url,
      {
        close: () => {},
        error: () => {},
      },
      authorizationToken ? { authorizationToken } : {},
    );

    const state = session.state;
    await session.close();
    return state;
  },
};

const statusElement = document.getElementById("status");
if (statusElement) {
  statusElement.textContent = "loaded";
}
