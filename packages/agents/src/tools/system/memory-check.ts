/**
 * Why a memory write looks unsafe, or `null` (memory-hygiene KD-4, pure-decision.md). The patterns are those of
 * bb `unsafeMemoryReason` (`plugins/memory/server.ts`), copied unchanged; only the returned reason is ours. They
 * catch only the forms written in them: an order in Russian or in other words passes, by design.
 */
export function memoryCheckReason(
  value: string,
): 'looks_like_secret' | 'looks_like_instruction' | null {
  if (/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/u.test(value)) {
    return 'looks_like_instruction';
  }
  if (/<\/?\s*(system|developer|assistant|tool)(?:\s|>)/iu.test(value)) {
    return 'looks_like_instruction';
  }
  if (
    /\b(ignore|disregard|override)\b.{0,50}\b(previous|prior|system|developer)\b/isu.test(
      value,
    )
  ) {
    return 'looks_like_instruction';
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(value)) {
    return 'looks_like_secret';
  }
  if (/\b(?:sk-[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{20,})\b/iu.test(value)) {
    return 'looks_like_secret';
  }
  if (/\b[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY)\s*=\s*\S+/u.test(value)) {
    return 'looks_like_secret';
  }
  return null;
}
