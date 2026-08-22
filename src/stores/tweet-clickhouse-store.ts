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

  private async retrieveBatch(ids: string[]): Promise<RetrievedPayload[]> {
    const joinedIds = ids.map(numericKey).join(',');
    const tweets = await this.rows(`
      SELECT
        toString(t.tweet_id) AS id,
        toString(argMax(t.account_id, tuple(t.observed_at, t.source, t.event_id))) AS account_id,
        toString(argMax(t.created_at, tuple(t.observed_at, t.source, t.event_id))) AS created_at,
        argMax(t.full_text, tuple(t.observed_at, t.source, t.event_id)) AS full_text,
        toString(argMax(t.reply_to_tweet_id, tuple(t.observed_at, t.source, t.event_id))) AS reply_to_tweet_id,
        toString(argMax(t.reply_to_user_id, tuple(t.observed_at, t.source, t.event_id))) AS reply_to_user_id,
        argMax(t.reply_to_username, tuple(t.observed_at, t.source, t.event_id)) AS reply_to_username,
        argMax(t.is_tombstone, tuple(t.observed_at, t.source, t.event_id)) AS is_tombstone
      FROM ${this.database}.tweet_content_versions AS t
      INNER JOIN ${this.database}.community_membership_by_account_current AS membership
        ON membership.account_id = t.account_id
      WHERE t.tweet_id IN (${joinedIds})
        AND membership.is_member = 1
        AND membership.explicit_optout = 0
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
      const text = String(row.full_text ?? '');
      const metadata: Record<string, unknown> = {
        account_id: String(row.account_id),
        created_at: String(row.created_at),
        text,
        original_text: text,
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

  async retrievePayloads(ids: string[]): Promise<RetrievedPayload[]> {
    const unique = [...new Set(ids.map(numericKey))];
    const batches: string[][] = [];
    for (let offset = 0; offset < unique.length; offset += this.batchSize) {
      batches.push(unique.slice(offset, offset + this.batchSize));
    }
    const results = await Promise.all(batches.map(batch => this.retrieveBatch(batch)));
    return results.flat();
  }

  async close(): Promise<void> {}
}
