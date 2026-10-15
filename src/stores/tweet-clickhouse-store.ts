import type { DatabaseConfig } from '../types/index.js';

export type RetrievedPayload = {
  id: string;
  key: string;
  metadata: Record<string, unknown>;
};

type ClickHouseRow = Record<string, unknown>;

const NUMERIC_KEY = /^\d+$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function numericKey(key: string): string {
  if (!NUMERIC_KEY.test(key)) throw new Error(`Tweet keys must be unsigned integer strings; received ${key}`);
  return key;
}

function identifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`Invalid ClickHouse database identifier: ${value}`);
  return value;
}

function stringLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export type AuthorScope = { key: 'username' | 'account_id'; value: string };

// Short enough that an opt-out reaching the membership projection takes
// effect within a minute; long enough that searches stop rescanning it.
const MEMBER_CACHE_MS = 30_000;
const AUTHOR_CACHE_MS = 60_000;
const AUTHOR_CACHE_ENTRIES = 32;

type Cached<T> = { expires: number; value: Promise<T> };

function nullableString(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  return String(value);
}

export class TweetClickHouseStore {
  private readonly url: string;
  private readonly user: string;
  private readonly password?: string;
  private readonly database: string;
  private readonly timeout: number;
  private readonly batchSize: number;
  private members?: Cached<string>;
  private readonly authors = new Map<string, Cached<string[]>>();

  constructor(config: DatabaseConfig) {
    if (!config.tweetClickhouse) throw new Error('Canonical tweet ClickHouse configuration is required for LanceDB');
    this.url = new URL(config.tweetClickhouse.url).toString();
    this.user = config.tweetClickhouse.user;
    this.password = config.tweetClickhouse.password;
    this.database = identifier(config.tweetClickhouse.database);
    this.timeout = config.tweetClickhouse.timeout ?? 30_000;
    this.batchSize = Math.max(1, Math.min(500, Math.floor(config.tweetClickhouse.hydrationBatchSize)));
  }

