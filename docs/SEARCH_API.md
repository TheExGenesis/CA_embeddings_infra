# Embeddings Search API Guide

Complete guide for using the `/embeddings/search` endpoint with advanced Qdrant-style filtering capabilities.

## Table of Contents
- [Endpoint Overview](#endpoint-overview)
- [Request Structure](#request-structure)
- [Filter Structure](#filter-structure)
- [Condition Types](#condition-types)
- [Filter Clauses](#filter-clauses)
- [Datetime Filtering](#datetime-filtering)
- [Examples by Use Case](#examples-by-use-case)
- [Response Format](#response-format)
- [Best Practices](#best-practices)
- [Filter Formats](#filter-formats)

---

## Endpoint Overview

**URL:** `POST /embeddings/search`

**Description:** Performs semantic search over your embeddings using either:
- A search term (text) that gets automatically converted to an embedding
- A direct vector for similarity search

**Authentication:** Not required for search endpoint

---

## Request Structure

### Basic Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `searchTerm` | string | Yes* | - | Text to search for (alternative to `vector`) |
| `vector` | number[] | Yes* | - | Vector to search with (alternative to `searchTerm`) |
| `k` | number | No | 10 | Number of results to return (1-1000) |
| `threshold` | number | No | 0.65 | Similarity threshold (0.0-1.0) |
| `filter` | object | No | - | Advanced filter with must/should/must_not clauses |
| `with_vector` | boolean | No | false | Include original embedding vectors in results |
| `with_payload` | boolean | No | true | Include metadata in results |

*Either `searchTerm` OR `vector` must be provided, but not both.

### Minimal Request Example

```json
{
  "searchTerm": "TPOT"
}
```

---

## Filter Structure

The `filter` object uses Qdrant-style clauses for powerful filtering capabilities:

```json
{
  "filter": {
    "must": [...],      // AND - all conditions must match
    "should": [...],    // OR - at least one condition must match
    "must_not": [...]   // NOT - none of the conditions must match
  }
}
```

### Key Concepts

1. **Clauses** (`must`, `should`, `must_not`) contain arrays of conditions
2. **Conditions** can be either:
   - **Field conditions** with `key` + `match` or `range`
   - **Nested filter clauses** for complex logic
3. Clauses can be combined and recursively nested

---

## Condition Types

### 1. Match Conditions

For exact value or text matching.

#### Exact Value Match

Use `match.value` for exact matching on strings, numbers, or booleans:

```json
{
  "filter": {
    "must": [
      { "key": "provider", "match": { "value": "deepinfra" } },
      { "key": "has_quotes", "match": { "value": true } },
      { "key": "tokens", "match": { "value": 50 } }
    ]
  }
}
```

#### Text Substring Match

Use `match.text` for full-text substring matching (case-insensitive):

```json
{
  "filter": {
    "must": [
      { "key": "text", "match": { "text": "neural network" } }
    ]
  }
}
```

This matches any embedding where `metadata.text` contains "neural network" as a substring.

> **Note: Automatic Text Cleaning**  
> Filter text values are automatically cleaned using the same transformation applied to tweets before embedding. This includes:
> - Removing URLs (`https://...`)
> - Normalizing whitespace
> - Removing leading @mentions (only at the start of text)
> - Normalizing unicode quotes
>
> This ensures your filter text matches against the stored processed text. For example:
> - `"check this https://t.co/abc"` → `"check this"`
> - `"@user @other hello world"` → `"hello world"`
> - `"hello @user world"` → `"hello @user world"` (mention kept, not at start)

---

### 2. Range Conditions

For numeric comparisons using `range` with operators:

| Operator | Description |
|----------|-------------|
| `gt` | Greater than |
| `gte` | Greater than or equal |
| `lt` | Less than |
| `lte` | Less than or equal |

#### Single Bound

```json
{
  "filter": {
    "must": [
      { "key": "tokens", "range": { "gt": 50 } }
    ]
  }
}
```

#### Range (Between)

```json
{
  "filter": {
    "must": [
      { "key": "tokens", "range": { "gte": 20, "lte": 100 } }
    ]
  }
}
```

---

## Filter Clauses

### Must (AND Logic)

All conditions must match. Use for required criteria:

```json
{
  "searchTerm": "machine learning",
  "filter": {
    "must": [
      { "key": "provider", "match": { "value": "deepinfra" } },
      { "key": "tokens", "range": { "gte": 50 } },
      { "key": "is_truncated", "match": { "value": false } }
    ]
  }
}
```

### Should (OR Logic)

At least one condition must match. Use for alternatives:

```json
{
  "searchTerm": "embeddings",
  "filter": {
    "should": [
      { "key": "provider", "match": { "value": "deepinfra" } },
      { "key": "provider", "match": { "value": "openai" } },
      { "key": "provider", "match": { "value": "local" } }
    ]
  }
}
```

### Must Not (NOT Logic)

None of the conditions must match. Use for exclusions:

```json
{
  "searchTerm": "technical content",
  "filter": {
    "must_not": [
      { "key": "is_truncated", "match": { "value": true } },
      { "key": "has_quotes", "match": { "value": true } }
    ]
  }
}
```

### Combining Clauses

Combine multiple clauses in a single filter:

```json
{
  "searchTerm": "optimization",
  "filter": {
    "must": [
      { "key": "source", "match": { "value": "parquet_import" } },
      { "key": "tokens", "range": { "gte": 50, "lte": 200 } }
    ],
    "should": [
      { "key": "provider", "match": { "value": "deepinfra" } },
      { "key": "provider", "match": { "value": "openai" } }
    ],
    "must_not": [
      { "key": "is_truncated", "match": { "value": true } }
    ]
  }
}
```

### Nested Clauses

Create complex logic by nesting clauses within clauses:

```json
{
  "searchTerm": "data science",
  "filter": {
    "must": [
      { "key": "source", "match": { "value": "parquet_import" } }
    ],
    "should": [
      {
        "must": [
          { "key": "provider", "match": { "value": "deepinfra" } },
          { "key": "tokens", "range": { "gt": 50 } }
        ]
      },
      {
        "must": [
          { "key": "provider", "match": { "value": "openai" } },
          { "key": "tokens", "range": { "gt": 100 } }
        ]
      }
    ]
  }
}
```

This matches: source is "parquet_import" AND (deepinfra with >50 tokens OR openai with >100 tokens).

---

## Datetime Filtering

Range conditions support datetime values in two formats:

### ISO 8601 Strings

```json
{
  "filter": {
    "must": [
      {
        "key": "created_at",
        "range": {
          "gte": "2024-01-01T00:00:00Z",
          "lt": "2024-12-31T23:59:59Z"
        }
      }
    ]
  }
}
```

### Unix Timestamps (Milliseconds)

```json
{
  "filter": {
    "must": [
      {
        "key": "timestamp",
        "range": {
          "gte": 1704067200000,
          "lt": 1735689599000
        }
      }
    ]
  }
}
```

### Mixed Formats

You can mix formats in the same range:

```json
{
  "filter": {
    "must": [
      {
        "key": "created_at",
        "range": {
          "gte": "2024-01-01T00:00:00Z",
          "lt": 1735689599000
        }
      }
    ]
  }
}
```

---

## Examples by Use Case

> **Note:** Examples show both legacy flat format and new clause-based format where applicable. Both formats are fully supported.

### Use Case 1: Basic Text Search

Find embeddings semantically similar to a query.

```json
{
  "searchTerm": "artificial intelligence",
  "k": 5
}
```

### Use Case 2: Text Search with Substring Filter

Find embeddings similar to "machine learning" that contain "neural" in their text.

**Legacy format:**
```json
{
  "searchTerm": "machine learning",
  "k": 10,
  "filter": {
    "text": "neural"
  }
}
```

**New format:**
```json
{
  "searchTerm": "machine learning",
  "k": 10,
  "filter": {
    "must": [
      { "key": "text", "match": { "text": "neural" } }
    ]
  }
}
```

### Use Case 3: TPOT-style Substring Search

Find embeddings semantically similar to a phrase that also contain specific text.

```json
{
  "searchTerm": "you can just do stuff",
  "threshold": 0.5,
  "filter": {
    "must": [
      { "key": "text", "match": { "text": "tpot" } }
    ]
  }
}
```

### Use Case 4: Filter by Exact Text Match

Find embeddings with specific text content using substring matching.

```json
{
  "searchTerm": "lifeless",
  "filter": {
    "must": [
      { "key": "text", "match": { "text": "the end comes, this lifeless singsong of futility" } }
    ]
  }
}
```

### Use Case 5: Filter by Provider and Model

Find embeddings from a specific provider and model combination.

**Legacy format:**
```json
{
  "searchTerm": "embeddings",
  "filter": {
    "provider": "deepinfra",
    "model": "Qwen/Qwen3-Embedding-4B",
    "source": "parquet_import"
  }
}
```

**New format:**
```json
{
  "searchTerm": "embeddings",
  "filter": {
    "must": [
      { "key": "provider", "match": { "value": "deepinfra" } },
      { "key": "model", "match": { "value": "Qwen/Qwen3-Embedding-4B" } },
      { "key": "source", "match": { "value": "parquet_import" } }
    ]
  }
}
```

### Use Case 6: Token Count Range

Find embeddings with token count between 20 and 100.

**Legacy format:**
```json
{
  "searchTerm": "data analysis",
  "k": 20,
  "filter": {
    "tokens": ">=20 & <=100"
  }
}
```

**New format:**
```json
{
  "searchTerm": "data analysis",
  "k": 20,
  "filter": {
    "must": [
      { "key": "tokens", "range": { "gte": 20, "lte": 100 } }
    ]
  }
}
```

### Use Case 7: Find Long Documents from Specific Provider

Find longer content (>50 tokens) from a specific provider.

**Legacy format:**
```json
{
  "searchTerm": "guide",
  "k": 15,
  "threshold": 0.50,
  "filter": {
    "tokens": ">50",
    "provider": "deepinfra"
  }
}
```

**New format:**
```json
{
  "searchTerm": "guide",
  "k": 15,
  "threshold": 0.50,
  "filter": {
    "must": [
      { "key": "tokens", "range": { "gt": 50 } },
      { "key": "provider", "match": { "value": "deepinfra" } }
    ]
  }
}
```

### Use Case 8: Find Short, Untruncated Messages

Find short messages that haven't been truncated and don't contain quotes.

**Legacy format:**
```json
{
  "searchTerm": "quick update",
  "filter": {
    "tokens": "<30",
    "is_truncated": false,
    "has_quotes": false
  }
}
```

**New format:**
```json
{
  "searchTerm": "quick update",
  "filter": {
    "must": [
      { "key": "tokens", "range": { "lt": 30 } },
      { "key": "is_truncated", "match": { "value": false } },
      { "key": "has_quotes", "match": { "value": false } }
    ]
  }
}
```

### Use Case 9: Multiple Providers (OR Logic)

Find embeddings from any of multiple providers.

```json
{
  "searchTerm": "technical content",
  "filter": {
    "should": [
      { "key": "provider", "match": { "value": "deepinfra" } },
      { "key": "provider", "match": { "value": "openai" } },
      { "key": "provider", "match": { "value": "local" } }
    ]
  }
}
```

### Use Case 10: Exclude Unwanted Results

Find results excluding truncated content and quoted text.

```json
{
  "searchTerm": "complete guide",
  "filter": {
    "must_not": [
      { "key": "is_truncated", "match": { "value": true } },
      { "key": "has_quotes", "match": { "value": true } }
    ]
  }
}
```

### Use Case 11: High Similarity Threshold

Find only very similar results with strict matching.

```json
{
  "searchTerm": "exact match needed",
  "k": 5,
  "threshold": 0.95,
  "filter": {
    "must": [
      { "key": "provider", "match": { "value": "deepinfra" } }
    ]
  }
}
```

### Use Case 12: Find All Embeddings from a Source

Use a broad search term with specific source filters.

```json
{
  "searchTerm": "content",
  "k": 100,
  "threshold": 0.5,
  "filter": {
    "must": [
      { "key": "source", "match": { "value": "parquet_import" } },
      { "key": "has_context", "match": { "value": false } }
    ]
  }
}
```

### Use Case 13: Complex Multi-Clause Query

Combine multiple clauses for precise results.

```json
{
  "searchTerm": "technical",
  "k": 25,
  "threshold": 0.5,
  "filter": {
    "must": [
      { "key": "source", "match": { "value": "parquet_import" } },
      { "key": "tokens", "range": { "gte": 50, "lte": 200 } }
    ],
    "should": [
      { "key": "text", "match": { "text": "optimization" } },
      { "key": "text", "match": { "text": "performance" } }
    ],
    "must_not": [
      { "key": "is_truncated", "match": { "value": true } }
    ]
  }
}
```

### Use Case 14: Search with Direct Vector

If you already have a vector, use it directly instead of `searchTerm`.

```json
{
  "vector": [0.123, -0.456, 0.789, ...],
  "k": 10,
  "threshold": 0.8,
  "filter": {
    "must": [
      { "key": "tokens", "range": { "gt": 10 } }
    ]
  }
}
```

### Use Case 15: Retrieve Original Vectors

Include the original embedding vectors in search results for further processing or analysis.

```json
{
  "searchTerm": "machine learning",
  "k": 5,
  "with_vector": true
}
```

**Response:**
```json
{
  "success": true,
  "results": [
    {
      "key": "1234567890",
      "distance": 0.923,
      "metadata": { "text": "..." },
      "vector": [0.0123, -0.0456, 0.0789, ...]
    }
  ],
  "count": 5
}
```

### Use Case 16: Search Without Metadata

For performance optimization, exclude metadata when you only need keys and distances.

```json
{
  "searchTerm": "neural networks",
  "k": 100,
  "with_payload": false
}
```

**Response:**
```json
{
  "success": true,
  "results": [
    { "key": "1234567890", "distance": 0.923 },
    { "key": "0987654321", "distance": 0.891 }
  ],
  "count": 100
}
```

### Use Case 17: Date Range Filter

Find embeddings created within a date range.

```json
{
  "searchTerm": "recent updates",
  "filter": {
    "must": [
      {
        "key": "created_at",
        "range": {
          "gte": "2024-06-01T00:00:00Z",
          "lt": "2024-07-01T00:00:00Z"
        }
      }
    ]
  }
}
```

### Use Case 18: Deeply Nested Logic

Complex nested conditions for advanced queries. This example matches:
- Source is "parquet_import" AND either:
  - (deepinfra provider with specific model) OR
  - (openai provider with >=100 tokens and not truncated)

```json
{
  "searchTerm": "content",
  "filter": {
    "must": [
      { "key": "source", "match": { "value": "parquet_import" } }
    ],
    "should": [
      {
        "must": [
          { "key": "provider", "match": { "value": "deepinfra" } },
          { "key": "model", "match": { "value": "Qwen/Qwen3-Embedding-4B" } }
        ]
      },
      {
        "must": [
          { "key": "provider", "match": { "value": "openai" } },
          { "key": "tokens", "range": { "gte": 100 } }
        ],
        "must_not": [
          { "key": "is_truncated", "match": { "value": true } }
        ]
      }
    ]
  }
}
```

---

## Response Format

### Success Response

```json
{
  "success": true,
  "results": [
    {
      "key": "1234567890",
      "distance": 0.923,
      "metadata": {
        "source": "parquet_import",
        "original_text": "Sample text content here",
        "has_context": false,
        "has_quotes": false,
        "is_truncated": false,
        "character_difference": 0,
        "text": "Sample text content here",
        "provider": "deepinfra",
        "model": "Qwen/Qwen3-Embedding-4B",
        "tokens": 35
      }
    }
  ],
  "count": 10
}
```

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Whether the search succeeded |
| `results` | array | Array of search results |
| `results[].key` | string | Unique identifier for the embedding |
| `results[].distance` | number | Similarity score (0-1, higher is more similar) |
| `results[].metadata` | object | All metadata associated with the embedding (when `with_payload: true`) |
| `results[].vector` | number[] | Original embedding vector (only when `with_vector: true`) |
| `count` | number | Number of results returned |

### Error Response

```json
{
  "success": false,
  "error": "Error message describing what went wrong"
}
```

---

## Best Practices

### 1. Use Appropriate k Values

- **Exploratory searches:** `k: 20-50`
- **Precise matches:** `k: 5-10`
- **Batch processing:** `k: 100-500`

### 2. Set Meaningful Thresholds

- **High precision needed:** `threshold: 0.85-0.95`
- **Balanced results:** `threshold: 0.70-0.80` (default: 0.65)
- **Broad search:** `threshold: 0.50-0.65`

### 3. Choose the Right Clause

- Use `must` for required criteria (AND logic)
- Use `should` for alternatives (OR logic)
- Use `must_not` for exclusions (NOT logic)

### 4. Avoid Over-Filtering

Don't over-filter! Start broad and narrow down:

**Good: Start with one or two conditions**

```json
{
  "searchTerm": "query",
  "filter": {
    "must": [
      { "key": "tokens", "range": { "gt": 20 } },
      { "key": "provider", "match": { "value": "deepinfra" } }
    ]
  }
}
```

**May be too restrictive:**

```json
{
  "searchTerm": "query",
  "filter": {
    "must": [
      { "key": "tokens", "range": { "gt": 20, "lt": 25 } },
      { "key": "provider", "match": { "value": "deepinfra" } },
      { "key": "model", "match": { "value": "specific-model" } },
      { "key": "has_quotes", "match": { "value": false } },
      { "key": "has_context", "match": { "value": true } },
      { "key": "is_truncated", "match": { "value": false } }
    ]
  }
}
```

### 5. Use Text Match for Substrings

For partial text matching, use `match.text`:

```json
{ "key": "text", "match": { "text": "neural network" } }
```

For exact value matching, use `match.value`:

```json
{ "key": "source", "match": { "value": "parquet_import" } }
```

### 6. Performance Tips

- **Index common fields:** The following fields are automatically indexed: `text`, `original_text`, `source`, `provider`, `model`
- **Combine conditions efficiently:** Use `should` for OR operations rather than separate queries
- **Limit results:** Don't request more than you need

### 7. Testing Filters

Test your filters incrementally:

1. Start without filters
2. Add one condition at a time
3. Check result counts
4. Adjust threshold if needed
5. Add more conditions or clauses as needed

Example incremental testing:

```json
// Step 1: No filter
{ "searchTerm": "query" }

// Step 2: Add one must condition
{ "searchTerm": "query", "filter": { "must": [{ "key": "provider", "match": { "value": "deepinfra" } }] } }

// Step 3: Add token range
{ "searchTerm": "query", "filter": { "must": [{ "key": "provider", "match": { "value": "deepinfra" } }, { "key": "tokens", "range": { "gt": 20 } }] } }
```

---

## Common Metadata Fields

| Field | Type | Description | Recommended Condition |
|-------|------|-------------|----------------------|
| `text` | string | The main text content | `match.text` (substring) |
| `original_text` | string | Original unmodified text | `match.text` (substring) |
| `source` | string | Data source identifier | `match.value` (exact) |
| `provider` | string | Embedding provider | `match.value` (exact) |
| `model` | string | Model used for embedding | `match.value` (exact) |
| `tokens` | number | Token count | `range` |
| `has_context` | boolean | Whether context is included | `match.value` (exact) |
| `has_quotes` | boolean | Whether text contains quotes | `match.value` (exact) |
| `is_truncated` | boolean | Whether text was truncated | `match.value` (exact) |
| `character_difference` | number | Char count difference | `range` |
| `account_id` | string | Twitter user ID | `match.value` (exact) |
| `username` | string | Twitter username | `match.value` (exact) or `match.text` |
| `account_display_name` | string | Twitter display name | `match.text` (substring) |
| `created_at` | string | Tweet creation timestamp | `range` (datetime) |
| `retweet_count` | number | Number of retweets | `range` |
| `favorite_count` | number | Number of favorites/likes | `range` |
| `reply_to_tweet_id` | string | ID of tweet being replied to | `match.value` (exact) |
| `reply_to_user_id` | string | User ID being replied to | `match.value` (exact) |
| `reply_to_username` | string | Username being replied to | `match.value` (exact) |
| `quoted_tweet_id` | string | ID of quoted tweet | `match.value` (exact) |
| `conversation_id` | string | Conversation thread ID | `match.value` (exact) |

---

## Troubleshooting

### No Results Returned

1. **Check your threshold:** Lower it to see if you get results
2. **Remove filters:** Test without filters first
3. **Verify field names:** Ensure filter keys match your metadata structure
4. **Check clause logic:** Ensure `should` clauses have at least one matching condition

### Filter Validation Errors

1. **Check condition structure:** Each condition must have `key` and either `match` or `range`
2. **Verify match type:** Use `match.value` for exact or `match.text` for substring
3. **Validate range operators:** Use `gt`, `gte`, `lt`, `lte` (not string operators like ">")

### Unexpected Results

1. **Review clause logic:** `must` = AND, `should` = OR, `must_not` = NOT
2. **Check nesting:** Ensure nested clauses are properly structured
3. **Verify data types:** Match boolean with boolean, number with number

---

## Filter Formats

This API supports **two filter formats**. The system automatically detects which format you're using based on whether the filter object contains `must`, `should`, or `must_not` keys.

### Legacy Format (Still Supported)

The simple flat key-value format for basic filtering:

```json
{
  "filter": {
    "tokens": ">50",
    "provider": "deepinfra",
    "is_truncated": false
  }
}
```

**Legacy format features:**
- String values use substring matching (case-insensitive)
- Non-string values (numbers, booleans) use exact matching
- Range operators: `">10"`, `">=10"`, `"<50"`, `"<=50"`, `">10 & <50"`
- All conditions are combined with AND logic

### New Clause-Based Format (Recommended)

The advanced format with `must`, `should`, and `must_not` clauses:

```json
{
  "filter": {
    "must": [
      { "key": "tokens", "range": { "gt": 50 } },
      { "key": "provider", "match": { "value": "deepinfra" } }
    ]
  }
}
```

**New format features:**
- AND logic with `must`
- OR logic with `should`
- NOT logic with `must_not`
- Recursive nesting for complex queries
- Datetime filtering with ISO 8601 or Unix timestamps
- Explicit control over match type (`match.value` vs `match.text`)

### When to Use Each Format

| Use Case | Recommended Format |
|----------|-------------------|
| Simple AND conditions | Legacy (simpler syntax) |
| OR conditions needed | New format (use `should`) |
| Exclusions needed | New format (use `must_not`) |
| Complex nested logic | New format |
| Datetime filtering | New format |
| Quick prototyping | Legacy (less verbose) |

### Format Comparison

| Legacy Syntax | New Syntax |
|---------------|------------|
| `"field": "value"` | `{ "key": "field", "match": { "text": "value" } }` |
| `"field": true` | `{ "key": "field", "match": { "value": true } }` |
| `"field": 50` | `{ "key": "field", "match": { "value": 50 } }` |
| `"field": ">50"` | `{ "key": "field", "range": { "gt": 50 } }` |
| `"field": ">=50"` | `{ "key": "field", "range": { "gte": 50 } }` |
| `"field": "<50"` | `{ "key": "field", "range": { "lt": 50 } }` |
| `"field": "<=50"` | `{ "key": "field", "range": { "lte": 50 } }` |
| `"field": ">10 & <50"` | `{ "key": "field", "range": { "gt": 10, "lt": 50 } }` |

---

## Postman Collection Example

**Method:** POST  
**URL:** `http://localhost:3000/embeddings/search`  
**Headers:**
```
Content-Type: application/json
```

**Body (raw JSON):**
```json
{
  "searchTerm": "machine learning optimization",
  "k": 20,
  "threshold": 0.7,
  "filter": {
    "must": [
      { "key": "tokens", "range": { "gte": 50, "lte": 150 } },
      { "key": "provider", "match": { "value": "deepinfra" } }
    ],
    "must_not": [
      { "key": "is_truncated", "match": { "value": true } }
    ]
  }
}
```

---

## Need Help?

- Check server logs for detailed error messages
- Verify your server is running: `GET /health`
- Check database stats: `GET /embeddings/stats`
- Review the main README.md for setup instructions

For more information about other API endpoints, see the main [README.md](../README.md).
