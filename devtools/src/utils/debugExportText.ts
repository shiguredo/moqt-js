import type { ConnectionSettingsSnapshot } from "../signals/connectionSettingsSnapshot";
import type { LogEntry } from "../signals/debugLog";
import type { PublisherStats, SubscriberStats } from "../signals/statsSnapshot";
import { formatBytes, formatHexDump, formatMessageData } from "./logFormatters";

/**
 * 「Copy for LLM」でコピーするテキストの整形
 *
 * 不具合の報告に使うテキストのため、節を出す順と見出しは変えずに、項目は
 * スナップショット (`signals/connectionSettingsSnapshot.ts` /
 * `signals/statsSnapshot.ts`) のキーから組み立てる。項目を手書きで列挙すると、
 * 設定や統計を足したときにコピー本文へ足し忘れる。
 *
 * 外部 signal は参照せず、渡された値だけで組み立てる純粋関数にしてある (スナップショットの
 * 型だけを借りる)。呼び出し側 (`signals/debugExport.ts`) が現在の値を集める。
 */

/** テキストへ出す値一式 */
export interface DebugExportInput {
  connection: ConnectionSettingsSnapshot;
  /** Publisher の統計。配信していないときは null (節ごと出さない) */
  publisher: PublisherStats | null;
  /** Subscriber の統計 */
  subscribers: readonly SubscriberStats[];
  /** コピーするログ (古い順) */
  logs: readonly LogEntry[];
  /** ログを絞り込む文字列。本文に含まれるログだけを出す */
  filter?: string;
}

/**
 * キーごとの追加の表記
 *
 * バイト数は桁が大きく、そのままの数値では読みにくいため、可読な表記を添える。
 */
const KEY_SUFFIXES: Record<string, (value: number) => string> = {
  bytesSent: (value) => ` (${formatBytes(value)})`,
  bytesReceived: (value) => ` (${formatBytes(value)})`,
};

/** 数値を 1 行のテキストにする */
function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  // 統計の数値は ms や dBFS の小数を含む。桁に埋もれないよう小数第 3 位までにする
  return String(Math.round(value * 1000) / 1000);
}

/** 配列の要素を 1 行に収められるか (数値・文字列・真偽値・bigint だけの配列) */
function isFlatArray(value: readonly unknown[]): boolean {
  return value.every(
    (item) =>
      item === null ||
      typeof item === "number" ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      typeof item === "bigint",
  );
}

/**
 * 1 行の JSON にする
 *
 * `JSON.stringify` は bigint で例外になる。Catalog の Media Timeline Template は
 * `[bigint, bigint]` を含むため、文字列へ置き換えてから直列化する。
 * 直列化できない値 (undefined や循環参照) でもコピーが失敗しないよう、その場で
 * 読める文字列にする。
 */
function toJsonText(value: unknown): string {
  try {
    return (
      JSON.stringify(value, (_key, item: unknown) =>
        typeof item === "bigint" ? item.toString() : item,
      ) ?? "-"
    );
  } catch {
    // 循環参照など、JSON にできない値
    return "(unserializable)";
  }
}

/**
 * 値を 1 つの項目として行に分ける
 *
 * オブジェクトは字下げして入れ子のまま出す。配列は要素が単純なら 1 行、
 * オブジェクトを含むなら 1 要素 1 行にする。
 */
function formatEntryLines(key: string, value: unknown, indent: string): string[] {
  if (value === null || value === undefined || value === "") {
    // 値が無いことを "-" で表す。0 と false と空でない文字列は値があるためそのまま出す
    return [`${indent}${key}: -`];
  }

  if (typeof value === "object") {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        return [`${indent}${key}: []`];
      }
      if (isFlatArray(value)) {
        return [`${indent}${key}: ${toJsonText(value)}`];
      }
      const lines = [`${indent}${key}:`];
      for (const item of value) {
        lines.push(`${indent}  - ${toJsonText(item)}`);
      }
      return lines;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return [`${indent}${key}: {}`];
    }
    const lines = [`${indent}${key}:`];
    for (const [childKey, childValue] of entries) {
      lines.push(...formatEntryLines(childKey, childValue, `${indent}  `));
    }
    return lines;
  }

  if (typeof value === "number") {
    const suffix = KEY_SUFFIXES[key]?.(value) ?? "";
    return [`${indent}${key}: ${formatNumber(value)}${suffix}`];
  }

  if (typeof value === "string" || typeof value === "boolean" || typeof value === "bigint") {
    return [`${indent}${key}: ${value}`];
  }

  // 残りは関数やシンボル。スナップショットには現れないが、現れても読める形にする
  return [`${indent}${key}: (${typeof value})`];
}

/**
 * スナップショットを節のテキストへ整形する
 *
 * 出す項目はスナップショットのキーそのものにする。フィールドを足せばこの節にも出る。
 */
export function formatSnapshotSection(title: string, snapshot: object): string {
  const lines = [`=== ${title} ===`];
  for (const [key, value] of Object.entries(snapshot)) {
    lines.push(...formatEntryLines(key, value, ""));
  }
  return lines.join("\n");
}

/**
 * ログ 1 件をテキストにする
 *
 * 行のコピーと一括コピーで同じ整形を使う。時刻は追加時に整形済みのため、
 * ここでは整形し直さない。
 */
export function formatLogEntryText(entry: LogEntry): string {
  const parts: string[] = [`${entry.formattedTimestamp} ${entry.message}`];
  if (entry.data !== undefined) {
    parts.push(formatMessageData(entry.data));
  }
  if (entry.payload !== undefined && entry.payload.length > 0) {
    // hex dump の見出しが data の最終行に繋がらないよう、行を分けて並べる
    parts.push(`Binary (${entry.payload.length} bytes):`, formatHexDump(entry.payload));
  }
  return parts.join("\n");
}

/** ログの節を組み立てる */
export function formatLogsSection(logs: readonly LogEntry[], filter?: string): string {
  const filtered = filter === undefined ? logs : logs.filter((log) => log.message.includes(filter));
  const filterLabel = filter === undefined ? "" : ` (${filter})`;
  return `=== Debug Logs${filterLabel} ===\n${filtered.map((log) => formatLogEntryText(log)).join("\n\n")}`;
}

/** 「Copy for LLM」のテキスト全体を組み立てる */
export function buildDebugExportText(input: DebugExportInput): string {
  const sections: string[] = [formatSnapshotSection("Connection Settings", input.connection)];

  if (input.publisher !== null) {
    sections.push(formatSnapshotSection("Publisher Statistics", input.publisher));
  }

  for (const subscriber of input.subscribers) {
    sections.push(formatSnapshotSection(`Subscriber Statistics (${subscriber.id})`, subscriber));
  }

  sections.push(formatLogsSection(input.logs, input.filter));

  return sections.join("\n\n");
}