  private async rows(sql: string): Promise<ClickHouseRow[]> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'X-ClickHouse-User': this.user,
        ...(this.password ? { 'X-ClickHouse-Key': this.password } : {}),
        'content-type': 'text/plain; charset=utf-8',
      },
      body: `${sql.trim()}\nFORMAT JSONEachRow`,
      signal: AbortSignal.timeout(this.timeout),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Canonical ClickHouse HTTP ${response.status}: ${body.slice(0, 500)}`);
    return body.split('\n').filter(Boolean).map(line => JSON.parse(line) as ClickHouseRow);
  }

  async initialize(): Promise<void> {
    await this.rows(`SELECT 1 AS ok FROM system.databases WHERE name = '${this.database}' LIMIT 1`);
  }

  /** Comma-separated account IDs of current members who have not opted out. */
  private memberAccountIds(): Promise<string> {
    const now = Date.now();
    if (!this.members || this.members.expires <= now) {
      const value = this.rows(`
        SELECT DISTINCT toString(account_id) AS account_id
        FROM ${this.database}.community_membership_by_account_current
        WHERE is_member = 1 AND explicit_optout = 0
      `).then(rows => rows.map(row => numericKey(String(row.account_id))).join(','));
      this.members = { expires: now + MEMBER_CACHE_MS, value };
      value.catch(() => { if (this.members?.value === value) this.members = undefined; });
    }
    return this.members.value;
  }

  private async retrieveBatch(ids: string[], members: string, withText: boolean): Promise<RetrievedPayload[]> {
    const joinedIds = ids.map(numericKey).join(',');
    // Text and reply columns are most of each lookup's decompression work;
    // the policy gate needs only the account and tombstone.
    const textColumns = withText ? `
        argMax(t.full_text, tuple(t.observed_at, t.source, t.event_id)) AS full_text,
        toString(argMax(t.reply_to_tweet_id, tuple(t.observed_at, t.source, t.event_id))) AS reply_to_tweet_id,
        toString(argMax(t.reply_to_user_id, tuple(t.observed_at, t.source, t.event_id))) AS reply_to_user_id,
        argMax(t.reply_to_username, tuple(t.observed_at, t.source, t.event_id)) AS reply_to_username,` : '';
    const tweets = await this.rows(`
      SELECT
        toString(t.tweet_id) AS id,
        toString(argMax(t.account_id, tuple(t.observed_at, t.source, t.event_id))) AS account_id,
        toString(argMax(t.created_at, tuple(t.observed_at, t.source, t.event_id))) AS created_at,${textColumns}
        argMax(t.is_tombstone, tuple(t.observed_at, t.source, t.event_id)) AS is_tombstone
      FROM ${this.database}.tweet_content_versions AS t
      WHERE t.tweet_id IN (${joinedIds})
        AND t.account_id IN (${members})
      GROUP BY t.tweet_id
      HAVING is_tombstone = 0
    `);
    if (!tweets.length) return [];

    const accountIds = [...new Set(tweets.map(row => String(row.account_id)).filter(NUMERIC_KEY.test.bind(NUMERIC_KEY)))];
    const accounts = accountIds.length ? await this.rows(`
        SELECT
          toString(account_id) AS account_id,
          if(argMaxMerge(writer_tombstone_state) = 1, '', argMaxMerge(username_state)) AS username,
          if(argMaxMerge(writer_tombstone_state) = 1, '', argMaxMerge(account_display_name_state)) AS account_display_name
        FROM ${this.database}.account_identity_states
        WHERE account_id IN (${accountIds.join(',')})
        GROUP BY account_id
      `) : [];
    const accountsById = new Map(accounts.map(row => [String(row.account_id), row]));

    return tweets.map(row => {
      const id = String(row.id);
      const account = accountsById.get(String(row.account_id));
      const metadata: Record<string, unknown> = {
        account_id: String(row.account_id),
        created_at: String(row.created_at),
        ...(withText ? { text: String(row.full_text ?? ''), original_text: String(row.full_text ?? '') } : {}),
        source: 'clickhouse',
        provider: 'deepinfra',
        model: 'Qwen/Qwen3-Embedding-4B',
      };
      const optional = {
        reply_to_tweet_id: nullableString(row.reply_to_tweet_id),
        reply_to_user_id: nullableString(row.reply_to_user_id),
        reply_to_username: nullableString(row.reply_to_username),
        username: nullableString(account?.username),
        account_display_name: nullableString(account?.account_display_name),
      };
      for (const [key, value] of Object.entries(optional)) if (value !== undefined) metadata[key] = value;
      return { id, key: id, metadata };
    });
  }

  /** Policy-gated payloads; `withText: false` omits text and reply fields. */
  async retrievePayloads(ids: string[], { withText = true }: { withText?: boolean } = {}): Promise<RetrievedPayload[]> {
    const unique = [...new Set(ids.map(numericKey))];
    const batches: string[][] = [];
    for (let offset = 0; offset < unique.length; offset += this.batchSize) {
      batches.push(unique.slice(offset, offset + this.batchSize));
    }
    if (!batches.length) return [];
    const members = await this.memberAccountIds();
    if (!members) return [];
    const results = await Promise.all(batches.map(batch => this.retrieveBatch(batch, members, withText)));
    return results.flat();
  }

  /** Tweet IDs of one current, non-opted-out member, or [] when the author is not one. */
  authorTweetIds(author: AuthorScope): Promise<string[]> {
    const key = `${author.key}:${author.key === 'username' ? author.value.toLowerCase() : author.value}`;
    const now = Date.now();
    const cached = this.authors.get(key);
    if (cached && cached.expires > now) return cached.value;
    const member = author.key === 'account_id'
      ? `account_id = ${numericKey(author.value)}`
      : `username_lower = lower(${stringLiteral(author.value)})`;
    const value = this.rows(`
      SELECT DISTINCT toString(tweet_id) AS id
      FROM ${this.database}.tweet_content_versions
      WHERE account_id IN (
        SELECT account_id
        FROM ${this.database}.community_membership_by_account_current
        WHERE ${member} AND is_member = 1 AND explicit_optout = 0
      )
    `).then(rows => rows.map(row => String(row.id)));
    this.authors.delete(key);
    this.authors.set(key, { expires: now + AUTHOR_CACHE_MS, value });
    value.catch(() => { if (this.authors.get(key)?.value === value) this.authors.delete(key); });
    for (const oldest of this.authors.keys()) {
      if (this.authors.size <= AUTHOR_CACHE_ENTRIES) break;
      this.authors.delete(oldest);
    }
    return value;
  }

  async close(): Promise<void> {}
}
