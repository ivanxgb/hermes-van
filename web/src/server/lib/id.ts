/**
 * ULID helper. Lexicographically sortable, time-ordered, 26 chars.
 * https://github.com/ulid/spec
 */
import { ulid as _ulid } from "ulid";

export function ulid(): string {
  return _ulid();
}
