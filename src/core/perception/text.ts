// 1.4.0: the untrusted-text helpers moved to src/shared/text.ts, so the platform-agnostic profile
// format (src/shared/profileTransfer.ts) can clean imported cat names without depending on core.
// Re-exported here so existing imports (the AI adapters, tests) keep working unchanged.
export * from '../../shared/text';
