export function extractJsonLoose(text: string): any | null {
  // Try ```json fences first
  const fence = /```json([\s\S]*?)```/i.exec(text);
  const candidate = fence ? fence[1] : null;

  const raw =
    candidate ??
    (() => {
      const first = text.indexOf("{");
      const last = text.lastIndexOf("}");
      if (first !== -1 && last !== -1 && last > first) {
        return text.slice(first, last + 1);
      }
      return null;
    })();

  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // attempt to fix trailing commas
    try {
      return JSON.parse(raw.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]"));
    } catch {
      return null;
    }
  }
}

