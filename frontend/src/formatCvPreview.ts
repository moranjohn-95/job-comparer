// The observed PDF extraction puts a single-space line between individual words.
// Leave ordinary pasted text alone rather than treating every newline as wrapping.
export function formatCvPreview(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!/(?:^|\n)\S+\n \n\S+\n \n\S+\n \n\S+(?=\n|$)/.test(normalized)) {
    return text;
  }

  const lines: { value: string; gap: string[] }[] = [];
  let gap: string[] = [];
  for (const raw of normalized.split("\n")) {
    if (!raw.trim()) {
      gap.push(raw);
    } else {
      lines.push({ value: raw.trim(), gap });
      gap = [];
    }
  }

  const isWord = (value: string) => /^\S+$/.test(value);
  const isBullet = (value: string) => /^(?:[•●▪◦‣⁃*+-]|\d+[.)])\s/.test(value)
    || /^[•●▪◦‣⁃]$/.test(value);
  const isSpaceLine = (blankLines: string[]) => blankLines.length === 1 && blankLines[0] === " ";
  let result = lines[0].value;

  for (let index = 1; index < lines.length; index++) {
    const current = lines[index];
    const previous = lines[index - 1];
    const extractionGap = isSpaceLine(current.gap);
    const adjacent = current.gap.length === 0 || extractionGap;
    const words = extractionGap && isWord(previous.value) && isWord(current.value);
    // A long extracted line can end mid-sentence just before the word fragments.
    // Short heading lines, complete sentences and real blank lines stay separate.
    const continuation = adjacent && previous.value.split(/\s+/).length >= 8
      && !/[.!?:]$/.test(previous.value) && /^\p{Ll}/u.test(current.value)
      && isWord(current.value) && isSpaceLine(lines[index + 1]?.gap ?? []);
    const bulletText = adjacent && /^[•●▪◦‣⁃]$/.test(previous.value);
    const join = !isBullet(current.value) && (words || continuation || bulletText);
    const separator = join ? (/^[,.;:!?)\]}]+$/.test(current.value) ? "" : " ")
      : current.gap.length ? "\n\n" : "\n";
    result += separator + current.value;
  }
  return result;
}
