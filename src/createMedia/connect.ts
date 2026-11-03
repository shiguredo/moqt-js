/**
 * createMediaPublisher / createMediaSubscriber の接続処理
 *
 * 2 クラスが一字一句同一だった接続処理を 1 箇所に集約する。
 * 接続オプションの組み立て (証明書ハッシュ / 認可トークン / pending subgroup) と、
 * セッションの close / error / goaway を各クラスのコールバックへ橋渡しする。
 */

import { connect } from "../connect";
import type { AuthorizationToken } from "../message/authorizationToken";
import type { PendingSubgroupBufferOptions } from "../pendingSubgroupBuffer";
import type { ConnectCallbacks, ConnectOptions, Session } from "../session";

/** 接続に必要な設定 */
export interface MediaConnectSettings {
  /** 接続先 URL (moqt:// / https://) */
  url: string;
  /** 自己署名証明書用のハッシュ (省略時は証明書検証をしない) */
  serverCertificateHashes?: ArrayBuffer[];
  /** 認可トークン */
  authorizationToken?: AuthorizationToken;
  /** 保留中 Subgroup のバッファ設定 (部分指定可) */
  pendingSubgroup?: Partial<PendingSubgroupBufferOptions>;
  /** セッションが閉じられたときの通知 (state 遷移と onClose 呼び出し) */
  onSessionClose(): void;
  /** セッションのエラー通知 */
  onSessionError(error: Error): void;
  /**
   * GOAWAY 受信の通知 (新しい Session URI)
   *
   * draft-ietf-moq-transport-22 §9.2 (根拠の仕様はドラフトであり将来変更される
   * 可能性がある):
   * "The client MUST use this URI for the new session if provided. If the URI
   *  is zero bytes long, the current URI is reused instead."
   * 高レベル API は再接続を自動で行わないため、URI をアプリへ渡す。
   * 新しい Session URI が 0 バイトのときは空文字列が渡る (現在の URI を再利用する)。
   */
  onSessionGoaway(newSessionUri: string): void;
}

/**
 * MOQT セッションへ接続する
 *
 * @param settings - 接続設定と通知先
 * @returns 接続済みの Session
 */
export async function connectMediaSession(settings: MediaConnectSettings): Promise<Session> {
  const connectCallbacks: ConnectCallbacks = {
    close: () => settings.onSessionClose(),
    error: (error) => settings.onSessionError(error),
    goaway: (newSessionUri) => settings.onSessionGoaway(newSessionUri),
  };

  const connectOptions: ConnectOptions = {};
  if (settings.serverCertificateHashes && settings.serverCertificateHashes.length > 0) {
    connectOptions.serverCertificateHashes = settings.serverCertificateHashes.map((hash) => ({
      algorithm: "sha-256" as const,
      value: hash,
    }));
  }
  if (settings.authorizationToken) {
    connectOptions.authorizationToken = settings.authorizationToken;
  }
  if (settings.pendingSubgroup) {
    connectOptions.pendingSubgroup = settings.pendingSubgroup;
  }

  return connect(settings.url, connectCallbacks, connectOptions);
}
