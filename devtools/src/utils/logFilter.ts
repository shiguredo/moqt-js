import type { LogEntry, LogLevel } from "../signals/debugLog";

/**
 * デバッグパネルの絞り込み
 *
 * 検索欄・重要度・接続元から条件を組み立て、表示に使うログだけを残す。
 * 保持しているログ (`signals/debugLog.ts`) は変えない。
 */

/** 重要度の選択肢。表示順を固定する */
export const LOG_LEVEL_OPTIONS: readonly LogLevel[] = ["info", "warn", "error", "debug"];

/** 既定で表示する重要度 (すべて) */
export function createDefaultLogLevels(): ReadonlySet<LogLevel> {
  return new Set(LOG_LEVEL_OPTIONS);
}

/** ログの絞り込み条件 */
export interface LogFilter {
  /** 小文字化済みの検索語。空文字列なら本文で絞らない */
  readonly query: string;
  /** 表示する重要度 */
  readonly levels: ReadonlySet<LogLevel>;
  /** 接続元 (`publisher` / `subscriber-...`)。null なら接続元で絞らない */
  readonly source: string | null;
}

/** 検索欄の入力を検索語へ正規化する (前後の空白を落とし、小文字にする) */
export function normalizeLogQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** 絞り込み条件を組み立てる。検索語はここで正規化する */
export function createLogFilter(
  query: string,
  levels: ReadonlySet<LogLevel>,
  source: string | null,
): LogFilter {
  return {
    query: normalizeLogQuery(query),
    levels,
    source,
  };
}

/** ログ 1 件が条件に一致するか */
export function matchesLogFilter(entry: LogEntry, filter: LogFilter): boolean {
  if (!filter.levels.has(entry.level)) {
    return false;
  }
  if (filter.source !== null && entry.source !== filter.source) {
    return false;
  }
  return filter.query === "" || entry.searchText.includes(filter.query);
}

/**
 * 条件に一致するログだけを残す
 *
 * 1 件も落とさないときは渡された配列をそのまま返す。呼び出し側が
 * 「絞り込みで表示が変わったか」を参照の比較で判定できるようにする。
 */
export function filterLogEntries(
  entries: readonly LogEntry[],
  filter: LogFilter,
): readonly LogEntry[] {
  const filtered = entries.filter((entry) => matchesLogFilter(entry, filter));
  return filtered.length === entries.length ? entries : filtered;
}

/** 条件に一致するログの件数 */
export function countMatchingLogEntries(entries: readonly LogEntry[], filter: LogFilter): number {
  let count = 0;
  for (const entry of entries) {
    if (matchesLogFilter(entry, filter)) {
      count += 1;
    }
  }
  return count;
}

/** 既定の条件から変更されているか (絞り込みの表示を出すかの判定) */
export function isLogFilterActive(filter: LogFilter): boolean {
  return (
    filter.query !== "" || filter.source !== null || filter.levels.size !== LOG_LEVEL_OPTIONS.length
  );
}
