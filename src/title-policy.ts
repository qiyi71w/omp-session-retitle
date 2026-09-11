export class RetitleError extends Error {}

export interface TranscriptItem {
  id: string;
  role: "user" | "assistant" | "summary";
  text: string;
}

export interface TitleInput {
  text: string;
  truncated: boolean;
}

const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** No repairs: an invalid answer must never silently become a different title. */
export function validateTitle(raw: string): string | null {
  let title = raw.trim();
  if (title === "none" || /^<title\s*\/>$/u.test(title)) return null;
  const wrapped = /^<title>([^<>]*)<\/title>$/u.exec(title);
  if (wrapped) title = wrapped[1]!.trim();
  if (wrapped && (!title || title === "none")) return null;
  if (!title || UNSAFE.test(title) || [...title].length > 80 || title.includes("`") || /<\/?title\b/u.test(title)) {
    throw new RetitleError("Invalid title: expected one line without control characters, at most 80 Unicode code points.");
  }
  return title;
}


function clip(text: string, length: number): string {
  if (text.length <= length) return text;
  const edge = Math.max(0, Math.floor((length - 13) / 2));
  return `${text.slice(0, edge)}\n[truncated]\n${edge ? text.slice(-edge) : ""}`;
}

/**
 * JSON keeps historical text as data, not instructions. Keep early user goals
 * and later corrections before assistant prose. Limits apply to serialized
 * input too, since quotes/control characters expand during JSON encoding.
 */
export function buildTitleInput(
  items: readonly TranscriptItem[],
  hint: string,
  previousTitle: string,
  maxChars: number,
): TitleInput {
  if (hint.length > 2000) throw new RetitleError("The title hint must not exceed 2000 characters.");
  if (!Number.isInteger(maxChars) || maxChars < 4000) throw new RetitleError("The input budget must be at least 4000 characters.");
  const usable = items.filter(item => item.text.trim());
  if (!usable.length && !hint.trim()) throw new RetitleError("The current branch has no visible text to identify a task.");
  const users = usable.filter(item => item.role === "user");
  const support = usable.filter(item => item.role !== "user");
  // Preserve the first goals and recent corrections; never read sibling paths.
  const selectedUsers = users.length <= 64 ? users : [...users.slice(0, 8), ...users.slice(-56)];
  const selectedSupport = support.slice(-12);
  const selected = new Set([...selectedUsers, ...selectedSupport]);
  let truncated = selected.size < usable.length;
  const userCap = Math.min(4000, Math.max(160, Math.floor(maxChars * 0.65 / Math.max(selectedUsers.length, 1))));
  const supportCap = Math.min(2000, Math.max(100, Math.floor(maxChars * 0.2 / Math.max(selectedSupport.length, 1))));
  const transcript = usable.filter(item => selected.has(item)).map(item => {
    const text = clip(item.text, item.role === "user" ? userCap : supportCap);
    truncated ||= text !== item.text;
    return { id: clip(item.id, 80), role: item.role, text };
  });

  while (true) {
    const text = JSON.stringify({
      previousTitle: clip(previousTitle, 200),
      manualHint: hint,
      truncated,
      omittedMessages: usable.length - transcript.length,
      transcript,
    });
    if (text.length <= maxChars) return { text, truncated };
    truncated = true;
    // Shrink the largest piece without turning the JSON into invalid text.
    const largest = transcript.reduce<TranscriptItem | undefined>((a, b) => !a || b.text.length > a.text.length ? b : a, undefined);
    if (largest && largest.text.length > 100) {
      largest.text = clip(largest.text, Math.max(80, Math.floor(largest.text.length / 2)));
    } else {
      const discard = transcript.findIndex(item => item.role !== "user");
      if (discard >= 0) transcript.splice(discard, 1);
      else if (transcript.length > 2) transcript.splice(1, 1);
      else throw new RetitleError("The input does not fit the budget; shorten the title hint.");
    }
  }
}
