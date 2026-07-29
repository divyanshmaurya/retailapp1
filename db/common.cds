namespace smart.retail;

/**
 * Shared key aspect.
 *
 * The fact and AI tables use readable, deterministic keys - `SA-000042`,
 * `HS-WDF01-000123` - rather than the UUIDs `cuid` would give them. Two reasons:
 * the pipeline regenerates these tables from scratch on every run and stable
 * keys keep the output diffable, and `AIInsights.sourceId` points back at a row
 * in a scenario table, which is far easier to follow in a demo when the key
 * says which engine produced it.
 */
aspect recordKey {
  key ID : String(40);
}
